import { normalizeEmailAddress } from "./mailboxes";
import { boundedRequest } from "./bounded-request";

export const MOBILE_CLIENT_ID = "org.27pm.crm.mobile";
export const MOBILE_TOKEN_AUDIENCE = "27pm-crm-mobile";
export const MOBILE_SCOPES = ["crm:dashboard:read", "crm:work"] as const;
export const MOBILE_SCOPE_VALUE = "crm:dashboard:read crm:work" as const;
export const MOBILE_ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MOBILE_AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;
export const MOBILE_SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;

const ACCESS_TOKEN_PREFIX = "ma1";
const AUTHORIZATION_CODE_PREFIX = "mc1";
const REFRESH_TOKEN_PREFIX = "mr1";
const PKCE_CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const REQUEST_STATE = /^[A-Za-z0-9._~-]{22,256}$/u;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const IOS_APP_ID = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]{3,200}$/u;

export type MobileScope = (typeof MOBILE_SCOPES)[number];
export type MobileScopeValue = MobileScope | typeof MOBILE_SCOPE_VALUE;

export type MobileAccessClaims = {
  version: 1;
  issuer: string;
  audience: typeof MOBILE_TOKEN_AUDIENCE;
  subject: string;
  sessionId: string;
  scopes: MobileScopeValue;
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  tokenId: string;
};

type EncodedClaims = {
  v: 1;
  iss: string;
  aud: typeof MOBILE_TOKEN_AUDIENCE;
  sub: string;
  sid: string;
  scp: MobileScopeValue;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
};

export type MobileAuthorizationRequest = {
  clientId: typeof MOBILE_CLIENT_ID;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  deviceName: string | null;
};

export function parseMobileAuthorizationRequest(
  input: Record<string, unknown>,
  configuredRedirectUri: string | null | undefined,
): MobileAuthorizationRequest | null {
  const redirectUri = validMobileRedirectUri(configuredRedirectUri);
  const deviceName = normalizeDeviceName(input.deviceName ?? input.device_name);
  const responseType = aliasedString(input, "responseType", "response_type");
  const clientId = aliasedString(input, "clientId", "client_id");
  const requestedRedirect = aliasedString(input, "redirectUri", "redirect_uri");
  const challengeMethod = aliasedString(
    input,
    "codeChallengeMethod",
    "code_challenge_method",
  );
  const codeChallenge = aliasedString(input, "codeChallenge", "code_challenge");
  const state = input.state;
  if (
    !redirectUri ||
    responseType !== "code" ||
    clientId !== MOBILE_CLIENT_ID ||
    requestedRedirect !== redirectUri ||
    challengeMethod !== "S256" ||
    !codeChallenge ||
    !PKCE_CHALLENGE.test(codeChallenge) ||
    typeof state !== "string" ||
    !REQUEST_STATE.test(state) ||
    deviceName === undefined
  ) return null;
  return {
    clientId: MOBILE_CLIENT_ID,
    redirectUri,
    codeChallenge,
    state,
    deviceName,
  };
}

