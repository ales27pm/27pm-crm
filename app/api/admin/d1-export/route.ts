import { boundedRequest } from "@/lib/bounded-request";
import { crmDatabase } from "@/lib/d1";
import { buildLogicalD1Snapshot } from "@/lib/d1-snapshot";
import {
  authorizePredeployBackupRequest,
  predeployBackupCheckpoint,
  privateBackupHeaders,
} from "@/lib/predeploy-backup";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const MAX_EXPORT_BYTES = 24 * 1_024 * 1_024;

export async function POST(request: Request) {
  const configuration = {
    mode: runtimeString("CRM_PREDEPLOY_BACKUP_MODE"),
    token: runtimeString("CRM_PREDEPLOY_BACKUP_TOKEN"),
    expiresAt: runtimeString("CRM_PREDEPLOY_BACKUP_EXPIRES_AT"),
    origin: runtimeString("CRM_PREDEPLOY_BACKUP_ORIGIN"),
    sourceCommitSha: runtimeString("CRM_PREDEPLOY_BACKUP_SOURCE_COMMIT_SHA"),
    sitesVersionId: runtimeString("CRM_PREDEPLOY_BACKUP_SITES_VERSION_ID"),
  };
  const denied = await authorizePredeployBackupRequest(request, configuration);
  if (denied) return denied;
  const checkpoint = predeployBackupCheckpoint(configuration)!;
  if (!(await boundedRequest(request, 0))) {
    return Response.json(
      { error: "predeploy_backup_request_body_forbidden" },
      { status: 400, headers: privateBackupHeaders() },
    );
  }

  try {
    const snapshot = await buildLogicalD1Snapshot(crmDatabase());
    const body = JSON.stringify({ ...snapshot, checkpoint });
    const size = new TextEncoder().encode(body).byteLength;
    if (size > MAX_EXPORT_BYTES) {
      return Response.json(
        { error: "predeploy_backup_export_too_large" },
        { status: 507, headers: privateBackupHeaders() },
      );
    }

    const stamp = snapshot.completedAt.replaceAll(/[:.]/gu, "-");
    return new Response(body, {
      status: 200,
      headers: {
        ...privateBackupHeaders(),
        "content-disposition": `attachment; filename="27pm-crm-d1-${stamp}.json"`,
        "content-length": String(size),
        "content-type": "application/json; charset=utf-8",
        "x-27pm-backup-byte-count": String(size),
        "x-27pm-backup-format": snapshot.format,
      },
    });
  } catch {
    return Response.json(
      { error: "predeploy_backup_export_failed" },
      { status: 500, headers: privateBackupHeaders() },
    );
  }
}
