import { parseOperatorAllowlist } from "./auth";
import { normalizeEmailAddress } from "./mailboxes";

export type WebIdentityProvider = "sites" | "google" | "disabled";

type GoogleIdentityProfile = {
  email?: unknown;
  email_verified?: unknown;
} | null | undefined;

const AUTH_JS_PATH = "/api/auth";
const SITES_SIGN_IN_PATH = "/signin-with-chatgpt";
const SITES_SIGN_OUT_PATH = "/signout-with-chatgpt";
const SITES_CALLBACK_PATH = "/callback";

export function webIdentityProvider(
  value = process.env.CRM_WEB_IDENTITY_PROVIDER,
): WebIdentityProvider {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "sites") return "sites";
  if (normalized === "google") return "google";
  return "disabled";
}

export function googleIdentityAllowed(
  profile: GoogleIdentityProfile,
  allowlistSource: string | null | undefined,
  providerSource = process.env.CRM_WEB_IDENTITY_PROVIDER,
): boolean {
  if (webIdentityProvider(providerSource) !== "google") return false;
  if (profile?.email_verified !== true || typeof profile.email !== "string") {
    return false;
  }

  const email = normalizeEmailAddress(profile.email);
  return operatorEmailAllowed(email, allowlistSource);
}

export function operatorEmailAllowed(
  value: unknown,
  allowlistSource: string | null | undefined,
): boolean {
  if (typeof value !== "string") return false;
  const email = normalizeEmailAddress(value);
  return Boolean(email && parseOperatorAllowlist(allowlistSource).has(email));
}

export function safeRelativeReturnPath(value: string): string {
  if (!value.startsWith("/") || value.startsWith("//")) return "/";

  let url: URL;
  try {
    url = new URL(value, "https://app.local");
  } catch {
    return "/";
  }
  if (url.origin !== "https://app.local" || isReservedAuthPath(url.pathname)) {
    return "/";
  }

  return `${url.pathname}${url.search}${url.hash}`;
}

export function authJsSignInPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${AUTH_JS_PATH}/signin?callbackUrl=${encodeURIComponent(safeReturnTo)}`;
}

export function authJsSignOutPath(returnTo = "/"): string {
  const safeReturnTo = safeRelativeReturnPath(returnTo);
  return `${AUTH_JS_PATH}/signout?callbackUrl=${encodeURIComponent(safeReturnTo)}`;
}

export function safeAuthRedirect(url: string, baseUrl: string): string {
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    return baseUrl;
  }
  const fallback = new URL("/", base).toString();

  try {
    if (url.startsWith("/")) {
      return new URL(safeRelativeReturnPath(url), base).toString();
    }

    const candidate = new URL(url);
    if (candidate.origin !== base.origin) return fallback;
    const relative = `${candidate.pathname}${candidate.search}${candidate.hash}`;
    return new URL(safeRelativeReturnPath(relative), base).toString();
  } catch {
    return fallback;
  }
}

function isReservedAuthPath(pathname: string): boolean {
  return (
    pathname === SITES_SIGN_IN_PATH ||
    pathname === SITES_SIGN_OUT_PATH ||
    pathname === SITES_CALLBACK_PATH ||
    pathname === AUTH_JS_PATH ||
    pathname.startsWith(`${AUTH_JS_PATH}/`)
  );
}
