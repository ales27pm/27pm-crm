import assert from "node:assert/strict";
import { createDecipheriv, createHash } from "node:crypto";
import test from "node:test";

import {
  EXCHANGE_VAULT_MAX_ENVELOPE_BYTES,
  EXCHANGE_VAULT_MAX_PAYLOAD_BYTES,
  ExchangeVaultError,
  credentialObjectKey,
  openExchangeCredential,
  readExchangeCredential,
  sealExchangeCredential,
  tombstoneExchangeCredential,
  writeExchangeCredential,
} from "../lib/exchange-token-vault.ts";

const CONFIG = {
  tenantId: "11111111-2222-3333-4444-555555555555",
  mailboxId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  clientId: "01234567-89ab-cdef-0123-456789abcdef",
  encryptionKey: Buffer.alloc(32, 49).toString("base64url"),
};
const PURPOSE = "refresh-token";
const PAYLOAD = { refreshToken: "unit-test-only-refresh-secret", generation: 2 };

function isVaultError(code) {
  return (error) => {
    assert.ok(error instanceof ExchangeVaultError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.equal(error.cause, undefined);
    return true;
  };
}

function makeBucket() {
  const state = { entries: new Map(), puts: [], gets: [], generation: 0 };
  const bucket = {
    async get(key) {
      state.gets.push(key);
      const entry = state.entries.get(key);
      if (!entry) return null;
      return {
        etag: entry.etag,
        size: entry.bytes.byteLength,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(entry.bytes);
            controller.close();
          },
        }),
      };
    },
    async put(key, bytes, options) {
      state.puts.push({ key, bytes: bytes.slice(), options });
      const current = state.entries.get(key);
      const condition = options.onlyIf;
      if (condition.etagDoesNotMatch === "*" && current) return null;
      if (condition.etagMatches && current?.etag !== condition.etagMatches) return null;
      state.generation += 1;
      const etag = createHash("md5").update(bytes).update(String(state.generation)).digest("hex");
      state.entries.set(key, { bytes: bytes.slice(), etag });
      return { etag };
    },
  };
  return { bucket, state };
}

test("vault seals using AES-256-GCM with an independent AAD verification", async () => {
  const sealed = await sealExchangeCredential(CONFIG, PURPOSE, PAYLOAD);
  const envelope = JSON.parse(sealed);
  assert.deepEqual(Object.keys(envelope).sort(), ["alg", "ciphertext", "nonce", "v"]);
  assert.equal(envelope.v, 1);
  assert.equal(envelope.alg, "A256GCM");
  assert.equal(Buffer.from(envelope.nonce, "base64url").length, 12);
  assert.equal(sealed.includes(PAYLOAD.refreshToken), false);
  assert.equal(sealed.includes(CONFIG.encryptionKey), false);
  assert.equal(sealed.includes(CONFIG.mailboxId), false);

  const encrypted = Buffer.from(envelope.ciphertext, "base64url");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(CONFIG.encryptionKey, "base64url"), Buffer.from(envelope.nonce, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify([
    "27pm-exchange-private-credential", 1, CONFIG.tenantId, CONFIG.mailboxId, CONFIG.clientId, PURPOSE,
  ])));
  decipher.setAuthTag(encrypted.subarray(-16));
  const decoded = JSON.parse(Buffer.concat([decipher.update(encrypted.subarray(0, -16)), decipher.final()]).toString());
  assert.deepEqual(decoded, { kind: "value", payload: PAYLOAD });
  assert.deepEqual(await openExchangeCredential(CONFIG, PURPOSE, sealed), PAYLOAD);
});

test("vault uses a fresh nonce for every encryption", async () => {
  const first = await sealExchangeCredential(CONFIG, PURPOSE, PAYLOAD);
  const second = await sealExchangeCredential(CONFIG, PURPOSE, PAYLOAD);
  assert.notEqual(JSON.parse(first).nonce, JSON.parse(second).nonce);
  assert.notEqual(first, second);
});

