import type { CrmDatabase } from "./d1";
import { AttachmentV2Error, attachmentClock, readBoundedBytes, sha256Hex, type AttachmentClockInput } from "./attachment-v2-protocol";

export const SCANNER_API_PREFIX = "/api/internal/attachment-scanner/";
export const SCANNER_MAX_JSON_BYTES = 16 * 1024;
const CLOCK_SKEW_SECONDS = 30;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const SECRET = /^[A-Za-z0-9_-]{43,128}$/u;
const NONCE = /^[A-Za-z0-9_-]{22,43}$/u;
const MAC = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export type ScannerCredentials = { keyId: string; scannerId: string; signingKey: string };
type Claims = { keyId: string; scannerId: string; timestamp: string; nonce: string; digest: string; mac: string };

function configured(value: ScannerCredentials): boolean {
  return ID.test(value.keyId) && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(value.scannerId) && SECRET.test(value.signingKey);
}
function b64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
function unb64(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/") + "="), x => x.charCodeAt(0));
}
function message(request: Request, c: Omit<Claims, "mac">): Uint8Array<ArrayBuffer> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith(SCANNER_API_PREFIX) || url.pathname.length > 512
    || url.pathname.includes("%") || !["GET", "POST"].includes(request.method)) {
    throw new AttachmentV2Error(401, "scanner_request_invalid");
  }
  // JSON arrays have an unambiguous encoding shared with the Python agent.
  return new TextEncoder().encode(JSON.stringify(["sc1", c.keyId, c.scannerId,
    request.method, url.pathname, url.search, c.timestamp, c.nonce, c.digest]));
}
async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Useful for clients and independent protocol vectors; never derives user identity. */
export async function createScannerAuthorization(
  credentials: ScannerCredentials, request: Request, body: Uint8Array,
  now = new Date(), nonce?: string,
): Promise<string> {
  if (!configured(credentials) || !Number.isFinite(now.valueOf())) throw new Error("scanner_configuration_invalid");
  const claims = { keyId: credentials.keyId, scannerId: credentials.scannerId,
    timestamp: String(Math.floor(now.valueOf() / 1000)),
    nonce: nonce ?? b64(crypto.getRandomValues(new Uint8Array(16))), digest: await sha256Hex(body) };
  if (!NONCE.test(claims.nonce)) throw new Error("scanner_nonce_invalid");
  const signature = await crypto.subtle.sign("HMAC", await key(credentials.signingKey), message(request, claims));
  return `Scanner sc1:${claims.keyId}:${claims.scannerId}:${claims.timestamp}:${claims.nonce}:${claims.digest}:${b64(new Uint8Array(signature))}`;
}

/** Authenticate bounded bytes, bind route/body, then consume a durable one-use nonce. */
export async function verifyScannerRequest(
  request: Request, credentials: ScannerCredentials, db: CrmDatabase, now: AttachmentClockInput = () => new Date(),
): Promise<{ scannerId: string; body: Uint8Array }> {
  const clock = attachmentClock(now);
  if (!configured(credentials)) throw new AttachmentV2Error(503, "scanner_authentication_unavailable");
  const header = request.headers.get("authorization") ?? "";
  if (header.length > 1024 || !header.startsWith("Scanner ")) throw new AttachmentV2Error(401, "scanner_authentication_required");
  const parts = header.slice(8).split(":");
  const [version, keyId, scannerId, timestamp, nonce, digest, mac] = parts;
  if (parts.length !== 7 || version !== "sc1" || !ID.test(keyId ?? "") || !ID.test(scannerId ?? "")
    || keyId !== credentials.keyId || scannerId !== credentials.scannerId
    || !/^[1-9][0-9]{8,11}$/u.test(timestamp ?? "") || !NONCE.test(nonce ?? "")
    || !DIGEST.test(digest ?? "") || !MAC.test(mac ?? "")
    || !Number.isFinite(clock().valueOf())
    || Math.abs(Number(timestamp) - Math.floor(clock().valueOf() / 1000)) > CLOCK_SKEW_SECONDS) {
    throw new AttachmentV2Error(401, "scanner_authentication_invalid");
  }
  if (request.headers.has("content-encoding") || request.headers.has("transfer-encoding")) {
    throw new AttachmentV2Error(400, "scanner_encoding_forbidden");
  }
  const claims = { keyId, scannerId, timestamp, nonce, digest };
  if (!await crypto.subtle.verify("HMAC", await key(credentials.signingKey), unb64(mac), message(request, claims))) {
    throw new AttachmentV2Error(401, "scanner_authentication_invalid");
  }
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener("abort", abort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(abort, 20_000);
  let body: Uint8Array;
  try { body = request.body ? await readBoundedBytes(request.body, SCANNER_MAX_JSON_BYTES, controller.signal) : new Uint8Array(); }
  finally { clearTimeout(timer); request.signal.removeEventListener("abort", abort); }
  if (await sha256Hex(body) !== digest) throw new AttachmentV2Error(401, "scanner_body_invalid");
  const checkedAt = clock();
  if (!Number.isFinite(checkedAt.valueOf()) || Math.abs(Number(timestamp) - Math.floor(checkedAt.valueOf() / 1000)) > CLOCK_SKEW_SECONDS) {
    throw new AttachmentV2Error(401, "scanner_request_expired");
  }
  const nonceKey = await sha256Hex(JSON.stringify([keyId, scannerId, nonce]));
  const consumed = await db.prepare(`INSERT INTO attachment_scanner_request_nonces (nonce, expires_at, created_at)
    VALUES (?, ?, ?) ON CONFLICT(nonce) DO NOTHING`).bind(nonceKey,
    Number(timestamp) + CLOCK_SKEW_SECONDS + 1, Math.floor(checkedAt.valueOf() / 1000)).run();
  if (!consumed.success || consumed.meta.changes !== 1) throw new AttachmentV2Error(401, "scanner_request_replayed");
  // Bound maintenance; do not retain nonce records forever or sweep other tables.
  await db.prepare(`DELETE FROM attachment_scanner_request_nonces WHERE nonce IN
    (SELECT nonce FROM attachment_scanner_request_nonces WHERE expires_at < ? LIMIT 100)`)
    .bind(Math.floor(clock().valueOf() / 1000)).run();
  if (Math.abs(Number(timestamp) - Math.floor(clock().valueOf() / 1000)) > CLOCK_SKEW_SECONDS) {
    throw new AttachmentV2Error(401, "scanner_request_expired");
  }
  return { scannerId, body };
}
