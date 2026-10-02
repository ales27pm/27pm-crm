import { requireSameOriginOperatorRequest } from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";
import {
  mobileAuthorizationCallback,
  parseMobileAuthorizationRequest,
  readMobileAuthJson,
  validMobileIosAppId,
  validMobileIssuer,
  validMobileRedirectUri,
  validMobileSigningSecret,
} from "@/lib/mobile-auth";
import { createMobileAuthorizationGrant } from "@/lib/mobile-auth-store";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireSameOriginOperatorRequest(request);
  if (auth.response) return auth.response;
  const payload = await readMobileAuthJson(request);
  if (!payload) {
    return privateJsonError(400, "mobile_authorization_request_invalid");
  }
  const issuer = validMobileIssuer(runtimeString("CRM_PUBLIC_ORIGIN"));
  if (
    !validMobileSigningSecret(runtimeString("CRM_MOBILE_TOKEN_SIGNING_KEY")) ||
    !issuer ||
    !validMobileIosAppId(runtimeString("CRM_IOS_APP_ID"))
  ) {
    return privateJsonError(503, "mobile_authentication_unavailable");
  }
  const configuredRedirectUri = validMobileRedirectUri(
    runtimeString("CRM_MOBILE_REDIRECT_URI"),
    issuer,
  );
  const authorizationRequest = parseMobileAuthorizationRequest(
    payload,
    configuredRedirectUri,
  );
  if (!authorizationRequest) {
    return privateJsonError(400, "mobile_authorization_request_invalid");
  }
  try {
    const grant = await createMobileAuthorizationGrant(crmDatabase(), {
      operator: auth.operator,
      request: authorizationRequest,
    });
    return Response.json(
      {
        redirectUrl: mobileAuthorizationCallback(
          authorizationRequest,
          grant.code,
        ),
        expiresAt: grant.expiresAt,
      },
      { status: 201, headers: privateNoStoreHeaders() },
    );
  } catch {
    return privateJsonError(503, "mobile_authorization_unavailable");
  }
}