test("sealing snapshots validated payload before asynchronous cryptography", async () => {
  const mutable = { token: "original" };
  const pending = sealExchangeCredential(CONFIG, PURPOSE, mutable);
  mutable.token = "modified".repeat(EXCHANGE_VAULT_MAX_PAYLOAD_BYTES);
  assert.deepEqual(await openExchangeCredential(CONFIG, PURPOSE, await pending), { token: "original" });
});

test("credential object keys are deterministic, context-bound, and secret-free", async () => {
  const key = await credentialObjectKey(CONFIG, PURPOSE);
  assert.match(key, /^_credentials\/exchange\/v1\/[a-f0-9]{64}$/u);
  assert.equal(key, await credentialObjectKey({ ...CONFIG, mailboxId: CONFIG.mailboxId.toUpperCase() }, PURPOSE));
  assert.equal(key, await credentialObjectKey({ ...CONFIG, encryptionKey: Buffer.alloc(32, 2).toString("base64url") }, PURPOSE));
  for (const [config, purpose] of [
    [{ ...CONFIG, tenantId: "99999999-2222-3333-4444-555555555555" }, PURPOSE],
    [{ ...CONFIG, mailboxId: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee" }, PURPOSE],
    [{ ...CONFIG, clientId: "99999999-89ab-cdef-0123-456789abcdef" }, PURPOSE],
    [CONFIG, "oauth-state:opaque-state-value"],
  ]) assert.notEqual(key, await credentialObjectKey(config, purpose));
});

test("decryption rejects wrong key, tenant, mailbox, client, and purpose", async () => {
  const sealed = await sealExchangeCredential(CONFIG, PURPOSE, PAYLOAD);
  for (const [config, purpose] of [
    [{ ...CONFIG, encryptionKey: Buffer.alloc(32, 2).toString("base64url") }, PURPOSE],
    [{ ...CONFIG, tenantId: "99999999-2222-3333-4444-555555555555" }, PURPOSE],
    [{ ...CONFIG, mailboxId: "99999999-bbbb-cccc-dddd-eeeeeeeeeeee" }, PURPOSE],
    [{ ...CONFIG, clientId: "99999999-89ab-cdef-0123-456789abcdef" }, PURPOSE],
    [CONFIG, "oauth-state:test"],
  ]) await assert.rejects(openExchangeCredential(config, purpose, sealed), isVaultError("exchange_vault_invalid_credential"));
});

test("envelopes reject ciphertext, nonce, version, algorithm, and extra-field tampering", async () => {
  const sealed = await sealExchangeCredential(CONFIG, PURPOSE, PAYLOAD);
  const envelope = JSON.parse(sealed);
  const corrupted = Buffer.from(envelope.ciphertext, "base64url");
  corrupted[0] ^= 1;
  for (const candidate of [
    { ...envelope, ciphertext: corrupted.toString("base64url") },
    { ...envelope, nonce: Buffer.alloc(12, 0).toString("base64url") },
    { ...envelope, nonce: Buffer.alloc(11, 0).toString("base64url") },
    { ...envelope, v: 2 },
    { ...envelope, alg: "AES-CBC" },
    { ...envelope, additional: "ignored?" },
    { ...envelope, ciphertext: `${envelope.ciphertext}=` },
    { ...envelope, ciphertext: "a" },
    { ...envelope, nonce: `${envelope.nonce}=` },
    [], null,
  ]) await assert.rejects(openExchangeCredential(CONFIG, PURPOSE, JSON.stringify(candidate)), isVaultError("exchange_vault_invalid_credential"));
  for (const candidate of ["not JSON", `${sealed.slice(0, -1)},\"v\":1}`, ` ${sealed}`]) {
    await assert.rejects(openExchangeCredential(CONFIG, PURPOSE, candidate), isVaultError("exchange_vault_invalid_credential"));
  }
});

test("configuration requires GUID-bound identities and a canonical 32-byte key", async () => {
  for (const config of [
    { ...CONFIG, tenantId: "common" },
    { ...CONFIG, mailboxId: "alexis@example.test" },
    { ...CONFIG, clientId: "../../escape" },
    { ...CONFIG, encryptionKey: "short" },
    { ...CONFIG, encryptionKey: Buffer.alloc(31, 2).toString("base64url") },
    { ...CONFIG, encryptionKey: `${CONFIG.encryptionKey}=` },
    { ...CONFIG, encryptionKey: ` ${CONFIG.encryptionKey}` },
    null,
  ]) await assert.rejects(sealExchangeCredential(config, PURPOSE, PAYLOAD), isVaultError("exchange_vault_invalid_config"));
  for (const purpose of ["", "../escape", "/root", "token\n", "a".repeat(129), null]) {
    await assert.rejects(sealExchangeCredential(CONFIG, purpose, PAYLOAD), isVaultError("exchange_vault_invalid_config"));
  }
});

test("payloads accept nested JSON but reject lossy, cyclic, inherited, and excessive structures", async () => {
  const accepted = { nullValue: null, list: [1, true, "é"], nested: { ok: false } };
  assert.deepEqual(await openExchangeCredential(CONFIG, PURPOSE, await sealExchangeCredential(CONFIG, PURPOSE, accepted)), accepted);
  const cycle = {}; cycle.self = cycle;
  const deep = {}; let current = deep;
  for (let index = 0; index < 20; index += 1) { current.next = {}; current = current.next; }
  let getterCalls = 0;
  const accessor = Object.defineProperty({}, "secret", { enumerable: true, get() { getterCalls += 1; return "bad"; } });
  for (const payload of [
    null, [], "token", { lost: undefined }, { lost: () => {} }, { lost: Symbol("x") },
    { lost: BigInt(1) }, { lost: NaN }, { lost: Infinity }, { date: new Date() },
    { bytes: new Uint8Array([1]) }, Object.create({ inherited: true }), cycle, deep, accessor,
    JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: {} }, { prototype: {} },
    { sparse: new Array(2) }, { hugeList: new Array(300).fill(0) },
  ]) await assert.rejects(sealExchangeCredential(CONFIG, PURPOSE, payload), isVaultError("exchange_vault_invalid_payload"));
  assert.equal(getterCalls, 0);
});

test("payload and envelope limits count UTF-8 bytes and reject oversized input", async () => {
  const maximumPayload = { token: "x".repeat(EXCHANGE_VAULT_MAX_PAYLOAD_BYTES - 12) };
  assert.equal(Buffer.byteLength(JSON.stringify(maximumPayload)), EXCHANGE_VAULT_MAX_PAYLOAD_BYTES);
  assert.deepEqual(await openExchangeCredential(CONFIG, PURPOSE, await sealExchangeCredential(CONFIG, PURPOSE, maximumPayload)), maximumPayload);
  for (const payload of [{ token: `${maximumPayload.token}x` }, { token: "é".repeat(EXCHANGE_VAULT_MAX_PAYLOAD_BYTES / 2) }]) {
    await assert.rejects(sealExchangeCredential(CONFIG, PURPOSE, payload), isVaultError("exchange_vault_invalid_payload"));
  }
  await assert.rejects(openExchangeCredential(CONFIG, PURPOSE, " ".repeat(EXCHANGE_VAULT_MAX_ENVELOPE_BYTES + 1)), isVaultError("exchange_vault_invalid_credential"));
});

test("private R2 writes are conditional, encrypted, and read back with raw ETags", async () => {
  const { bucket, state } = makeBucket();
  assert.equal(await readExchangeCredential(bucket, CONFIG, PURPOSE), null);
  const created = await writeExchangeCredential(bucket, CONFIG, PURPOSE, PAYLOAD, { expectedEtag: null });
  assert.match(created.etag, /^[a-f0-9]{32}$/u);
  assert.deepEqual(state.puts[0].options, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });
  assert.equal(new TextDecoder().decode(state.puts[0].bytes).includes(PAYLOAD.refreshToken), false);
  assert.deepEqual(await readExchangeCredential(bucket, CONFIG, PURPOSE), { payload: PAYLOAD, etag: created.etag });
  const refreshed = { ...PAYLOAD, refreshToken: "unit-test-only-rotated-secret" };
  const replaced = await writeExchangeCredential(bucket, CONFIG, PURPOSE, refreshed, { expectedEtag: created.etag });
  assert.deepEqual(state.puts[1].options.onlyIf, { etagMatches: created.etag });
  assert.notEqual(replaced.etag, created.etag);
  assert.deepEqual(await readExchangeCredential(bucket, CONFIG, PURPOSE), { payload: refreshed, etag: replaced.etag });
});

