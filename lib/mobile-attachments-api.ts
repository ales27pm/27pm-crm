import "server-only";
import { requireOperatorOrMobileRequest, requireSameOriginOperatorOrMobileRequest } from "./api-auth";
import { crmDatabase } from "./d1";
import { privateJsonError } from "./http";
import { mobileBearerToken } from "./mobile-auth";
import { AttachmentError, attachmentsConfigured } from "./mobile-attachments";
import { getPrivateObjectBucket, runtimeString } from "./runtime";

export async function authorizeMobileAttachments(request: Request, write = false) {
  // Mobile endpoints deliberately require a bearer, not a browser session fallback.
  if (!mobileBearerToken(request)) return { response: privateJsonError(401, "authentication_required") };
  const auth = await (write ? requireSameOriginOperatorOrMobileRequest : requireOperatorOrMobileRequest)(
    request, write ? "crm:work" : "crm:dashboard:read",
  );
  if (auth.response?.status === 401) return { response: privateJsonError(401, "authentication_required") };
  return auth;
}
export async function mobileAttachmentResources() {
  if (!attachmentsConfigured(runtimeString("ATTACHMENTS_ENABLED"),
    runtimeString("MOBILE_ATTACHMENTS_RUNTIME"), runtimeString("VERCEL"))) return null;
  try {
    const db = crmDatabase();
    const bucket = getPrivateObjectBucket();
    if (typeof bucket.put !== "function" || typeof bucket.get !== "function" || typeof bucket.delete !== "function") return null;
    await db.prepare("SELECT id FROM mobile_attachments LIMIT 1").first();
    return { db, bucket };
  } catch { return null; }
}
export function attachmentApiError(error: unknown) {
  return error instanceof AttachmentError
    ? privateJsonError(error.status, error.code)
    : privateJsonError(503, "attachment_storage_unavailable");
}
