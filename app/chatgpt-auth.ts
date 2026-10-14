import { headers } from "next/headers";
import { normalizeEmailAddress } from "@/lib/mailboxes";
import {
  authJsSignInPath,
  authJsSignOutPath,
  safeRelativeReturnPath,
  webIdentityProvider,
  type WebIdentityProvider,
} from "@/lib/web-identity";

export { webIdentityProvider } from "@/lib/web-identity";

export type ChatGPTUser = {
  displayName: string;
  email: string;
  fullName: string | null;
};

const USER_EMAIL_HEADER = "oai-authenticated-user-email";
const USER_FULL_NAME_HEADER = "oai-authenticated-user-full-name";
const USER_FULL_NAME_ENCODING_HEADER =
  "oai-authenticated-user-full-name-encoding";
const PERCENT_ENCODED_UTF8 = "percent-encoded-utf-8";
const SIGN_IN_PATH = "/signin-with-chatgpt";
const SIGN_OUT_PATH = "/signout-with-chatgpt";

export async function getChatGPTUser(): Promise<ChatGPTUser | null> {
  const provider = webIdentityProvider();
  if (provider === "google") return getAuthJsUser();
  if (provider === "disabled") return null;

  const requestHeaders = await headers();
  const email = requestHeaders.get(USER_EMAIL_HEADER);
  if (!email) return null;

  const encodedFullName = requestHeaders.get(USER_FULL_NAME_HEADER);
  const fullName =
    encodedFullName &&
    requestHeaders.get(USER_FULL_NAME_ENCODING_HEADER) === PERCENT_ENCODED_UTF8
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return {
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

export function webSignInPath(
  returnTo: string,
  provider: WebIdentityProvider = webIdentityProvider(),
): string {
  if (provider === "google") return authJsSignInPath(returnTo);
  if (provider === "sites") return chatGPTSignInPath(returnTo);
  return "/";
}

export function webSignOutPath(
  returnTo = "/",
  provider: WebIdentityProvider = webIdentityProvider(),
): string {
  if (provider === "google") return authJsSignOutPath(returnTo);
  if (provider === "sites") return chatGPTSignOutPath(returnTo);
  return "/";
}

export function chatGPTSignInPath(returnTo: string): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_IN_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

export function chatGPTSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${SIGN_OUT_PATH}?return_to=${encodeURIComponent(safeReturnTo)}`;
}

async function getAuthJsUser(): Promise<ChatGPTUser | null> {
  const { auth } = await import("../auth");
  const session = await auth();
  const email = normalizeEmailAddress(session?.user?.email ?? "");
  if (!email) return null;

  const fullName = session?.user?.name?.trim() || null;
  return {
    displayName: fullName ?? email,
    email,
    fullName,
  };
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}