test("create and stale update conflicts cannot overwrite the winning refresh token", async () => {
  const { bucket } = makeBucket();
  const initial = await writeExchangeCredential(bucket, CONFIG, PURPOSE, PAYLOAD, { expectedEtag: null });
  await assert.rejects(writeExchangeCredential(bucket, CONFIG, PURPOSE, { token: "duplicate" }, { expectedEtag: null }), isVaultError("exchange_vault_conflict"));
  const results = await Promise.allSettled([
    writeExchangeCredential(bucket, CONFIG, PURPOSE, { token: "first" }, { expectedEtag: initial.etag }),
    writeExchangeCredential(bucket, CONFIG, PURPOSE, { token: "second" }, { expectedEtag: initial.etag }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.code, "exchange_vault_conflict");
  const stored = await readExchangeCredential(bucket, CONFIG, PURPOSE);
  assert.deepEqual(stored.payload, results[0].status === "fulfilled" ? { token: "first" } : { token: "second" });
});

test("OAuth state consumption uses a conditional encrypted tombstone, never deletion", async () => {
  const { bucket, state } = makeBucket();
  const purpose = "oauth-state:unit-test-random-state";
  const payload = { verifier: "private-pkce-verifier", expiresAt: 1780000000 };
  const created = await writeExchangeCredential(bucket, CONFIG, purpose, payload, { expectedEtag: null });
  const consumed = await tombstoneExchangeCredential(bucket, CONFIG, purpose, { expectedEtag: created.etag });
  assert.deepEqual(state.puts[1].options.onlyIf, { etagMatches: created.etag });
  assert.deepEqual(await readExchangeCredential(bucket, CONFIG, purpose), { payload: null, etag: consumed.etag });
  assert.equal(await openExchangeCredential(CONFIG, purpose, new TextDecoder().decode(state.puts[1].bytes)), null);
  await assert.rejects(tombstoneExchangeCredential(bucket, CONFIG, purpose, { expectedEtag: created.etag }), isVaultError("exchange_vault_conflict"));
  await assert.rejects(writeExchangeCredential(bucket, CONFIG, purpose, payload, { expectedEtag: null }), isVaultError("exchange_vault_conflict"));
  const reauthorized = await writeExchangeCredential(bucket, CONFIG, purpose, payload, { expectedEtag: consumed.etag });
  assert.deepEqual(await readExchangeCredential(bucket, CONFIG, purpose), { payload, etag: reauthorized.etag });
});

test("invalid, quoted, wildcard, or omitted ETags never trigger an unconditional write", async () => {
  const { bucket, state } = makeBucket();
  for (const options of [undefined, {}, { expectedEtag: "" }, { expectedEtag: '"etag"' }, { expectedEtag: "*" }, { expectedEtag: "etag\n" }]) {
    await assert.rejects(writeExchangeCredential(bucket, CONFIG, PURPOSE, PAYLOAD, options), isVaultError("exchange_vault_invalid_precondition"));
  }
  await assert.rejects(tombstoneExchangeCredential(bucket, CONFIG, PURPOSE, { expectedEtag: null }), isVaultError("exchange_vault_invalid_precondition"));
  assert.equal(state.puts.length, 0);
});

test("oversized R2 metadata and streamed bodies are rejected and canceled before full consumption", async () => {
  let consumed = 0; let canceled = false;
  const body = new ReadableStream({
    pull(controller) { consumed += 1; controller.enqueue(new Uint8Array(8192)); },
    cancel() { canceled = true; },
  });
  const bucket = { async get() { return { size: 1, etag: "valid-etag", body }; } };
  await assert.rejects(readExchangeCredential(bucket, CONFIG, PURPOSE), isVaultError("exchange_vault_invalid_credential"));
  assert.ok(consumed <= 5);
  assert.equal(canceled, true);
  let oversizedCanceled = false;
  const oversized = { async get() { return { size: EXCHANGE_VAULT_MAX_ENVELOPE_BYTES + 1, etag: "valid-etag", body: new ReadableStream({ cancel() { oversizedCanceled = true; } }) }; } };
  await assert.rejects(readExchangeCredential(oversized, CONFIG, PURPOSE), isVaultError("exchange_vault_invalid_credential"));
  assert.equal(oversizedCanceled, true);
});

test("storage exceptions and malformed metadata expose no provider or token details", async () => {
  const sensitive = "provider-error-with-private-token-value";
  const failing = { async get() { throw new Error(sensitive); }, async put() { throw new Error(sensitive); } };
  await assert.rejects(readExchangeCredential(failing, CONFIG, PURPOSE), isVaultError("exchange_vault_storage_unavailable"));
  await assert.rejects(writeExchangeCredential(failing, CONFIG, PURPOSE, PAYLOAD, { expectedEtag: null }), isVaultError("exchange_vault_storage_unavailable"));
  const badResult = { async put() { return { etag: '"quoted"' }; } };
  await assert.rejects(writeExchangeCredential(badResult, CONFIG, PURPOSE, PAYLOAD, { expectedEtag: null }), isVaultError("exchange_vault_storage_unavailable"));
  const missingBody = { async get() { return { size: 12, etag: "valid-etag" }; } };
  await assert.rejects(readExchangeCredential(missingBody, CONFIG, PURPOSE), isVaultError("exchange_vault_invalid_credential"));
});

test("empty-chunk loops, locked bodies, truncated bodies, and invalid UTF-8 fail closed", async () => {
  let emptyReads = 0; let canceled = false;
  const empty = new ReadableStream({
    pull(controller) { emptyReads += 1; controller.enqueue(new Uint8Array(0)); },
    cancel() { canceled = true; },
  });
  await assert.rejects(readExchangeCredential({ async get() { return { etag: "valid", size: 20, body: empty }; } }, CONFIG, PURPOSE), isVaultError("exchange_vault_invalid_credential"));
  assert.ok(emptyReads <= 258);
  assert.equal(canceled, true);
  const locked = new ReadableStream();
  const lock = locked.getReader();
  await assert.rejects(readExchangeCredential({ async get() { return { etag: "valid", size: 20, body: locked }; } }, CONFIG, PURPOSE), isVaultError("exchange_vault_invalid_credential"));
  lock.releaseLock();
  for (const [bytes, size] of [[new Uint8Array([123, 125]), 3], [new Uint8Array([255]), 1]]) {
    const body = new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } });
    await assert.rejects(readExchangeCredential({ async get() { return { etag: "valid", size, body }; } }, CONFIG, PURPOSE), isVaultError("exchange_vault_invalid_credential"));
  }
});

test("browser-context use is rejected before accessing the credential bucket", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
  try {
    const { bucket, state } = makeBucket();
    await assert.rejects(readExchangeCredential(bucket, CONFIG, PURPOSE), isVaultError("exchange_vault_invalid_config"));
    assert.equal(state.gets.length, 0);
  } finally {
    if (original) Object.defineProperty(globalThis, "window", original);
    else delete globalThis.window;
  }
});
