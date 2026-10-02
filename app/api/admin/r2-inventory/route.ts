import { boundedRequest } from "@/lib/bounded-request";
import { readJsonObject } from "@/lib/http";
import {
  authorizePredeployBackupRequest,
  predeployBackupCheckpoint,
  privateBackupHeaders,
} from "@/lib/predeploy-backup";
import {
  buildR2InventoryPage,
  parseR2InventoryCursor,
} from "@/lib/r2-inventory";
import { getPrivateObjectBucket, runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const MAX_REQUEST_BYTES = 8 * 1_024;
const MAX_RESPONSE_BYTES = 2 * 1_024 * 1_024;

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

  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return errorResponse(415, "predeploy_backup_content_type_invalid");
  }
  const bounded = await boundedRequest(request, MAX_REQUEST_BYTES);
  if (!bounded) return errorResponse(413, "predeploy_backup_request_too_large");
  const cursor = parseR2InventoryCursor(await readJsonObject(bounded));
  if (cursor === undefined) {
    return errorResponse(400, "predeploy_backup_cursor_invalid");
  }

  try {
    const inventory = await buildR2InventoryPage(
      getPrivateObjectBucket(),
      cursor,
    );
    const body = JSON.stringify({ ...inventory, checkpoint });
    const size = new TextEncoder().encode(body).byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      return errorResponse(507, "predeploy_backup_inventory_too_large");
    }
    return new Response(body, {
      status: 200,
      headers: {
        ...privateBackupHeaders(),
        "content-length": String(size),
        "content-type": "application/json; charset=utf-8",
        "x-27pm-backup-byte-count": String(size),
        "x-27pm-backup-format": inventory.format,
      },
    });
  } catch {
    return errorResponse(500, "predeploy_backup_inventory_failed");
  }
}

function errorResponse(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: privateBackupHeaders() },
  );
}
