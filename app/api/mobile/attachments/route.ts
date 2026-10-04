import { authorizeMobileAttachments, mobileAttachmentResources, attachmentApiError } from "@/lib/mobile-attachments-api";
import { listMobileAttachments, uploadMobileAttachment, validAttachmentOwner, readAttachmentForm } from "@/lib/mobile-attachments";
import { privateJsonError } from "@/lib/http";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  const auth = await authorizeMobileAttachments(request, true);
  if (auth.response) return auth.response;
  const resources = await mobileAttachmentResources();
  if (!resources) return privateJsonError(503, "attachments_unavailable");
  let form: FormData;
  try { form = await readAttachmentForm(request); }
  catch (error) { return attachmentApiError(error); }
  const kind = form.get("ownerKind");
  const ownerId = form.get("ownerId");
  const file = form.get("file");
  if (typeof kind !== "string" || typeof ownerId !== "string" || !validAttachmentOwner(kind, ownerId)
    || !(file instanceof File) || form.getAll("file").length !== 1
    || form.getAll("ownerKind").length !== 1 || form.getAll("ownerId").length !== 1) {
    return privateJsonError(400, "validation_failed");
  }
  try {
    const id = await uploadMobileAttachment(resources.db, resources.bucket, kind, ownerId, file,
      auth.operator.mobileSessionId ?? auth.operator.email);
    return Response.json({ id }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) { return attachmentApiError(error); }
}
export async function GET(request: Request) {
  const auth = await authorizeMobileAttachments(request);
  if (auth.response) return auth.response;
  const url = new URL(request.url);
  const kind = url.searchParams.get("ownerKind") ?? "";
  const ownerId = url.searchParams.get("ownerId") ?? "";
  if (!validAttachmentOwner(kind, ownerId)) return privateJsonError(400, "validation_failed");
  const resources = await mobileAttachmentResources();
  if (!resources) return privateJsonError(503, "attachments_unavailable");
  try {
    return Response.json({ attachments: await listMobileAttachments(resources.db, kind, ownerId) }, {
      headers: { "cache-control": "private, no-store" },
    });
  } catch (error) { return attachmentApiError(error); }
}