export function validMobileRedirectUri(
  value: string | null | undefined,
  expectedOrigin?: string | null,
): string | null {
  if (!value || value.length > 512 || value.trim() !== value) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/mobile/oauth/callback" ||
      url.search ||
      url.hash
    ) return null;
    if (expectedOrigin && url.origin !== validIssuer(expectedOrigin)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function mobileAuthorizationCallback(
  request: MobileAuthorizationRequest,
  code: string,
): string {
  const callback = new URL(request.redirectUri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", request.state);
  return callback.toString();
}

export function mobileAuthorizationErrorCallback(
  request: MobileAuthorizationRequest,
): string {
  const callback = new URL(request.redirectUri);
  callback.searchParams.set("error", "access_denied");
  callback.searchParams.set("state", request.state);
  return callback.toString();
}

export function generateMobileAuthorizationCode(): string {
  return `${AUTHORIZATION_CODE_PREFIX}.${randomBase64Url(32)}`;
}

export function validMobileAuthorizationCode(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length === 47 &&
    value.startsWith(`${AUTHORIZATION_CODE_PREFIX}.`) &&
    BASE64URL.test(value.slice(AUTHORIZATION_CODE_PREFIX.length + 1))
  );
}

export function generateMobileRefreshToken(sessionId: string): string {
  if (!SESSION_ID.test(sessionId)) throw new Error("mobile_session_id_invalid");
  return `${REFRESH_TOKEN_PREFIX}.${sessionId}.${randomBase64Url(32)}`;
}

export function parseMobileRefreshToken(
  value: unknown,
): { sessionId: string; token: string } | null {
  if (typeof value !== "string" || value.length > 256) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [prefix, sessionId, secret] = parts;
  if (
    prefix !== REFRESH_TOKEN_PREFIX ||
    !sessionId ||
    !SESSION_ID.test(sessionId) ||
    !secret ||
    secret.length !== 43 ||
    !BASE64URL.test(secret)
  ) return null;
  return { sessionId, token: value };
}

export async function mobilePkceChallenge(verifier: string): Promise<string | null> {
  if (!PKCE_VERIFIER.test(verifier)) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return encodeBase64Url(new Uint8Array(digest));
}

export async function hashMobileCredential(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createMobileAccessToken(
  signingSecret: string,
  input: {
    issuer: string;
    operatorEmail: string;
    sessionId: string;
  },
  now = new Date(),
): Promise<{ token: string; claims: MobileAccessClaims }> {
  const key = await mobileSigningKey(signingSecret);
  const issuer = validIssuer(input.issuer);
  const subject = normalizeEmailAddress(input.operatorEmail);
  if (!key || !issuer || !subject || !SESSION_ID.test(input.sessionId)) {
    throw new Error("mobile_access_token_input_invalid");
  }
  const issuedAt = Math.floor(now.valueOf() / 1000);
  const encoded: EncodedClaims = {
    v: 1,
    iss: issuer,
    aud: MOBILE_TOKEN_AUDIENCE,
    sub: subject,
    sid: input.sessionId,
    scp: MOBILE_SCOPE_VALUE,
    iat: issuedAt,
    nbf: issuedAt - 5,
    exp: issuedAt + MOBILE_ACCESS_TOKEN_TTL_SECONDS,
    jti: crypto.randomUUID(),
  };
  const payload = encodeBase64Url(
    new TextEncoder().encode(JSON.stringify(encoded)),
  );
  const signingInput = `${ACCESS_TOKEN_PREFIX}.${payload}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signingInput),
  );
  return {
    token: `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`,
    claims: decodedClaims(encoded),
  };
}

export async function verifyMobileAccessToken(
  signingSecret: string | null | undefined,
  token: string,
  expectedIssuer: string,
  now = new Date(),
): Promise<MobileAccessClaims | null> {
  if (token.length > 4096) return null;
  const issuer = validIssuer(expectedIssuer);
  const key = signingSecret ? await mobileSigningKey(signingSecret) : null;
  if (!key || !issuer) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, payload, signature] = parts;
  if (
    prefix !== ACCESS_TOKEN_PREFIX ||
    !payload ||
    !signature ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(signature)
  ) return null;
  try {
    const payloadBytes = decodeBase64Url(payload);
    const signatureBytes = decodeBase64Url(signature);
    if (
      encodeBase64Url(payloadBytes) !== payload ||
      encodeBase64Url(signatureBytes) !== signature ||
      signatureBytes.byteLength !== 32
    ) return null;
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(`${prefix}.${payload}`),
    );
    if (!verified) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(payloadBytes));
    if (!validEncodedClaims(parsed, issuer, now)) return null;
    return decodedClaims(parsed);
  } catch {
    return null;
  }
}

export function mobileBearerToken(request: Request): string | null | undefined {
  const authorization = request.headers.get("authorization");
  if (authorization === null) return undefined;
  const match = authorization.match(/^Bearer ([A-Za-z0-9._-]{1,4096})$/u);
  return match?.[1] ?? null;
}

export async function readMobileAuthJson(
  request: Request,
): Promise<Record<string, unknown> | null> {
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") return null;
  const declaredLength = request.headers.get("content-length");
  if (declaredLength) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > 8192) {
      return null;
    }
  }
  try {
    const bounded = await boundedRequest(request, 8192);
    if (!bounded) return null;
    const body = await bounded.text();
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function hasMobileScope(
  claims: MobileAccessClaims,
  requiredScope: MobileScope,
): boolean {
  return claims.scopes.split(" ").includes(requiredScope);
}

function validMobileScopeValue(value: unknown): value is MobileScopeValue {
  return value === MOBILE_SCOPES[0]
    || value === MOBILE_SCOPES[1]
    || value === MOBILE_SCOPE_VALUE;
}

export function validMobileSigningSecret(
  value: string | null | undefined,
): value is string {
  if (!value || value.length < 43 || value.length > 128 || !BASE64URL.test(value)) {
    return false;
  }
  try {
    const decoded = decodeBase64Url(value);
    return decoded.byteLength >= 32 && encodeBase64Url(decoded) === value;
  } catch {
    return false;
  }
}

export function validMobileIssuer(value: string | null | undefined): string | null {
  return value ? validIssuer(value) : null;
}

export function validMobileIosAppId(
  value: string | null | undefined,
): value is string {
  return Boolean(value && IOS_APP_ID.test(value));
}

export function mobileAppleAppSiteAssociation(appId: unknown) {
  if (typeof appId !== "string" || !validMobileIosAppId(appId)) return null;
  return {
    applinks: {
      details: [
        {
          appIDs: [appId],
          components: [
            {
              "/": "/mobile/oauth/callback",
              comment: "27PM CRM mobile authorization callback",
            },
          ],
        },
      ],
    },
    webcredentials: {
      apps: [appId],
    },
  };
}

function normalizeDeviceName(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/gu, " ");
  if (
    !normalized ||
    normalized.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) return undefined;
  return normalized;
}

function aliasedString(
  input: Record<string, unknown>,
  primary: string,
  alternate: string,
): string | null {
  const first = input[primary];
  const second = input[alternate];
  if (
    (first !== undefined && typeof first !== "string") ||
    (second !== undefined && typeof second !== "string") ||
    (typeof first === "string" && typeof second === "string" && first !== second)
  ) return null;
  return typeof first === "string"
    ? first
    : typeof second === "string"
      ? second
      : null;
}

function validIssuer(value: string): string | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

function validEncodedClaims(
  value: unknown,
  issuer: string,
  now: Date,
): value is EncodedClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<EncodedClaims> & Record<string, unknown>;
  const expectedKeys = ["aud", "exp", "iat", "iss", "jti", "nbf", "scp", "sid", "sub", "v"];
  if (Object.keys(claims).toSorted().join(",") !== expectedKeys.join(",")) return false;
  const subject = typeof claims.sub === "string"
    ? normalizeEmailAddress(claims.sub)
    : null;
  const nowSeconds = Math.floor(now.valueOf() / 1000);
  return (
    claims.v === 1 &&
    claims.iss === issuer &&
    claims.aud === MOBILE_TOKEN_AUDIENCE &&
    Boolean(subject) &&
    subject === claims.sub &&
    typeof claims.sid === "string" &&
    SESSION_ID.test(claims.sid) &&
    validMobileScopeValue(claims.scp) &&
    Number.isInteger(claims.iat) &&
    Number.isInteger(claims.nbf) &&
    Number.isInteger(claims.exp) &&
    typeof claims.iat === "number" &&
    typeof claims.nbf === "number" &&
    typeof claims.exp === "number" &&
    claims.iat <= nowSeconds + 30 &&
    claims.nbf <= nowSeconds + 30 &&
    claims.exp > nowSeconds &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= MOBILE_ACCESS_TOKEN_TTL_SECONDS &&
    typeof claims.jti === "string" &&
    SESSION_ID.test(claims.jti)
  );
}

function decodedClaims(claims: EncodedClaims): MobileAccessClaims {
  return {
    version: claims.v,
    issuer: claims.iss,
    audience: claims.aud,
    subject: claims.sub,
    sessionId: claims.sid,
    scopes: claims.scp,
    issuedAt: claims.iat,
    notBefore: claims.nbf,
    expiresAt: claims.exp,
    tokenId: claims.jti,
  };
}

async function mobileSigningKey(secret: string): Promise<CryptoKey | null> {
  if (!validMobileSigningSecret(secret)) return null;
  return crypto.subtle.importKey(
    "raw",
    decodeBase64Url(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function randomBase64Url(length: number): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(length)));
}

function encodeBase64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/gu, "");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  if (!value || !BASE64URL.test(value) || value.length % 4 === 1) {
    throw new Error("base64url_invalid");
  }
  const padded = value
    .replace(/-/gu, "+")
    .replace(/_/gu, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    output[index] = binary.charCodeAt(index);
  }
  return output;
}
