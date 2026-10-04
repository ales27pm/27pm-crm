import { crmDatabase } from "@/lib/d1";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";
import {
  createMobileAccessToken,
  MOBILE_ACCESS_TOKEN_TTL_SECONDS,
  MOBILE_CLIENT_ID,
  readMobileAuthJson,
  validMobileIosAppId,
  validMobileIssuer,
  validMobileRedirectUri,
  validMobileSigningSecret,
} from "@/lib/mobile-auth";
import {
  exchangeMobileAuthorizationCode,
  rotateMobileRefreshToken,
  type IssuedMobileSession,
} from "@/lib/mobile-auth-store";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const payload = await readMobileAuthJson(request);
  if (!payload) return privateJsonError(400, "invalid_request");
  const signingSecret = runtimeString("CRM_MOBILE_TOKEN_SIGNING_KEY");
  const issuer = validMobileIssuer(runtimeString("CRM_PUBLIC_ORIGIN"));
  if (
    !validMobileSigningSecret(signingSecret) ||
    !issuer ||
    !validMobileIosAppId(runtimeString("CRM_IOS_APP_ID"))
  ) {
    return privateJsonError(503, "mobile_authentication_unavailable");
  }

  let session: IssuedMobileSession | null = null;
  try {
    if (payload.grantType === "authorization_code") {
      const configuredRedirectUri = validMobileRedirectUri(
        runtimeString("CRM_MOBILE_REDIRECT_URI"),
        issuer,
      );
      if (!configuredRedirectUri || payload.redirectUri !== configuredRedirectUri) {
        return privateJsonError(400, "invalid_grant");
      }
      session = await exchangeMobileAuthorizationCode(crmDatabase(), {
        code: payload.code,
        codeVerifier: payload.codeVerifier,
        clientId: payload.clientId,
        redirectUri: payload.redirectUri,
        operatorAllowlist: runtimeString("CRM_ADMIN_EMAILS"),
      });
    } else if (payload.grantType === "refresh_token") {
      session = await rotateMobileRefreshToken(crmDatabase(), {
        refreshToken: payload.refreshToken,
        clientId: payload.clientId,
        operatorAllowlist: runtimeString("CRM_ADMIN_EMAILS"),
      });
    } else {
      return privateJsonError(400, "unsupported_grant_type");
    }
    if (!session || payload.clientId !== MOBILE_CLIENT_ID) {
      return privateJsonError(400, "invalid_grant");
    }
    const access = await createMobileAccessToken(signingSecret, {
      issuer,
      operatorEmail: session.operator.email,
      sessionId: session.sessionId,
    });
    return Response.json(
      {
        accessToken: access.token,
        tokenType: "Bearer",
        expiresIn: MOBILE_ACCESS_TOKEN_TTL_SECONDS,
        refreshToken: session.refreshToken,
        scope: session.scopes,
        sessionExpiresAt: session.sessionExpiresAt,
        operator: { email: session.operator.email },
      },
      { headers: privateNoStoreHeaders() },
    );
  } catch {
    return privateJsonError(503, "mobile_authentication_unavailable");
  }
}
