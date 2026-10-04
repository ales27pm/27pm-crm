import { requireOperatorRequest } from "@/lib/api-auth";
import { safeAttachmentDisplayName } from "@/lib/attachment-download";
import { crmDatabase } from "@/lib/d1";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

type AttachmentListRow = {
  id: string;
  messageId: string;
  fileName: string;
  sizeBytes: number;
  scanStatus: string;
};

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const query = [...url.searchParams.entries()];
  const conversationId = url.searchParams.get("conversationId");
  if (
    query.length !== 1 ||
    query[0]?.[0] !== "conversationId" ||
    !conversationId ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(conversationId)
  ) return privateJsonError(400, "conversation_id_invalid");

  try {
    const result = await crmDatabase()
      .prepare(
        `SELECT attachment.id,
                attachment.message_id AS messageId,
                attachment.file_name AS fileName,
                attachment.size_bytes AS sizeBytes,
                attachment.scan_status AS scanStatus
         FROM attachments attachment
         JOIN messages message ON message.id = attachment.message_id
         WHERE message.conversation_id = ?
         ORDER BY attachment.created_at, attachment.id
         LIMIT 201`,
      )
      .bind(conversationId)
      .all<AttachmentListRow>();
    if (!result.success) {
      return privateJsonError(503, "attachments_unavailable");
    }
    const rows = result.results.slice(0, 200);
    return Response.json(
      {
        attachments: rows.map((attachment) => ({
          ...attachment,
          fileName: safeAttachmentDisplayName(attachment.fileName),
          sizeBytes: Number(attachment.sizeBytes),
          downloadable: attachment.scanStatus === "clean",
        })),
        truncated: result.results.length > rows.length,
      },
      { headers: privateNoStoreHeaders() },
    );
  } catch {
    return privateJsonError(503, "attachments_unavailable");
  }
}
