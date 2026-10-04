import { authorizeMobileAttachments, mobileAttachmentResources, attachmentApiError } from "@/lib/mobile-attachments-api";
import { downloadScannedMobileAttachment } from "@/lib/mobile-antimalware";
import { privateJsonError } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await authorizeMobileAttachments(request);
  if (auth.response) return auth.response;
  const resources = await mobileAttachmentResources();
  if (!resources) return privateJsonError(503, "attachments_unavailable");
  try { return await downloadScannedMobileAttachment(resources.db, resources.bucket, (await params).id, resources.scanner); }
  catch (error) { return attachmentApiError(error); }
}
