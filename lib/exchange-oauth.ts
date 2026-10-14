import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from "jose";

export const EXCHANGE_OAUTH_CALLBACK_PATH = "/api/integrations/exchange/callback";
export const EXCHANGE_OAUTH_FLOW_TTL_SECONDS = 5 * 60;
export const EXCHANGE_OAUTH_SCOPES = [
  "openid",
  "profile",
  "offline_access",
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
] as const;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const PKCE_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/u;
const MAX_RESPONSE_BYTES = 128 * 1024;
const MAX_CREDENTIAL_LENGTH = 32 * 1024;
const NETWORK_TIMEOUT_MS = 10_000;
const CLOCK_TOLERANCE_SECONDS = 5;

export type ExchangeOAuthConfig = {
  tenantId: string;
  mailboxId: string;
  clientId: string;
  clientSecret: string;
  publicOrigin: string;
  callbackOrigin: string;
};

export type ExchangeOAuthError =
  | "exchange_configuration_invalid"
  | "exchange_authorization_invalid"
  | "exchange_provider_unavailable"
  | "exchange_reauthentication_required"
  | "exchange_provider_response_invalid"
  | "exchange_identity_invalid"
  | "exchange_scopes_missing";

export type ExchangeOAuthResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: ExchangeOAuthError };

export type ExchangeOAuthOptions = {
  fetcher?: typeof fetch;
  now?: Date;
};

export type ExchangeIdentity = {
  tenantId: string;
  mailboxId: string;
  subject: string;
};

/** Server-only result: never return these credentials to a browser or log them. */
export type ExchangeCredentials = {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  scopes: string[];
  identity?: ExchangeIdentity;
};

export function parseExchangeOAuthConfig(
  input: Record<string, unknown>,
): ExchangeOAuthConfig | null {
  const tenantId = validGuid(input.tenantId);
  const mailboxId = validGuid(input.mailboxId);
  const clientId = validGuid(input.clientId);
  const publicOrigin = validOrigin(input.publicOrigin);
  const callbackOrigin = validOrigin(input.callbackOrigin);
  if (
    !tenantId || !mailboxId || !clientId || !publicOrigin || !callbackOrigin ||
    typeof input.clientSecret !== "string" || !input.clientSecret.trim() ||
    input.clientSecret.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input.clientSecret)
  ) return null;
  return {
    tenantId, mailboxId, clientId, publicOrigin, callbackOrigin,
    clientSecret: input.clientSecret,
  };
}

