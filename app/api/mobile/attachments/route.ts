import { authorizeMobileAttachments, mobileAttachmentResources, attachmentApiError } from "@/lib/mobile-attachments-api";
import { listMobileAttachments, uploadMobileAttachment, validAttachmentOwner, readAttachmentForm, attachmentFormParts } from "@/lib/mobile-attachments";
import { privateJsonError } from "@/lib/http";
import { scanStoredMobileAttachment } from "@/lib/mobile-antimalware";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const auth = await authorizeMobileAttachments(request, true);
  if (auth.response) return auth.response;
  const resources = await mobileAttachmentResources();
  if (!resources) return privateJsonError(503, "attachments_unavailable");
  try {
    const { kind, ownerId, file } = attachmentFormParts(await readAttachmentForm(request));
    const id = await uploadMobileAttachment(resources.db, resources.bucket, kind, ownerId, file,
      auth.operator.mobileSessionId ?? auth.operator.email);
    // Storage is already committed. Scanner outages leave quarantine intact, not
    // a failed upload that prompts another object. A later GET retries scanning.
    await scanStoredMobileAttachment(resources.db, resources.bucket, id, resources.scanner).catch(() => undefined);
    return Response.json({ id }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return attachmentApiError(error); }
}
export async function GET(request: Request) {
  const auth = await authorizeMobileAttachments(request);
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const kind = url.searchParams.get("ownerKind") ?? "";
  const ownerId = url.searchParams.get("ownerId") ?? "";
  if (!validAttachmentOwner(kind, ownerId)
    || url.searchParams.getAll("ownerKind").length !== 1 || url.searchParams.getAll("ownerId").length !== 1) {
    return privateJsonError(400, "validation_failed");
  }
  const resources = await mobileAttachmentResources();
  if (!resources) return privateJsonError(503, "attachments_unavailable");
  try {
    return Response.json({ attachments: await listMobileAttachments(resources.db, kind, ownerId) }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) { return attachmentApiError(error); }
}
