export const INTERNAL_API_ASSERTION_MAX_TTL_SECONDS = 60;
export const INTERNAL_API_ASSERTION_DEFAULT_TTL_SECONDS = 30;

const ASSERTION_PREFIX = "ia1";
const CLOCK_SKEW_SECONDS = 5;
const MAX_TOKEN_LENGTH = 4096;
const MAX_PAYLOAD_BYTES = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const AUDIENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u;
const HTTP_METHOD = /^[A-Z][A-Z0-9!#$%&'*+\-.^_`|~]{0,31}$/u;
const PATHNAME = /^\/[A-Za-z0-9._~!$&'()*+,;=:@/-]*$/u;
const CRITICAL_REQUEST_HEADERS = ["content-type", "idempotency-key"] as const;
const SIMPLE_EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/iu;

type EncodedInternalApiClaims = {
  v: 1;
  sub: string;
  aud: string;
  mth: string;
  pth: string;
  iat: number;
  exp: number;
  nonce: string;
  bd?: string;
  hd: string;
  qd?: string;
};

export type InternalApiAssertionClaims = {
  version: 1;
  subject: string;
  audience: string;
  method: string;
  pathname: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  bodyDigest?: string;
  headerDigest: string;
  queryDigest?: string;
};

export type InternalApiAssertionInput = {
  subject: string;
  audience: string;
  method: string;
  pathname: string;
  nonce?: string;
  bodyDigest?: string;
  headerDigest: string;
  queryDigest?: string;
};

export type InternalApiVerificationContext = {
  audience: string;
  method: string;
  pathname: string;
  subject?: string;
  nonce?: string;
  bodyDigest?: string;
  headerDigest: string;
  queryDigest?: string;
};

/**
 * Creates a short-lived assertion for exactly one internal HTTP request.
 * The verifier must separately consume the returned nonce in a replay cache.
 */
export async function createInternalApiAssertion(
  signingSecret: string,
  input: InternalApiAssertionInput,
  now = new Date(),
  ttlSeconds = INTERNAL_API_ASSERTION_DEFAULT_TTL_SECONDS,
): Promise<{ token: string; claims: InternalApiAssertionClaims }> {
  const key = await internalApiSigningKey(signingSecret);
  const subject = normalizeEmail(input.subject);
  const nowSeconds = dateSeconds(now);
  const nonce = input.nonce ?? randomBase64Url(16);
  if (
    !key ||
    !subject ||
    !validAudience(input.audience) ||
    !validMethod(input.method) ||
    !validPathname(input.pathname) ||
    !validNonce(nonce) ||
    !validOptionalBodyDigest(input.bodyDigest) ||
    typeof input.headerDigest !== "string" ||
    !validBodyDigest(input.headerDigest) ||
    !validOptionalBodyDigest(input.queryDigest) ||
    nowSeconds === null ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > INTERNAL_API_ASSERTION_MAX_TTL_SECONDS
  ) {
    throw new Error("internal_api_assertion_input_invalid");
  }

  const encoded: EncodedInternalApiClaims = {
    v: 1,
    sub: subject,
    aud: input.audience,
    mth: input.method,
    pth: input.pathname,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    nonce,
    ...(input.bodyDigest === undefined ? {} : { bd: input.bodyDigest }),
    hd: input.headerDigest,
    ...(input.queryDigest === undefined ? {} : { qd: input.queryDigest }),
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(encoded));
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("internal_api_assertion_input_invalid");
  }
  const payload = encodeBase64Url(payloadBytes);
  const signingInput = `${ASSERTION_PREFIX}.${payload}`;
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

/**
 * Verifies the MAC before inspecting claims, then binds them to the request.
 * Web Crypto performs the fixed-size MAC comparison without application-level
 * early exits over signature bytes.
 */
export async function verifyInternalApiAssertion(
  signingSecret: string | null | undefined,
  token: string,
  expected: InternalApiVerificationContext,
  now = new Date(),
): Promise<InternalApiAssertionClaims | null> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const context = validVerificationContext(expected);
  const key = signingSecret
    ? await internalApiSigningKey(signingSecret)
    : null;
  const nowSeconds = dateSeconds(now);
  if (!context || !key || nowSeconds === null) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, payload, signature] = parts;
  if (
    prefix !== ASSERTION_PREFIX ||
    !payload ||
    !signature ||
    !BASE64URL.test(payload) ||
    !BASE64URL.test(signature)
  ) return null;

  try {
    const payloadBytes = decodeBase64Url(payload);
    const signatureBytes = decodeBase64Url(signature);
    if (
      payloadBytes.byteLength > MAX_PAYLOAD_BYTES ||
      signatureBytes.byteLength !== 32 ||
      encodeBase64Url(payloadBytes) !== payload ||
      encodeBase64Url(signatureBytes) !== signature
    ) return null;

    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      signatureBytes,
      new TextEncoder().encode(`${prefix}.${payload}`),
    );
    if (!verified) return null;

    const parsed: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(payloadBytes),
    );
    if (!validEncodedClaims(parsed, nowSeconds)) return null;
    if (
      parsed.aud !== context.audience ||
      parsed.mth !== context.method ||
      parsed.pth !== context.pathname ||
      parsed.bd !== context.bodyDigest ||
      parsed.hd !== context.headerDigest ||
      parsed.qd !== context.queryDigest ||
      (context.subject !== undefined && parsed.sub !== context.subject) ||
      (context.nonce !== undefined && parsed.nonce !== context.nonce)
    ) return null;
    return decodedClaims(parsed);
  } catch {
    return null;
  }
}

