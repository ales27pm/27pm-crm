import { authorizeMobileAttachments, mobileAttachmentResources, attachmentApiError } from "@/lib/mobile-attachments-api";
import { downloadMobileAttachment } from "@/lib/mobile-attachments";
import { privateJsonError } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeMobileAttachments(request);
  if (auth.response) return auth.response;
  const resources = await mobileAttachmentResources();
  if (!resources) return privateJsonError(503, "attachments_unavailable");
  try { return await downloadMobileAttachment(resources.db, resources.bucket, (await params).id); }
  catch (error) { return attachmentApiError(error); }
}
