/**
 * Server-side credential storage only. Never expose this bucket namespace or
 * these helpers through attachment/file download APIs. No credentials go in D1.
 *
 * The caller owns OAuth expiry/consent checks and must reconcile ambiguous
 * storage failures before retrying a token rotation. Tombstones deliberately
 * retain an ETag: unconditional deletion could erase a concurrent authorization.
 */
export const EXCHANGE_VAULT_MAX_PAYLOAD_BYTES = 16 * 1_024;
export const EXCHANGE_VAULT_MAX_ENVELOPE_BYTES = 24 * 1_024;

export type ExchangeVaultJsonValue =
  | null | boolean | number | string
  | ExchangeVaultJsonValue[]
  | { [key: string]: ExchangeVaultJsonValue };
export type ExchangeVaultPayload = { [key: string]: ExchangeVaultJsonValue };

export interface ExchangeVaultConfig {
  tenantId: string;
  mailboxId: string;
  clientId: string;
  /** Canonical, unpadded base64url encoding of exactly 32 random bytes. */
  encryptionKey: string;
}

export interface ExchangeCredentialBucket {
  get(key: string): Promise<{
    etag: string;
    size: number;
    body: ReadableStream<Uint8Array>;
  } | null>;
  put(
    key: string,
    value: Uint8Array,
    options: {
      onlyIf: { etagDoesNotMatch: "*" } | { etagMatches: string };
      httpMetadata: { contentType: "application/json"; cacheControl: "no-store" };
    },
  ): Promise<{ etag: string } | null>;
}

type VaultErrorCode =
  | "exchange_vault_invalid_config"
  | "exchange_vault_invalid_payload"
  | "exchange_vault_invalid_credential"
  | "exchange_vault_invalid_precondition"
  | "exchange_vault_crypto_unavailable"
  | "exchange_vault_storage_unavailable"
  | "exchange_vault_conflict";

export class ExchangeVaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode) {
    super(code);
    this.name = "ExchangeVaultError";
    this.code = code;
  }
}

type StoredValue = { kind: "value"; payload: ExchangeVaultPayload } | { kind: "tombstone" };
type Context = { aad: Uint8Array<ArrayBuffer>; keyBytes: Uint8Array<ArrayBuffer> };
const encoder = new TextEncoder();
const GUID = /^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$/u;
const PURPOSE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RAW_ETAG = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const PREFIX = "_credentials/exchange/v1/";

/** Hash the context so object names never reveal OAuth state or mailbox IDs. */
export async function credentialObjectKey(config: ExchangeVaultConfig, purpose: string): Promise<string> {
  const context = validateContext(config, purpose);
  try {
    const digest = await crypto.subtle.digest("SHA-256", context.aad);
    return PREFIX + Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  } catch {
    throw new ExchangeVaultError("exchange_vault_crypto_unavailable");
  }
}

export async function sealExchangeCredential(
  config: ExchangeVaultConfig,
  purpose: string,
  payload: ExchangeVaultPayload,
): Promise<string> {
  const context = validateContext(config, purpose);
  validatePayload(payload);
  return sealRecord(context, { kind: "value", payload });
}

/** Returns null only for an authenticated encrypted tombstone. */
export async function openExchangeCredential(
  config: ExchangeVaultConfig,
  purpose: string,
  serialized: string,
): Promise<ExchangeVaultPayload | null> {
  const context = validateContext(config, purpose);
  try {
    if (typeof serialized !== "string" || serialized.length > EXCHANGE_VAULT_MAX_ENVELOPE_BYTES ||
      encoder.encode(serialized).byteLength > EXCHANGE_VAULT_MAX_ENVELOPE_BYTES) throw new Error();
    const envelope: unknown = JSON.parse(serialized);
    if (!isRecord(envelope) || !hasExactKeys(envelope, ["v", "alg", "nonce", "ciphertext"]) ||
      envelope.v !== 1 || envelope.alg !== "A256GCM" || JSON.stringify(envelope) !== serialized) throw new Error();
    const nonce = decodeBase64Url(envelope.nonce);
    const ciphertext = decodeBase64Url(envelope.ciphertext);
    if (nonce.byteLength !== 12 || ciphertext.byteLength < 16 ||
      ciphertext.byteLength > EXCHANGE_VAULT_MAX_PAYLOAD_BYTES + 128) throw new Error();
    const key = await crypto.subtle.importKey("raw", context.keyBytes, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: context.aad, tagLength: 128 }, key, ciphertext,
    );
    const record: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    if (!isRecord(record)) throw new Error();
    if (record.kind === "tombstone" && hasExactKeys(record, ["kind"])) return null;
    if (record.kind !== "value" || !hasExactKeys(record, ["kind", "payload"])) throw new Error();
    validatePayload(record.payload);
    return record.payload as ExchangeVaultPayload;
  } catch {
    // Deliberately suppress parser, crypto, and payload details (including cause).
    throw new ExchangeVaultError("exchange_vault_invalid_credential");
  }
}