export async function createExchangeAuthorization(
  configuration: ExchangeOAuthConfig,
  now = new Date(),
): Promise<{
  authorizationUrl: string;
  state: string;
  nonce: string;
  codeVerifier: string;
  expiresAt: string;
}> {
  const config = parseExchangeOAuthConfig(configuration);
  if (!config || !Number.isFinite(now.valueOf())) {
    throw new Error("exchange_configuration_invalid");
  }
  const state = randomBase64Url();
  const nonce = randomBase64Url();
  const codeVerifier = randomBase64Url();
  const challenge = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const url = new URL(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("response_mode", "form_post");
  url.searchParams.set("redirect_uri", callbackUri(config));
  url.searchParams.set("scope", EXCHANGE_OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", base64Url(new Uint8Array(challenge)));
  url.searchParams.set("code_challenge_method", "S256");
  return {
    authorizationUrl: url.toString(), state, nonce, codeVerifier,
    expiresAt: new Date(now.valueOf() + EXCHANGE_OAUTH_FLOW_TTL_SECONDS * 1000).toISOString(),
  };
}

export async function exchangeAuthorizationCode(
  configuration: ExchangeOAuthConfig,
  input: { code: string; codeVerifier: string; nonce: string },
  options: ExchangeOAuthOptions = {},
): Promise<ExchangeOAuthResult<ExchangeCredentials>> {
  const config = parseExchangeOAuthConfig(configuration);
  if (!config) return failure("exchange_configuration_invalid");
  if (!validCredential(input.code) || !PKCE_VERIFIER.test(input.codeVerifier) || !validNonce(input.nonce)) {
    return failure("exchange_authorization_invalid");
  }
  const response = await tokenRequest(config, {
    grant_type: "authorization_code",
    code: input.code,
    code_verifier: input.codeVerifier,
    redirect_uri: callbackUri(config),
  }, options);
  if (!response.ok) return response;
  const credentials = parseCredentials(response.value, options.now ?? new Date());
  if (!credentials.ok) return credentials;
  if (typeof response.value.id_token !== "string") return failure("exchange_identity_invalid");
  const identity = await verifyExchangeIdToken(config, response.value.id_token, input.nonce, options);
  if (!identity.ok) return identity;
  return { ok: true, value: { ...credentials.value, identity: identity.value } };
}

export async function refreshExchangeCredentials(
  configuration: ExchangeOAuthConfig,
  refreshToken: string,
  options: ExchangeOAuthOptions = {},
): Promise<ExchangeOAuthResult<ExchangeCredentials>> {
  const config = parseExchangeOAuthConfig(configuration);
  if (!config) return failure("exchange_configuration_invalid");
  if (!validCredential(refreshToken)) return failure("exchange_authorization_invalid");
  const response = await tokenRequest(config, {
    grant_type: "refresh_token", refresh_token: refreshToken,
  }, options);
  if (!response.ok) return response;
  const credentials = parseCredentials(response.value, options.now ?? new Date());
  if (!credentials.ok) return credentials;
  // Refresh does not require a new ID token. If one is returned, its identity
  // must still match the mailbox; never replace identity from unverified claims.
  if (response.value.id_token !== undefined) {
    if (typeof response.value.id_token !== "string") return failure("exchange_identity_invalid");
    const identity = await verifyIdentity(config, response.value.id_token, undefined, options);
    if (!identity.ok) return identity;
    return { ok: true, value: { ...credentials.value, identity: identity.value } };
  }
  return credentials;
}

export async function verifyExchangeIdToken(
  configuration: ExchangeOAuthConfig,
  token: string,
  nonce: string,
  options: ExchangeOAuthOptions = {},
): Promise<ExchangeOAuthResult<ExchangeIdentity>> {
  const config = parseExchangeOAuthConfig(configuration);
  if (!config) return failure("exchange_configuration_invalid");
  if (!validNonce(nonce)) return failure("exchange_identity_invalid");
  return verifyIdentity(config, token, nonce, options);
}

async function verifyIdentity(
  config: ExchangeOAuthConfig,
  token: string,
  nonce: string | undefined,
  options: ExchangeOAuthOptions,
): Promise<ExchangeOAuthResult<ExchangeIdentity>> {
  if (!validCredential(token)) return failure("exchange_identity_invalid");
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.valueOf())) return failure("exchange_configuration_invalid");
  try {
    const header = decodeProtectedHeader(token);
    if (
      header.alg !== "RS256" || typeof header.kid !== "string" ||
      !header.kid || header.kid.length > 256 || header.jku || header.x5u ||
      (header.typ !== undefined && header.typ !== "JWT")
    ) return failure("exchange_identity_invalid");

    const jwksUrl = `https://login.microsoftonline.com/${config.tenantId}/discovery/v2.0/keys`;
    const jwks = await fetchJson(jwksUrl, { method: "GET", headers: { accept: "application/json" } }, options);
    if (!jwks.ok) return jwks;
    if (!Array.isArray(jwks.value.keys) || jwks.value.keys.length > 64) {
      return failure("exchange_identity_invalid");
    }
    const candidates = jwks.value.keys.filter((value): value is JWK & { issuer?: string } => {
      if (!isObject(value)) return false;
      return value.kid === header.kid && value.kty === "RSA" &&
        (value.alg === undefined || value.alg === "RS256") &&
        (value.use === undefined || value.use === "sig") &&
        value.d === undefined && typeof value.n === "string" &&
        typeof value.e === "string" && BASE64URL.test(value.n) && BASE64URL.test(value.e);
    });
    if (candidates.length !== 1) return failure("exchange_identity_invalid");
    const jwk = candidates[0];
    const issuer = `https://login.microsoftonline.com/${config.tenantId}/v2.0`;
    if (jwk.issuer !== undefined && jwk.issuer.replace("{tenantid}", config.tenantId) !== issuer) {
      return failure("exchange_identity_invalid");
    }
    const key = await importJWK(jwk, "RS256");
    const { payload } = await jwtVerify(token, key, {
      algorithms: ["RS256"], issuer, audience: config.clientId,
      currentDate: now, clockTolerance: CLOCK_TOLERANCE_SECONDS,
      requiredClaims: ["iss", "aud", "exp", "nbf", "iat", "tid", "oid", "sub", ...(nonce ? ["nonce"] : [])],
    });
    const nowSeconds = Math.floor(now.valueOf() / 1000);
    if (
      payload.aud !== config.clientId || payload.tid !== config.tenantId ||
      payload.oid !== config.mailboxId || typeof payload.sub !== "string" ||
      !payload.sub || payload.sub.length > 256 ||
      !Number.isInteger(payload.iat) || !Number.isInteger(payload.nbf) || !Number.isInteger(payload.exp) ||
      payload.iat! > nowSeconds + CLOCK_TOLERANCE_SECONDS ||
      payload.exp! <= payload.iat! || payload.nbf! > payload.exp! ||
      (nonce !== undefined && payload.nonce !== nonce)
    ) return failure("exchange_identity_invalid");
    return { ok: true, value: { tenantId: config.tenantId, mailboxId: config.mailboxId, subject: payload.sub } };
  } catch {
    return failure("exchange_identity_invalid");
  }
}

