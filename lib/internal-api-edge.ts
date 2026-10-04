import {
  internalApiBodyDigest,
  internalApiCriticalHeadersDigest,
  verifyInternalApiAssertion,
} from "./internal-api-auth";
import {
  consumeInternalApiNonce,
  pruneExpiredInternalApiNonces,
  type InternalApiNonceDatabase,
} from "./internal-api-nonce-store";

export const INTERNAL_API_ASSERTION_HEADER = "x-27pm-internal-assertion";
export const INTERNAL_API_DEFAULT_AUDIENCE = "27pm-sites-worker";

const AUTHENTICATED_IDENTITY_HEADERS = [
  "oai-authenticated-user-email",
  "oai-authenticated-user-full-name",
  "oai-authenticated-user-full-name-encoding",
];

type ApiAuthMode = "sites" | "hybrid" | "internal";

export type InternalApiEdgeEnvironment = {
  DB: InternalApiNonceDatabase;
  CRM_API_AUTH_MODE?: string;
  CRM_INTERNAL_API_AUDIENCE?: string;
  CRM_INTERNAL_API_SIGNING_KEY?: string;
  CRM_SITES_TRUSTED_ORIGIN?: string;
};

export type InternalApiExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

/**
 * Converts a verified one-time internal assertion into the legacy trusted
 * identity header expected by the route layer. Client identity headers are
 * stripped before this function adds any replacement.
 */
export async function prepareInternalApiRequest(
  request: Request,
  environment: InternalApiEdgeEnvironment,
  context?: InternalApiExecutionContext,
): Promise<Request | Response> {
  const mode = apiAuthMode(environment.CRM_API_AUTH_MODE);
  if (!mode) return internalApiError(503, "internal_auth_mode_invalid");

  const headers = new Headers(request.headers);
  const assertion = headers.get(INTERNAL_API_ASSERTION_HEADER);
  headers.delete(INTERNAL_API_ASSERTION_HEADER);

  const trustedSitesIdentity =
    (mode === "sites" || (mode === "hybrid" && !assertion)) &&
    isTrustedSitesRequest(request, environment.CRM_SITES_TRUSTED_ORIGIN);
  if (trustedSitesIdentity) {
    return assertion ? new Request(request, { headers }) : request;
  }

  for (const name of AUTHENTICATED_IDENTITY_HEADERS) headers.delete(name);

  if (mode === "sites") return new Request(request, { headers });
  if (!assertion) return new Request(request, { headers });

  const url = new URL(request.url);
  const bodyDigest = request.body === null
    ? undefined
    : await internalApiBodyDigest(await request.clone().arrayBuffer());
  const queryDigest = await internalApiBodyDigest(url.search);
  const headerDigest = await internalApiCriticalHeadersDigest(headers);
  const claims = await verifyInternalApiAssertion(
    environment.CRM_INTERNAL_API_SIGNING_KEY,
    assertion,
    {
      audience:
        environment.CRM_INTERNAL_API_AUDIENCE?.trim() ||
        INTERNAL_API_DEFAULT_AUDIENCE,
      method: request.method.toUpperCase(),
      pathname: url.pathname,
      bodyDigest,
      headerDigest,
      queryDigest,
    },
  );
  if (!claims) return internalApiError(401, "internal_assertion_invalid");

  let consumed = false;
  try {
    consumed = await consumeInternalApiNonce(environment.DB, claims);
  } catch {
    return internalApiError(503, "internal_assertion_store_unavailable");
  }
  if (!consumed) return internalApiError(401, "internal_assertion_replayed");

  context?.waitUntil(
    pruneExpiredInternalApiNonces(environment.DB).catch(() => undefined),
  );
  headers.set("oai-authenticated-user-email", claims.subject);
  // The Vercel boundary performs the browser same-origin check before signing.
  // Rebase the already authenticated server-to-server request so the existing
  // route guards keep their same-origin invariant at the Worker URL.
  headers.set("origin", url.origin);
  headers.set("sec-fetch-site", "same-origin");
  return new Request(request, { headers });
}

function apiAuthMode(value: string | undefined): ApiAuthMode | null {
  const normalized = value?.trim().toLowerCase();
  return normalized === "sites" ||
    normalized === "hybrid" ||
    normalized === "internal"
    ? normalized
    : null;
}

function isTrustedSitesRequest(request: Request, configuredOrigin: string | undefined): boolean {
  try {
    const configured = new URL(configuredOrigin ?? "");
    if (
      configured.protocol !== "https:" ||
      configured.username ||
      configured.password ||
      configured.pathname !== "/" ||
      configured.search ||
      configured.hash
    ) return false;
    return new URL(request.url).origin === configured.origin;
  } catch {
    return false;
  }
}

function internalApiError(status: 401 | 503, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