export async function internalApiBodyDigest(
  body: string | Uint8Array | ArrayBuffer,
): Promise<string> {
  const bytes = typeof body === "string"
    ? new TextEncoder().encode(body)
    : body instanceof Uint8Array
      ? new Uint8Array(body)
      : new Uint8Array(body.slice(0));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeBase64Url(new Uint8Array(digest));
}

/**
 * Produces the digest signed for request headers that alter application
 * semantics. Names and absent values have a fixed order and representation.
 */
export async function internalApiCriticalHeadersDigest(
  headers: Headers,
): Promise<string> {
  return internalApiBodyDigest(JSON.stringify(
    CRITICAL_REQUEST_HEADERS.map((name) => [name, headers.get(name)]),
  ));
}

function validEncodedClaims(
  value: unknown,
  nowSeconds: number,
): value is EncodedInternalApiClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<EncodedInternalApiClaims> & Record<string, unknown>;
  const expectedKeys = [
    "aud",
    ...(claims.bd === undefined ? [] : ["bd"]),
    "exp",
    "hd",
    "iat",
    "mth",
    "nonce",
    "pth",
    ...(claims.qd === undefined ? [] : ["qd"]),
    "sub",
    "v",
  ];
  if (Object.keys(claims).toSorted().join(",") !== expectedKeys.join(",")) {
    return false;
  }
  const subject = typeof claims.sub === "string"
    ? normalizeEmail(claims.sub)
    : null;
  return (
    claims.v === 1 &&
    Boolean(subject) &&
    subject === claims.sub &&
    typeof claims.aud === "string" &&
    validAudience(claims.aud) &&
    typeof claims.mth === "string" &&
    validMethod(claims.mth) &&
    typeof claims.pth === "string" &&
    validPathname(claims.pth) &&
    typeof claims.iat === "number" &&
    Number.isSafeInteger(claims.iat) &&
    claims.iat >= 0 &&
    claims.iat <= nowSeconds + CLOCK_SKEW_SECONDS &&
    typeof claims.exp === "number" &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > nowSeconds &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= INTERNAL_API_ASSERTION_MAX_TTL_SECONDS &&
    typeof claims.nonce === "string" &&
    validNonce(claims.nonce) &&
    (claims.bd === undefined ||
      (typeof claims.bd === "string" && validBodyDigest(claims.bd))) &&
    typeof claims.hd === "string" &&
    validBodyDigest(claims.hd) &&
    (claims.qd === undefined ||
      (typeof claims.qd === "string" && validBodyDigest(claims.qd)))
  );
}

