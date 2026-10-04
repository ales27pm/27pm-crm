import { authorizeMobileAttachments, mobileAttachmentResources, attachmentApiError } from "@/lib/mobile-attachments-api";
import { deleteMobileAttachment } from "@/lib/mobile-attachments";
import { privateJsonError } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeMobileAttachments(request, true);
  if (auth.response) return auth.response;
  const resources = await mobileAttachmentResources();
  if (!resources) return privateJsonError(503, "attachments_unavailable");
  try {
    await deleteMobileAttachment(resources.db, resources.bucket, (await params).id);
    return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
  } catch (error) { return attachmentApiError(error); }
}
