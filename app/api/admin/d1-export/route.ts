import { crmDatabase } from "@/lib/d1";
import { buildLogicalD1Snapshot } from "@/lib/d1-snapshot";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const MAX_EXPORT_BYTES = 24 * 1024 * 1024;

export async function POST(request: Request) {
  const expectedToken = runtimeString("CRM_BACKUP_TOKEN");
  const expiresAt = Date.parse(runtimeString("CRM_BACKUP_EXPIRES_AT") ?? "");
  if (!expectedToken || !Number.isFinite(expiresAt) || Date.now() >= expiresAt) {
    return jsonError(503, "backup_export_unavailable");
  }

  const presentedToken = request.headers.get("x-27pm-backup-token")?.trim() ?? "";
  if (!presentedToken || !(await constantTimeEqual(presentedToken, expectedToken))) {
    return jsonError(401, "backup_export_unauthorized");
  }

  try {
    const snapshot = await buildLogicalD1Snapshot(crmDatabase());
    const body = JSON.stringify(snapshot);
    const size = new TextEncoder().encode(body).byteLength;
    if (size > MAX_EXPORT_BYTES) {
      return jsonError(507, "backup_export_too_large");
    }

    const stamp = snapshot.completedAt.replaceAll(/[:.]/gu, "-");
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename="27pm-crm-d1-${stamp}.json"`,
        "content-type": "application/json; charset=utf-8",
        "x-27pm-backup-format": snapshot.format,
      },
    });
  } catch {
    return jsonError(500, "backup_export_failed");
  }
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

function jsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: { "cache-control": "private, no-store" } },
  );
}