/** Missing object => null. Consumed/revoked object => { payload: null, etag }. */
export async function readExchangeCredential(
  bucket: ExchangeCredentialBucket,
  config: ExchangeVaultConfig,
  purpose: string,
): Promise<{ payload: ExchangeVaultPayload | null; etag: string } | null> {
  const key = await credentialObjectKey(config, purpose);
  let object: Awaited<ReturnType<ExchangeCredentialBucket["get"]>>;
  try {
    object = await bucket.get(key);
  } catch {
    throw new ExchangeVaultError("exchange_vault_storage_unavailable");
  }
  if (object === null) return null;
  if (!object || !validEtag(object.etag) || !Number.isSafeInteger(object.size) ||
    object.size <= 0 || object.size > EXCHANGE_VAULT_MAX_ENVELOPE_BYTES ||
    !object.body || typeof object.body.getReader !== "function") {
    await cancelBody(object?.body);
    throw new ExchangeVaultError("exchange_vault_invalid_credential");
  }
  const serialized = await readBoundedBody(object.body, object.size);
  return { payload: await openExchangeCredential(config, purpose, serialized), etag: object.etag };
}

/** expectedEtag:null means create-only; a raw ETag means replace-only. */
export async function writeExchangeCredential(
  bucket: ExchangeCredentialBucket,
  config: ExchangeVaultConfig,
  purpose: string,
  payload: ExchangeVaultPayload,
  options: { expectedEtag: string | null },
): Promise<{ etag: string }> {
  const condition = writeCondition(options, true);
  const key = await credentialObjectKey(config, purpose);
  const sealed = await sealExchangeCredential(config, purpose, payload);
  return putConditional(bucket, key, sealed, condition);
}

/** One-time state consumption or credential revocation, without delete races. */
export async function tombstoneExchangeCredential(
  bucket: ExchangeCredentialBucket,
  config: ExchangeVaultConfig,
  purpose: string,
  options: { expectedEtag: string },
): Promise<{ etag: string }> {
  const condition = writeCondition(options, false);
  const key = await credentialObjectKey(config, purpose);
  const sealed = await sealRecord(validateContext(config, purpose), { kind: "tombstone" });
  return putConditional(bucket, key, sealed, condition);
}

function validateContext(config: ExchangeVaultConfig, purpose: string): Context {
  try {
    if (typeof window !== "undefined" || !config || !GUID.test(config.tenantId) ||
      !GUID.test(config.mailboxId) || !GUID.test(config.clientId) || typeof purpose !== "string" ||
      !PURPOSE.test(purpose)) throw new Error();
    const keyBytes = decodeBase64Url(config.encryptionKey);
    if (keyBytes.byteLength !== 32) throw new Error();
    return {
      keyBytes,
      aad: encoder.encode(JSON.stringify([
        "27pm-exchange-private-credential", 1, config.tenantId.toLowerCase(),
        config.mailboxId.toLowerCase(), config.clientId.toLowerCase(), purpose,
      ])),
    };
  } catch {
    throw new ExchangeVaultError("exchange_vault_invalid_config");
  }
}

function validatePayload(payload: unknown): asserts payload is ExchangeVaultPayload {
  try {
    if (!isRecord(payload)) throw new Error();
    const pending: { value: unknown; depth: number }[] = [{ value: payload, depth: 0 }];
    const seen = new Set<object>();
    let nodes = 0;
    let minimumBytes = 0;
    while (pending.length) {
      const { value, depth } = pending.pop()!;
      nodes += 1;
      if (nodes > 4_096 || depth > 12) throw new Error();
      if (value === null || typeof value === "boolean") continue;
      if (typeof value === "string") {
        if (value.length > EXCHANGE_VAULT_MAX_PAYLOAD_BYTES) throw new Error();
        minimumBytes += encoder.encode(value).byteLength;
        if (minimumBytes > EXCHANGE_VAULT_MAX_PAYLOAD_BYTES) throw new Error();
        continue;
      }
      if (typeof value === "number") {
        if (!Number.isFinite(value)) throw new Error();
        continue;
      }
      if (typeof value !== "object" || seen.has(value)) throw new Error();
      seen.add(value);
      const array = Array.isArray(value);
      if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isRecord(value)) throw new Error();
      const keys = Reflect.ownKeys(value);
      if (keys.length > (array ? 257 : 256)) throw new Error();
      if (array && (value.length > 256 || keys.length !== value.length + 1)) throw new Error();
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw new Error();
        if (key.length > EXCHANGE_VAULT_MAX_PAYLOAD_BYTES) throw new Error();
        minimumBytes += encoder.encode(key).byteLength;
        if (minimumBytes > EXCHANGE_VAULT_MAX_PAYLOAD_BYTES) throw new Error();
        if (array && (!/^(?:0|[1-9][0-9]*)$/u.test(key) || Number(key) >= value.length)) throw new Error();
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) throw new Error();
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    }
    if (encoder.encode(JSON.stringify(payload)).byteLength > EXCHANGE_VAULT_MAX_PAYLOAD_BYTES) throw new Error();
  } catch {
    throw new ExchangeVaultError("exchange_vault_invalid_payload");
  }
}

