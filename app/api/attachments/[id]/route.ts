import { requireOperatorRequest } from "@/lib/api-auth";
import { attachmentDownloadDecision } from "@/lib/attachments";
import { crmDatabase } from "@/lib/d1";
import { jsonError } from "@/lib/http";
import { getPrivateObjectBucket } from "@/lib/runtime";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

type AttachmentRow = {
  r2Key: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  scanStatus: string;
};

export async function GET(request: Request, context: RouteContext) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) {
    return jsonError(400, "attachment_id_invalid");
  }

  try {
    const attachment = await crmDatabase()
      .prepare(
        `SELECT r2_key AS r2Key, file_name AS fileName,
                content_type AS contentType, size_bytes AS sizeBytes,
                scan_status AS scanStatus
         FROM attachments WHERE id = ? LIMIT 1`,
      )
      .bind(id)
      .first<AttachmentRow>();
    if (!attachment) return jsonError(404, "attachment_not_found");

    const decision = attachmentDownloadDecision(attachment.scanStatus);
    if (!decision.allowed) return jsonError(decision.status, decision.code);

    const object = await getPrivateObjectBucket().get(attachment.r2Key);
    if (!object) return jsonError(404, "attachment_object_not_found");

    return new Response(object.body, {
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
        "content-length": String(attachment.sizeBytes),
        "content-type": attachment.contentType,
        "x-content-type-options": "nosniff",
      },
    });
  } catch {
    return jsonError(500, "attachment_download_failed");
  }
}
