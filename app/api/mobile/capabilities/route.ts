import { authorizeMobileAttachments, mobileAttachmentResources } from "@/lib/mobile-attachments-api";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const auth = await authorizeMobileAttachments(request);
  if (auth.response) return auth.response;
  return Response.json({ attachments: Boolean(await mobileAttachmentResources()) }, {
    headers: { "cache-control": "private, no-store" },
  });
}
