import { authorizeMobileAttachments, mobileAttachmentResources } from "@/lib/mobile-attachments-api";
import { antimalwareAvailable } from "@/lib/mobile-antimalware";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await authorizeMobileAttachments(request);
  if (auth.response) return auth.response;
  const resources = await mobileAttachmentResources();
  // Configuration alone must not drain the device queue while the scanner is down.
  // This bounded health read neither scans files nor enables any feature flag.
  const attachments = resources !== null && await antimalwareAvailable(resources.scanner);
  return Response.json({ attachments }, {
    headers: { "cache-control": "private, no-store" },
  });
}
