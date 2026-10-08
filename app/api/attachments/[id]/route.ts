import { requireOperatorRequest } from "@/lib/api-auth";
import { attachmentDownloadPath } from "@/lib/attachment-download";
import { privateJsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: RouteContext) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  try {
    attachmentDownloadPath(id);
  } catch {
    return privateJsonError(400, "attachment_id_invalid");
  }
  return privateJsonError(410, "attachment_download_ticket_required");
}
