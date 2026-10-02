export const ATTACHMENT_DOWNLOAD_MAX_TTL_SECONDS = 60;
export const ATTACHMENT_DOWNLOAD_DEFAULT_TTL_SECONDS = 45;
export const ATTACHMENT_DOWNLOAD_AUDIENCE = "27pm-attachment-download";

const TOKEN_PREFIX = "ad1";
const CLOCK_SKEW_SECONDS = 5;
const MAX_TOKEN_LENGTH = 4096;
const MAX_PAYLOAD_BYTES = 2048;
const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const SAFE_TOKEN_TEXT = /^[\x21-\x7e]{1,512}$/u;

type EncodedAttachmentDownloadClaims = {
  v: 1;
  aud: typeof ATTACHMENT_DOWNLOAD_AUDIENCE;
  ori: string;
  mth: "GET";
  pth: string;
  aid: string;
  obj: string;
  iat: number;
  exp: number;
  nonce: string;
};

export type AttachmentDownloadClaims = {
  version: 1;
  audience: typeof ATTACHMENT_DOWNLOAD_AUDIENCE;
  origin: string;
  method: "GET";
  pathname: string;
  attachmentId: string;
  objectDigest: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
};

export type AttachmentDownloadTicketInput = {
  attachmentId: string;
  origin: string;
  pathname: string;
  objectDigest: string;
  nonce?: string;
};

export type AttachmentDownloadVerificationContext = {
  attachmentId: string;
  origin: string;
  pathname: string;
};

export type AttachmentDownloadRecord = {
  r2Key: string;
  fileName: string;
  sizeBytes: number;
  sha256: string | null;
};

export type AttachmentObjectMetadata = {
  key: string;
  size: number;
  etag: string;
  version: string;
  httpEtag?: string;
  customMetadata?: Record<string, string>;
  checksums?: { sha256?: ArrayBuffer };
};

export function attachmentDownloadPath(attachmentId: string): string {
  if (!validAttachmentId(attachmentId)) {
    throw new Error("attachment_download_ticket_input_invalid");
  }
  return `/downloads/attachments/${attachmentId}`;
}

export function canonicalAttachmentDownloadOrigin(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      url.origin !== value
    ) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function validAttachmentDownloadSigningSecret(
  value: unknown,
): value is string {
  return typeof value === "string" && validSecret(value);
}

export async function createAttachmentDownloadTicket(
  signingSecret: string,
  input: AttachmentDownloadTicketInput,
  now = new Date(),
  ttlSeconds = ATTACHMENT_DOWNLOAD_DEFAULT_TTL_SECONDS,
): Promise<{ token: string; claims: AttachmentDownloadClaims }> {
  const key = await attachmentDownloadSigningKey(signingSecret);
  const nowSeconds = dateSeconds(now);
  const nonce = input.nonce ?? randomBase64Url(24);
  const origin = canonicalAttachmentDownloadOrigin(input.origin);
  if (
    !key ||
    !validAttachmentId(input.attachmentId) ||
    !origin ||
    input.pathname !== attachmentDownloadPath(input.attachmentId) ||
    !validDigest(input.objectDigest) ||
    !validNonce(nonce) ||
    nowSeconds === null ||
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > ATTACHMENT_DOWNLOAD_MAX_TTL_SECONDS
  ) {
    throw new Error("attachment_download_ticket_input_invalid");
  }

  const encoded: EncodedAttachmentDownloadClaims = {
    v: 1,
    aud: ATTACHMENT_DOWNLOAD_AUDIENCE,
    ori: origin,
    mth: "GET",
    pth: input.pathname,
    aid: input.attachmentId,
    obj: input.objectDigest,
    iat: nowSeconds,
    exp: nowSeconds + ttlSeconds,
    nonce,
  };
  const payloadBytes = new TextEncoder().encode(JSON.stringify(encoded));
  if (payloadBytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error("attachment_download_ticket_input_invalid");
  }
  const payload = encodeBase64Url(payloadBytes);
  const signingInput = `${TOKEN_PREFIX}.${payload}`;
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

/** Verifies the MAC before decoding or inspecting any claim. */
export async function verifyAttachmentDownloadTicket(
  signingSecret: string | null | undefined,
  token: string,
  expected: AttachmentDownloadVerificationContext,
  now = new Date(),
): Promise<AttachmentDownloadClaims | null> {
  if (typeof token !== "string" || token.length > MAX_TOKEN_LENGTH) return null;
  const context = validVerificationContext(expected);
  const key = signingSecret
    ? await attachmentDownloadSigningKey(signingSecret)
    : null;
  const nowSeconds = dateSeconds(now);
  if (!context || !key || nowSeconds === null) return null;

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [prefix, payload, signature] = parts;
  if (
    prefix !== TOKEN_PREFIX ||
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
      parsed.ori !== context.origin ||
      parsed.pth !== context.pathname ||
      parsed.aid !== context.attachmentId
    ) return null;
    return decodedClaims(parsed);
  } catch {
    return null;
  }
}

export function attachmentObjectMatches(
  attachment: AttachmentDownloadRecord,
  object: AttachmentObjectMetadata,
): boolean {
  return (
    typeof attachment.r2Key === "string" &&
    attachment.r2Key.length > 0 &&
    attachment.r2Key.length <= 1024 &&
    typeof attachment.fileName === "string" &&
    attachment.fileName.length > 0 &&
    attachment.fileName.length <= 1024 &&
    Number.isSafeInteger(attachment.sizeBytes) &&
    attachment.sizeBytes >= 0 &&
    typeof attachment.sha256 === "string" &&
    SHA256_HEX.test(attachment.sha256) &&
    object.key === attachment.r2Key &&
    object.size === attachment.sizeBytes &&
    typeof object.etag === "string" &&
    SAFE_TOKEN_TEXT.test(object.etag) &&
    typeof object.version === "string" &&
    SAFE_TOKEN_TEXT.test(object.version) &&
    object.customMetadata?.sha256 === attachment.sha256 &&
    sha256ChecksumHex(object.checksums?.sha256) === attachment.sha256
  );
}

