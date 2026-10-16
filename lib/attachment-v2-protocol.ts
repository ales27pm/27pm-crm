/** Versioned attachment wire contract. No runtime activation or credentials here. */
export const ATTACHMENT_TRANSPORT = "chunked-v2";
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const ATTACHMENT_CHUNK_BYTES = 2 * 1024 * 1024;
export const MAX_ATTACHMENT_CHUNKS = 10;
export const ATTACHMENT_SCAN_POLICY = "sha256-bound-r2-pull-v2";
export const SCAN_PROTOCOL = "crm-clamav-v1";
export const SCAN_RECEIPT_MAX_BYTES = 4096;
export const SCAN_VERDICT_TTL_MS = 24 * 60 * 60 * 1000;
export const SCAN_SIGNATURE_MAX_AGE_MS = 72 * 60 * 60 * 1000;

export type AttachmentClockInput = Date | (() => Date);
/** A Date is a deterministic anchor, not permission to freeze time across I/O. */
export function attachmentClock(input: AttachmentClockInput = () => new Date()): () => Date {
  if (typeof input === "function") return input;
  const anchor = input.valueOf(), started = performance.now();
  return () => new Date(anchor + Math.max(0, performance.now() - started));
}

export type AttachmentObjectRow = {
  id: string;
  owner_kind: "account" | "deal" | "conversation";
  owner_id: string;
  file_name: string;
  content_type: string;
  byte_size: number;
  sha256: string;
  storage_key: string;
  object_version: string;
  created_by: string;
  created_at: string;
  deleted_at: string | null;
};

export type ScanVerdict = {
  protocol: typeof SCAN_PROTOCOL;
  status: "clean" | "infected";
  sha256: string;
  byteSize: number;
  engineVersion: string;
  signatureVersion: string;
  signatureUpdatedAt: string;
  scannedAt: string;
};

export class AttachmentV2Error extends Error {
  constructor(public readonly status: number, public readonly code: string) {
    super(code);
  }
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}
export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}
export function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export async function sha256Hex(value: ArrayBuffer | Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value)
    : value instanceof Uint8Array ? new Uint8Array(value) : new Uint8Array(value);
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

/** Count actual bytes before parsing/buffering, cancel an over-limit source. */
export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!body || !Number.isSafeInteger(limit) || limit < 0) {
    throw new AttachmentV2Error(400, "attachment_body_missing");
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal?.aborted) throw new AttachmentV2Error(408, "attachment_body_timeout");
      const item = await reader.read();
      if (signal?.aborted) throw new AttachmentV2Error(408, "attachment_body_timeout");
      if (item.done) break;
      size += item.value.byteLength;
      if (size > limit) throw new AttachmentV2Error(413, "attachment_body_too_large");
      chunks.push(item.value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } catch (error) {
    // An untrusted source's cancellation promise can itself never settle.
    // Cancellation closes the reader; don't await caller-controlled cleanup.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export function isoTime(value: unknown): number {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)
    ? Date.parse(value) : NaN;
}

/** A definitive, recent engine reply bound to exactly the submitted bytes. */
export function validScanVerdict(
  value: unknown, sha256: string, byteSize: number, now: number = Date.now(),
): value is ScanVerdict {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const v = value as Partial<ScanVerdict>;
  const scanned = isoTime(v.scannedAt), updated = isoTime(v.signatureUpdatedAt);
  return v.protocol === SCAN_PROTOCOL && (v.status === "clean" || v.status === "infected")
    && isSha256(sha256) && v.sha256 === sha256
    && Number.isSafeInteger(byteSize) && byteSize > 0 && byteSize <= MAX_ATTACHMENT_BYTES && v.byteSize === byteSize
    && typeof v.engineVersion === "string" && /^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?$/u.test(v.engineVersion)
    && typeof v.signatureVersion === "string" && /^[0-9]{1,12}$/u.test(v.signatureVersion)
    && Number.isFinite(now) && Number.isFinite(scanned) && Number.isFinite(updated)
    && scanned <= now + 30_000 && scanned >= now - SCAN_VERDICT_TTL_MS
    && updated <= scanned + 30_000 && updated >= scanned - SCAN_SIGNATURE_MAX_AGE_MS
    && updated >= now - SCAN_SIGNATURE_MAX_AGE_MS;
}

export function projectScanVerdict(v: ScanVerdict): ScanVerdict {
  return { protocol: v.protocol, status: v.status, sha256: v.sha256, byteSize: v.byteSize,
    engineVersion: v.engineVersion, signatureVersion: v.signatureVersion,
    signatureUpdatedAt: v.signatureUpdatedAt, scannedAt: v.scannedAt };
}

export function attachmentV2ErrorResponse(error: unknown): Response {
  const known = error instanceof AttachmentV2Error;
  return Response.json({ error: known ? error.code : "attachment_storage_unavailable" }, {
    status: known ? error.status : 503,
    headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff", ...(!known || error.status === 423 ? { "retry-after": "30" } : {}) },
  });
}
