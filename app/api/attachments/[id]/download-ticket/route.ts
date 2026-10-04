import { requireSameOriginOperatorRequest } from "@/lib/api-auth";
import {
  attachmentDownloadPath,
  attachmentObjectDigest,
  attachmentObjectMatches,
  canonicalAttachmentDownloadOrigin,
  createAttachmentDownloadTicket,
  validAttachmentDownloadSigningSecret,
  type AttachmentDownloadRecord,
} from "@/lib/attachment-download";
import { attachmentDownloadDecision } from "@/lib/attachments";
import { crmDatabase } from "@/lib/d1";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";
import { getPrivateObjectBucket, runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };
type AttachmentRow = AttachmentDownloadRecord & { scanStatus: string };

export async function POST(request: Request, context: RouteContext) {
  const auth = requireSameOriginOperatorRequest(request);
  if (auth.response) return auth.response;

  const { id } = await context.params;
  let pathname: string;
  try {
    pathname = attachmentDownloadPath(id);
  } catch {
    return privateJsonError(400, "attachment_id_invalid");
  }

  const signingKey = runtimeString("CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY");
  const downloadOrigin = canonicalAttachmentDownloadOrigin(
    runtimeString("CRM_ATTACHMENT_DOWNLOAD_ORIGIN"),
  );
  if (!downloadOrigin || !validAttachmentDownloadSigningSecret(signingKey)) {
    return privateJsonError(503, "attachment_download_unavailable");
  }

  try {
    const db = crmDatabase();
    const attachment = await db
      .prepare(
        `SELECT r2_key AS r2Key, file_name AS fileName,
                size_bytes AS sizeBytes, sha256,
                scan_status AS scanStatus
         FROM attachments WHERE id = ? LIMIT 1`,
      )
      .bind(id)
      .first<AttachmentRow>();
    if (!attachment) return privateJsonError(404, "attachment_not_found");

    const decision = attachmentDownloadDecision(attachment.scanStatus);
    if (!decision.allowed) {
      return privateJsonError(decision.status, decision.code);
    }

    const object = await getPrivateObjectBucket().head(attachment.r2Key);
    if (!object) {
      return privateJsonError(404, "attachment_object_not_found");
    }
    if (!attachmentObjectMatches(attachment, object)) {
      return privateJsonError(423, "attachment_integrity_unverified");
    }

    const objectDigest = await attachmentObjectDigest({
      attachmentId: id,
      attachment,
      object,
    });
    const ticket = await createAttachmentDownloadTicket(signingKey, {
      attachmentId: id,
      origin: downloadOrigin,
      pathname,
      objectDigest,
    });
    const expiresAt = new Date(ticket.claims.expiresAt * 1000).toISOString();

    const audit = await db
      .prepare(
        `INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'attachment.download_ticket_issued',
                 'attachment', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        auth.operator.email,
        id,
        JSON.stringify({ expiresAt }),
      )
      .run();
    if (!audit.success || audit.meta?.changes !== 1) {
      return privateJsonError(503, "attachment_download_audit_unavailable");
    }

    const downloadAction = new URL(pathname, downloadOrigin);
    return Response.json(
      {
        downloadAction: downloadAction.toString(),
        ticket: ticket.token,
        method: "POST",
        expiresAt,
      },
      { headers: privateNoStoreHeaders() },
    );
  } catch {
    return privateJsonError(503, "attachment_download_unavailable");
  }
}