export async function attachmentObjectDigest(input: {
  attachmentId: string;
  attachment: AttachmentDownloadRecord;
  object: AttachmentObjectMetadata;
}): Promise<string> {
  if (
    !validAttachmentId(input.attachmentId) ||
    !attachmentObjectMatches(input.attachment, input.object)
  ) throw new Error("attachment_object_metadata_invalid");

  const value = JSON.stringify([
    "27pm-attachment-object-v1",
    input.attachmentId,
    input.attachment.r2Key,
    safeAttachmentDisplayName(input.attachment.fileName),
    input.attachment.sizeBytes,
    input.attachment.sha256,
    input.object.key,
    input.object.size,
    input.object.etag,
    input.object.version,
  ]);
  return sha256Base64Url(value);
}

export async function attachmentDownloadReplayKey(nonce: string): Promise<string> {
  if (!validNonce(nonce)) throw new Error("attachment_download_nonce_invalid");
  return sha256Base64Url(`27pm-attachment-download-nonce-v1\u0000${nonce}`);
}

export function safeAttachmentContentDisposition(value: string): string {
  const fileName = safeAttachmentDisplayName(value);
  const fallback = fileName
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^\x20-\x7e]/gu, "_")
    .replace(/["\\/%;]/gu, "_")
    .trim()
    .slice(0, 180) || "attachment.bin";
  const encoded = encodeURIComponent(fileName)
    .replace(/[!'()*]/gu, (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function safeAttachmentDisplayName(value: string): string {
  const sanitized = (typeof value === "string" ? value : "")
    .normalize("NFKC")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu,
      "_",
    )
    .replace(/["/\\]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  return sanitized || "attachment.bin";
}

function sha256ChecksumHex(value: ArrayBuffer | undefined): string | null {
  if (!value || value.byteLength !== 32) return null;
  return Array.from(
    new Uint8Array(value),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

function validEncodedClaims(
  value: unknown,
  nowSeconds: number,
): value is EncodedAttachmentDownloadClaims {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claims = value as Partial<EncodedAttachmentDownloadClaims> &
    Record<string, unknown>;
  if (
    Object.keys(claims).toSorted().join(",") !==
      "aid,aud,exp,iat,mth,nonce,obj,ori,pth,v"
  ) return false;
  return (
    claims.v === 1 &&
    claims.aud === ATTACHMENT_DOWNLOAD_AUDIENCE &&
    canonicalAttachmentDownloadOrigin(claims.ori) === claims.ori &&
    claims.mth === "GET" &&
    typeof claims.aid === "string" &&
    validAttachmentId(claims.aid) &&
    claims.pth === attachmentDownloadPath(claims.aid) &&
    typeof claims.obj === "string" &&
    validDigest(claims.obj) &&
    typeof claims.iat === "number" &&
    Number.isSafeInteger(claims.iat) &&
    claims.iat >= 0 &&
    claims.iat <= nowSeconds + CLOCK_SKEW_SECONDS &&
    typeof claims.exp === "number" &&
    Number.isSafeInteger(claims.exp) &&
    claims.exp > nowSeconds &&
    claims.exp > claims.iat &&
    claims.exp - claims.iat <= ATTACHMENT_DOWNLOAD_MAX_TTL_SECONDS &&
    typeof claims.nonce === "string" &&
    validNonce(claims.nonce)
  );
}

function validVerificationContext(
  value: AttachmentDownloadVerificationContext,
): AttachmentDownloadVerificationContext | null {
  if (
    !value ||
    !validAttachmentId(value.attachmentId) ||
    canonicalAttachmentDownloadOrigin(value.origin) !== value.origin ||
    value.pathname !== attachmentDownloadPath(value.attachmentId)
  ) return null;
  return value;
}

function decodedClaims(
  claims: EncodedAttachmentDownloadClaims,
): AttachmentDownloadClaims {
  return {
    version: claims.v,
    audience: claims.aud,
    origin: claims.ori,
    method: claims.mth,
    pathname: claims.pth,
    attachmentId: claims.aid,
    objectDigest: claims.obj,
    issuedAt: claims.iat,
    expiresAt: claims.exp,
    nonce: claims.nonce,
  };
}

async function attachmentDownloadSigningKey(
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
    return decoded.byteLength >= 32 &&
      decoded.byteLength <= 96 &&
      encodeBase64Url(decoded) === value;
  } catch {
    return false;
  }
}

function validAttachmentId(value: unknown): value is string {
  return typeof value === "string" && ATTACHMENT_ID.test(value);
}

function validDigest(value: string): boolean {
  if (typeof value !== "string" || value.length !== 43 || !BASE64URL.test(value)) {
    return false;
  }
  try {
    const decoded = decodeBase64Url(value);
    return decoded.byteLength === 32 && encodeBase64Url(decoded) === value;
  } catch {
    return false;
  }
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
    return decoded.byteLength >= 16 &&
      decoded.byteLength <= 64 &&
      encodeBase64Url(decoded) === value;
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

async function sha256Base64Url(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return encodeBase64Url(new Uint8Array(digest));
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
