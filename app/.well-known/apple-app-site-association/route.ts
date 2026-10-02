import { runtimeString } from "@/lib/runtime";
import {
  mobileAppleAppSiteAssociation,
  validMobileIosAppId,
} from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const appId = runtimeString("CRM_IOS_APP_ID");
  if (!validMobileIosAppId(appId)) {
    return Response.json(
      { error: "ios_universal_link_unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return Response.json(
    mobileAppleAppSiteAssociation(appId),
    {
      headers: {
        "cache-control": "public, max-age=3600",
        "content-type": "application/json",
      },
    },
  );
}
