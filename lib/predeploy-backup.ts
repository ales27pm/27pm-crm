export const PREDEPLOY_BACKUP_MODE = "freeze";
export const PREDEPLOY_BACKUP_PATHS = new Set([
  "/api/admin/d1-export",
  "/api/admin/r2-inventory",
]);

const MINIMUM_TOKEN_BYTES = 32;
const MAXIMUM_TOKEN_BYTES = 512;
const MAXIMUM_WINDOW_MS = 60 * 60 * 1_000;

export type PredeployBackupConfiguration = {
  mode: string | null;
  token: string | null;
  expiresAt: string | null;
  origin: string | null;
  sourceCommitSha: string | null;
  sitesVersionId: string | null;
};

export type PredeployBackupCheckpoint = {
  sourceCommitSha: string;
  sitesVersionId: string;
};

export function isPredeployBackupFreeze(mode: unknown): boolean {
  return typeof mode === "string" && mode.trim() === PREDEPLOY_BACKUP_MODE;
}

export function isAllowedDuringPredeployBackup(
  method: string,
  pathname: string,
): boolean {
  if (PREDEPLOY_BACKUP_PATHS.has(pathname)) return method === "POST";
  if (pathname === "/api/health") return method === "GET" || method === "HEAD";
  return false;
}

export function predeployMaintenanceResponse(): Response {
  return Response.json(
    { error: "predeploy_backup_maintenance" },
    {
      status: 503,
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
        "retry-after": "300",
      },
    },
  );
}

export async function authorizePredeployBackupRequest(
  request: Request,
  configuration: PredeployBackupConfiguration,
  nowMs: number = Date.now(),
): Promise<Response | null> {
  const tokenBytes = configuration.token
    ? new TextEncoder().encode(configuration.token).byteLength
    : 0;
  const expiresAtMs = Date.parse(configuration.expiresAt ?? "");
  const checkpoint = predeployBackupCheckpoint(configuration);
  const configuredOrigin = canonicalSecureOrigin(configuration.origin);
  if (
    !isPredeployBackupFreeze(configuration.mode) ||
    tokenBytes < MINIMUM_TOKEN_BYTES ||
    tokenBytes > MAXIMUM_TOKEN_BYTES ||
    !Number.isFinite(expiresAtMs) ||
    expiresAtMs <= nowMs ||
    expiresAtMs - nowMs > MAXIMUM_WINDOW_MS ||
    !checkpoint ||
    !configuredOrigin
  ) {
    return privateJsonError(503, "predeploy_backup_unavailable");
  }

  if (!hasExactSecureOrigin(request, configuredOrigin)) {
    return privateJsonError(403, "predeploy_backup_origin_forbidden");
  }

  const presentedToken =
    request.headers.get("x-27pm-backup-token")?.trim() ?? "";
  if (
    !presentedToken ||
    new TextEncoder().encode(presentedToken).byteLength > MAXIMUM_TOKEN_BYTES ||
    !(await constantTimeEqual(presentedToken, configuration.token!))
  ) {
    return privateJsonError(401, "predeploy_backup_unauthorized");
  }

  return null;
}

export function predeployBackupCheckpoint(
  configuration: Pick<
    PredeployBackupConfiguration,
    "sourceCommitSha" | "sitesVersionId"
  >,
): PredeployBackupCheckpoint | null {
  const sourceCommitSha = configuration.sourceCommitSha?.trim().toLowerCase();
  const sitesVersionId = configuration.sitesVersionId?.trim();
  if (
    !sourceCommitSha ||
    !/^[0-9a-f]{40}$/u.test(sourceCommitSha) ||
    !sitesVersionId ||
    !/^[A-Za-z0-9._~-]{1,256}$/u.test(sitesVersionId)
  ) {
    return null;
  }
  return { sourceCommitSha, sitesVersionId };
}

export function privateBackupHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}

function hasExactSecureOrigin(
  request: Request,
  configuredOrigin: string,
): boolean {
  let target: URL;
  let origin: URL;
  try {
    target = new URL(request.url);
    origin = new URL(request.headers.get("origin") ?? "");
  } catch {
    return false;
  }
  return (
    target.protocol === "https:" &&
    origin.protocol === "https:" &&
    target.origin === configuredOrigin &&
    origin.origin === configuredOrigin &&
    request.headers.get("sec-fetch-site") !== "cross-site"
  );
}

function canonicalSecureOrigin(value: string | null): string | null {
  let configured: URL;
  try {
    configured = new URL(value ?? "");
  } catch {
    return null;
  }
  if (
    configured.protocol !== "https:" ||
    configured.href !== configured.origin + "/"
  ) {
    return null;
  }
  return configured.origin;
}

async function constantTimeEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(left)),
    crypto.subtle.digest("SHA-256", encoder.encode(right)),
  ]);
  const leftBytes = new Uint8Array(leftDigest);
  const rightBytes = new Uint8Array(rightDigest);
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) {
    difference |= leftBytes[index] ^ rightBytes[index];
  }
  return difference === 0;
}

function privateJsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: privateBackupHeaders() },
  );
}