function validVerificationContext(
  value: InternalApiVerificationContext,
): InternalApiVerificationContext | null {
  if (
    !value ||
    !validAudience(value.audience) ||
    !validMethod(value.method) ||
    !validPathname(value.pathname) ||
    !validOptionalBodyDigest(value.bodyDigest) ||
    typeof value.headerDigest !== "string" ||
    !validBodyDigest(value.headerDigest) ||
    !validOptionalBodyDigest(value.queryDigest) ||
    (value.subject !== undefined && !normalizeEmail(value.subject)) ||
    (value.nonce !== undefined && !validNonce(value.nonce))
  ) return null;
  return {
    audience: value.audience,
    method: value.method,
    pathname: value.pathname,
    ...(value.subject === undefined
      ? {}
      : { subject: normalizeEmail(value.subject) ?? undefined }),
    ...(value.nonce === undefined ? {} : { nonce: value.nonce }),
    ...(value.bodyDigest === undefined
      ? {}
      : { bodyDigest: value.bodyDigest }),
    headerDigest: value.headerDigest,
    ...(value.queryDigest === undefined
      ? {}
      : { queryDigest: value.queryDigest }),
  };
}

function decodedClaims(
  claims: EncodedInternalApiClaims,
): InternalApiAssertionClaims {
  return {
    version: claims.v,
    subject: claims.sub,
    audience: claims.aud,
    method: claims.mth,
    pathname: claims.pth,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
    nonce: claims.nonce,
    ...(claims.bd === undefined ? {} : { bodyDigest: claims.bd }),
    headerDigest: claims.hd,
    ...(claims.qd === undefined ? {} : { queryDigest: claims.qd }),
  };
}

async function internalApiSigningKey(
  secret: string,
): Promise<CryptoKey | null> {
  if (!validSecret(secret)) return null;
  return crypto.subtle.importKey(
    "raw",
    decodeBase64Url(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function validSecret(value: string): boolean {
  if (
    typeof value !== "string" ||
    value.length < 43 ||
    value.length > 128 ||
    !BASE64URL.test(value)
  ) return false;
  try {
    const decoded = decodeBase64Url(value);
    return (
      decoded.byteLength >= 32 &&
      decoded.byteLength <= 96 &&
      encodeBase64Url(decoded) === value
    );
  } catch {
    return false;
  }
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized &&
    normalized.length <= 254 &&
    SIMPLE_EMAIL.test(normalized)
    ? normalized
    : null;
}

function validAudience(value: unknown): value is string {
  return typeof value === "string" && AUDIENCE.test(value);
}

function validMethod(value: unknown): value is string {
  return typeof value === "string" && HTTP_METHOD.test(value);
}

function validPathname(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    !PATHNAME.test(value) ||
    value.includes("//") ||
    value.includes("%")
  ) return false;
  return !value.split("/").some((segment) => segment === "." || segment === "..");
}

function validNonce(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 22 ||
    value.length > 86 ||
    !BASE64URL.test(value)
  ) return false;
  try {
    const decoded = decodeBase64Url(value);
    return (
      decoded.byteLength >= 16 &&
      decoded.byteLength <= 64 &&
      encodeBase64Url(decoded) === value
    );
  } catch {
    return false;
  }
}

function validOptionalBodyDigest(value: unknown): boolean {
  return value === undefined ||
    (typeof value === "string" && validBodyDigest(value));
}

function validBodyDigest(value: string): boolean {
  if (value.length !== 43 || !BASE64URL.test(value)) return false;
  try {
    const decoded = decodeBase64Url(value);
    return decoded.byteLength === 32 && encodeBase64Url(decoded) === value;
  } catch {
    return false;
  }
}

function dateSeconds(value: Date): number | null {
  const milliseconds = value instanceof Date ? value.valueOf() : Number.NaN;
  if (!Number.isFinite(milliseconds)) return null;
  const seconds = Math.floor(milliseconds / 1000);
  return Number.isSafeInteger(seconds) && seconds >= 0 ? seconds : null;
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