async function tokenRequest(
  config: ExchangeOAuthConfig,
  parameters: Record<string, string>,
  options: ExchangeOAuthOptions,
): Promise<ExchangeOAuthResult<Record<string, unknown>>> {
  const body = new URLSearchParams({
    client_id: config.clientId, client_secret: config.clientSecret,
    scope: EXCHANGE_OAUTH_SCOPES.join(" "), ...parameters,
  });
  return fetchJson(`https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  }, options);
}

async function fetchJson(
  url: string,
  init: RequestInit,
  options: ExchangeOAuthOptions,
): Promise<ExchangeOAuthResult<Record<string, unknown>>> {
  try {
    const response = await (options.fetcher ?? fetch)(url, {
      ...init, redirect: "error", cache: "no-store", referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    });
    if (response.redirected) return failure("exchange_provider_response_invalid");
    const value = await boundedJson(response);
    if (!response.ok) {
      if (value && (value.error === "invalid_grant" || value.error === "interaction_required")) {
        return failure("exchange_reauthentication_required");
      }
      return failure("exchange_provider_unavailable");
    }
    if (response.status !== 200 || !value) return failure("exchange_provider_response_invalid");
    return { ok: true, value };
  } catch {
    return failure("exchange_provider_unavailable");
  }
}

async function boundedJson(response: Response): Promise<Record<string, unknown> | null> {
  const length = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isObject(value) ? value : null;
  } catch { return null; }
}

function parseCredentials(
  value: Record<string, unknown>,
  now: Date,
): ExchangeOAuthResult<ExchangeCredentials> {
  if (
    !validCredential(value.access_token) || !validCredential(value.refresh_token) ||
    value.token_type !== "Bearer" || typeof value.expires_in !== "number" ||
    !Number.isInteger(value.expires_in) || value.expires_in <= 0 || value.expires_in > 86400 ||
    !Number.isFinite(now.valueOf())
  ) return failure("exchange_provider_response_invalid");
  const scopes = typeof value.scope === "string" && value.scope.length <= 4096
    ? [...new Set(value.scope.split(/\s+/u).filter(Boolean))] : [];
  const graphScopes = scopes.map((scope) => scope.replace(/^https:\/\/graph\.microsoft\.com\//u, ""));
  if (!graphScopes.includes("Mail.ReadWrite") || !graphScopes.includes("Mail.Send")) {
    return failure("exchange_scopes_missing");
  }
  return {
    ok: true,
    value: {
      accessToken: value.access_token, refreshToken: value.refresh_token,
      accessTokenExpiresAt: new Date(now.valueOf() + value.expires_in * 1000).toISOString(),
      scopes,
    },
  };
}

function callbackUri(config: ExchangeOAuthConfig): string {
  return `${config.callbackOrigin}${EXCHANGE_OAUTH_CALLBACK_PATH}`;
}

function validGuid(value: unknown): string | null {
  return typeof value === "string" && GUID.test(value) && value !== "00000000-0000-0000-0000-000000000000"
    ? value.toLowerCase() : null;
}

function validOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() !== value || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch { return null; }
}

function validCredential(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_CREDENTIAL_LENGTH &&
    !/[\s\u0000-\u001f\u007f]/u.test(value);
}

function validNonce(value: unknown): value is string {
  return typeof value === "string" && value.length === 43 && BASE64URL.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function randomBase64Url(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

function base64Url(value: Uint8Array): string {
  return btoa(String.fromCharCode(...value)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function failure(error: ExchangeOAuthError): { ok: false; error: ExchangeOAuthError } {
  return { ok: false, error };
}
