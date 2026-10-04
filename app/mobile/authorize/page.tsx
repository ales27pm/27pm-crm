import type { Metadata } from "next";
import { AccessScreen } from "@/app/components/access-screen";
import {
  MobileAuthorizationApproval,
  MobileAuthorizationUnavailable,
} from "@/app/components/mobile-authorization";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { isCrmOperator } from "@/app/operator-access";
import {
  parseMobileAuthorizationRequest,
  mobileAuthorizationErrorCallback,
  validMobileIosAppId,
  validMobileIssuer,
  validMobileRedirectUri,
} from "@/lib/mobile-auth";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Autoriser l’app mobile — 27PM CRM",
  referrer: "no-referrer",
  robots: { index: false, follow: false },
};

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MobileAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const configuredRedirectUri = validMobileRedirectUri(
    runtimeString("CRM_MOBILE_REDIRECT_URI"),
    runtimeString("CRM_PUBLIC_ORIGIN"),
  );
  if (
    !configuredRedirectUri ||
    !validMobileIosAppId(runtimeString("CRM_IOS_APP_ID")) ||
    !validMobileIssuer(runtimeString("CRM_PUBLIC_ORIGIN"))
  ) {
    return <MobileAuthorizationUnavailable reason="unconfigured" />;
  }
  const scalarParams = Object.fromEntries(
    Object.entries(params).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const authorizationRequest = parseMobileAuthorizationRequest(
    scalarParams,
    configuredRedirectUri,
  );
  if (!authorizationRequest) {
    return <MobileAuthorizationUnavailable reason="invalid" />;
  }
  const returnParams = new URLSearchParams({
    response_type: "code",
    client_id: authorizationRequest.clientId,
    redirect_uri: authorizationRequest.redirectUri,
    code_challenge: authorizationRequest.codeChallenge,
    code_challenge_method: "S256",
    state: authorizationRequest.state,
  });
  if (authorizationRequest.deviceName) {
    returnParams.set("device_name", authorizationRequest.deviceName);
  }
  const returnTo = `/mobile/authorize?${returnParams.toString()}`;
  const user = await getChatGPTUser();
  if (!user) return <AccessScreen state="signed-out" returnTo={returnTo} />;
  if (!isCrmOperator(user.email)) {
    return <AccessScreen state="denied" email={user.email} returnTo={returnTo} />;
  }
  return (
    <MobileAuthorizationApproval
      operatorEmail={user.email}
      clientId={authorizationRequest.clientId}
      redirectUri={authorizationRequest.redirectUri}
      codeChallenge={authorizationRequest.codeChallenge}
      state={authorizationRequest.state}
      deviceName={authorizationRequest.deviceName}
      denialUrl={mobileAuthorizationErrorCallback(authorizationRequest)}
    />
  );
}
