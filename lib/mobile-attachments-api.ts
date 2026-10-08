import "server-only";
import { requireOperatorOrMobileRequest, requireSameOriginOperatorOrMobileRequest } from "./api-auth";
import { crmDatabase } from "./d1";
import { privateJsonError } from "./http";
import { mobileBearerToken } from "./mobile-auth";
import { AttachmentError, attachmentsConfigured, mobileAttachmentSchemaReady } from "./mobile-attachments";
import { getPrivateObjectBucket, runtimeString, getAntimalwareService } from "./runtime";
import { scannerConfigured } from "./mobile-antimalware";

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
    runtimeString("MOBILE_ATTACHMENTS_RUNTIME"), runtimeString("VERCEL"),
    runtimeString("MOBILE_ATTACHMENTS_SCAN_POLICY"))) return null;
  try {
    const db = crmDatabase();
    const bucket = getPrivateObjectBucket();
    const service = getAntimalwareService();
    const scanner = service ? { service, token: runtimeString("CRM_ANTIMALWARE_TOKEN") ?? "" } : null;
    if (!scannerConfigured(scanner)) return null;
    if (typeof bucket.put !== "function" || typeof bucket.get !== "function"
      || typeof bucket.head !== "function" || typeof bucket.delete !== "function") return null;
    if (!(await mobileAttachmentSchemaReady(db))) return null;
    return { db, bucket, scanner };
  } catch { return null; }
}
export function attachmentApiError(error: unknown) {
  const response = error instanceof AttachmentError
    ? privateJsonError(error.status, error.code)
    : privateJsonError(503, "attachment_storage_unavailable");
  if (response.status === 423) response.headers.set("retry-after", "60");
  return response;
}