async function sealRecord(context: Context, record: StoredValue): Promise<string> {
  try {
    // Snapshot before the first await so callers cannot mutate validated data.
    const plaintext = encoder.encode(JSON.stringify(record));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const key = await crypto.subtle.importKey("raw", context.keyBytes, "AES-GCM", false, ["encrypt"]);
    const encrypted = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: context.aad, tagLength: 128 },
      key, plaintext,
    );
    return JSON.stringify({ v: 1, alg: "A256GCM", nonce: encodeBase64Url(nonce), ciphertext: encodeBase64Url(new Uint8Array(encrypted)) });
  } catch {
    throw new ExchangeVaultError("exchange_vault_crypto_unavailable");
  }
}

function writeCondition(options: { expectedEtag: string | null }, allowCreate: boolean): Parameters<ExchangeCredentialBucket["put"]>[2]["onlyIf"] {
  if (options && options.expectedEtag === null && allowCreate) return { etagDoesNotMatch: "*" };
  if (options && validEtag(options.expectedEtag)) return { etagMatches: options.expectedEtag };
  throw new ExchangeVaultError("exchange_vault_invalid_precondition");
}

async function putConditional(
  bucket: ExchangeCredentialBucket,
  key: string,
  sealed: string,
  condition: Parameters<ExchangeCredentialBucket["put"]>[2]["onlyIf"],
): Promise<{ etag: string }> {
  let result: Awaited<ReturnType<ExchangeCredentialBucket["put"]>>;
  try {
    result = await bucket.put(key, encoder.encode(sealed), {
      onlyIf: condition,
      httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
    });
  } catch {
    throw new ExchangeVaultError("exchange_vault_storage_unavailable");
  }
  if (result === null) throw new ExchangeVaultError("exchange_vault_conflict");
  if (!result || !validEtag(result.etag)) throw new ExchangeVaultError("exchange_vault_storage_unavailable");
  return { etag: result.etag };
}

async function readBoundedBody(body: ReadableStream<Uint8Array>, expectedSize: number): Promise<string> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = body.getReader();
  } catch {
    throw new ExchangeVaultError("exchange_vault_invalid_credential");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  let reads = 0;
  let finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) { finished = true; break; }
      reads += 1;
      if (!(value instanceof Uint8Array)) throw new Error();
      total += value.byteLength;
      if (reads > 256 || total > expectedSize || total > EXCHANGE_VAULT_MAX_ENVELOPE_BYTES) throw new Error();
      chunks.push(value);
    }
    if (total !== expectedSize) throw new Error();
    const bytes = new Uint8Array(total);
    let position = 0;
    for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ExchangeVaultError("exchange_vault_invalid_credential");
  } finally {
    if (!finished) {
      try { await reader.cancel(); } catch { /* Never propagate stream/provider errors. */ }
    }
    try { reader.releaseLock(); } catch { /* Do not expose provider stream details. */ }
  }
}

async function cancelBody(body: ReadableStream<Uint8Array> | undefined): Promise<void> {
  try { await body?.cancel(); } catch { /* Metadata rejection must not leak stream errors. */ }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function validEtag(value: unknown): value is string {
  return typeof value === "string" && RAW_ETAG.test(value);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: unknown): Uint8Array<ArrayBuffer> {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value) || value.length % 4 === 1 ||
    value.length > EXCHANGE_VAULT_MAX_ENVELOPE_BYTES) throw new Error();
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + "=".repeat((4 - value.length % 4) % 4));
  const decoded = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) decoded[index] = binary.charCodeAt(index);
  if (encodeBase64Url(decoded) !== value) throw new Error();
  return decoded;
}
