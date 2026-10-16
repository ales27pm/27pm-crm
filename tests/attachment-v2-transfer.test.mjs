import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createUpload, uploadStatus, getAttachment, deleteAttachment } from "../lib/attachment-v2-store.ts";
import { putUploadChunk, finishUpload, attachmentDownloadManifest, readAttachmentChunk } from "../lib/attachment-v2-transfer.ts";
import { sha256Hex, ATTACHMENT_CHUNK_BYTES } from "../lib/attachment-v2-protocol.ts";
const NOW = new Date("2026-10-16T17:00:00.000Z");
const IDENTITY = { creator: "operator@example.test", sessionId: "device-session-1" };
const error = (status, code) => e => e.status === status && e.code === code;
const body = bytes => new Response(bytes).body;
async function fixture(t) {
  const sql = new DatabaseSync(":memory:"); t.after(() => sql.close());
  sql.exec("PRAGMA foreign_keys=ON; CREATE TABLE organizations(id text PRIMARY KEY,deleted_at text); CREATE TABLE deals(id text PRIMARY KEY); CREATE TABLE conversations(id text PRIMARY KEY); INSERT INTO organizations VALUES ('account-1',NULL)");
  sql.exec(await readFile(new URL("../drizzle/0022_attachment_v2_uploads.sql", import.meta.url), "utf8"));
  const db = { async batch(statements) {
    sql.exec("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec("COMMIT"); return result; }
    catch (cause) { sql.exec("ROLLBACK"); throw cause; }
  }, prepare(query) { let args = []; const statement = sql.prepare(query); return {
    bind(...values) { args = values; return this; }, async first() { return statement.get(...args) ?? null; },
    async all() { return { success: true, results: statement.all(...args) }; },
    async run() { return { success: true, meta: { changes: Number(statement.run(...args).changes) } }; },
  }; } };
  const objects = new Map(); let version = 0;
  const meta = object => ({ key: object.key, size: object.bytes.length, version: object.version, etag: object.etag,
    checksums: { sha256: object.digest }, customMetadata: object.customMetadata });
  const bucket = {
    async put(key, value, options = {}) {
      if (objects.has(key) && options.onlyIf?.etagDoesNotMatch === "*") return null;
      const bytes = new Uint8Array(await new Response(value).arrayBuffer());
      const sha = await sha256Hex(bytes);
      if (options.sha256 !== sha) throw new Error("R2 checksum mismatch");
      const object = { key, bytes, version: `version-${++version}`, etag: `etag-${version}`,
        digest: await crypto.subtle.digest("SHA-256", bytes), customMetadata: options.customMetadata };
      objects.set(key, object); return meta(object);
    },
    async head(key) { const object = objects.get(key); return object ? meta(object) : null; },
    async get(key, options = {}) {
      const object = objects.get(key); if (!object) return null;
      if (options.onlyIf?.etagMatches && object.etag !== options.onlyIf.etagMatches) return meta(object);
      const data = options.range ? object.bytes.subarray(options.range.offset, options.range.offset + options.range.length) : object.bytes;
      return { ...meta(object), body: body(data) };
    },
  };
  return { db, sql, bucket, objects };
}
async function start(f, bytes = new TextEncoder().encode("hello"), changes = {}, key = "stable-key") {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
    const part = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    chunks.push({ byteSize: part.length, sha256: await sha256Hex(part) });
  }
  const manifest = { ownerKind: "account", ownerId: "account-1", fileName: "document.txt", contentType: "text/plain",
    byteSize: bytes.length, sha256: await sha256Hex(bytes), chunks, ...changes };
  const upload = await createUpload(f.db, manifest, IDENTITY, key, NOW);
  return { upload, manifest, bytes };
}
async function fill(f, input) {
  for (let index = 0; index < input.manifest.chunks.length; index++) {
    await putUploadChunk(f.db, f.bucket, input.upload.id, index,
      body(input.bytes.subarray(index * ATTACHMENT_CHUNK_BYTES, (index + 1) * ATTACHMENT_CHUNK_BYTES)), IDENTITY, NOW);
  }
}

test("20 MiB uploads use ten bounded raw requests and round-trip version-pinned private chunks", async t => {
  const f = await fixture(t), input = await start(f, new Uint8Array(20971520).fill(97));
  assert.equal(input.manifest.chunks.length, 10);
  await fill(f, input);
  const done = await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW);
  assert.equal(done.state, "committed");
  assert.equal(done.attachmentId, input.upload.id);
  const row = await getAttachment(f.db, done.attachmentId);
  assert.equal(row.created_by, IDENTITY.creator);
  const publicManifest = attachmentDownloadManifest(row);
  assert.equal(publicManifest.chunkBytes, 2097152);
  const downloaded = new Uint8Array(20971520);
  for (let index = 0; index < 10; index++) {
    const chunk = await readAttachmentChunk(f.bucket, row, index, row.object_version);
    assert.equal(chunk.byteSize, 2097152);
    assert.equal(chunk.objectVersion, row.object_version);
    downloaded.set(chunk.body, index * 2097152);
  }
  assert.equal(await sha256Hex(downloaded), input.manifest.sha256);
  assert.equal(f.objects.get(row.storage_key).customMetadata.scanStatus, "unscanned");
  assert.equal((await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW)).attachmentId, done.attachmentId);
});

test("chunks retry idempotently, reject mismatches, and remain private before completion", async t => {
  const f = await fixture(t), input = await start(f);
  await assert.rejects(putUploadChunk(f.db, f.bucket, input.upload.id, 0, body(new TextEncoder().encode("other")), IDENTITY, NOW), error(409, "attachment_chunk_integrity_failed"));
  await assert.rejects(putUploadChunk(f.db, f.bucket, input.upload.id, 0, body(new Uint8Array(6)), IDENTITY, NOW), error(413, "attachment_body_too_large"));
  await fill(f, input); await fill(f, input);
  assert.equal(f.objects.size, 1);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").get().n, 0);
  assert.deepEqual((await uploadStatus(f.db, input.upload.id, IDENTITY, NOW)).receivedChunks, [0]);
  await assert.rejects(putUploadChunk(f.db, f.bucket, input.upload.id, 1, body(input.bytes), IDENTITY, NOW), error(400, "attachment_chunk_invalid"));
});

test("partial upload cannot finalize; actual assembled full digest is independently checked", async t => {
  const f = await fixture(t), input = await start(f, new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1).fill(97), { sha256: "f".repeat(64) });
  await assert.rejects(finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW), error(409, "attachment_chunks_incomplete"));
  await fill(f, input);
  await assert.rejects(finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW), /checksum/u);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").get().n, 0);
  assert.equal((await uploadStatus(f.db, input.upload.id, IDENTITY, NOW)).state, "uploading");
});

test("concurrent completion deduplicates, and lost commit acknowledgement reconciles", async t => {
  const f = await fixture(t), input = await start(f); await fill(f, input);
  const statuses = await Promise.all([0, 1].map(() => finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW)));
  assert.ok(statuses.some(status => status.state === "committed"));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").get().n, 1);
  const other = await start(f, input.bytes, {}, "second-key"); await fill(f, other);
  assert.equal((await finishUpload(f.db, f.bucket, other.upload.id, IDENTITY, NOW)).attachmentId, input.upload.id);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").get().n, 1);
});

test("replacement/version drift, stale expected version and tombstone refuse chunk release", async t => {
  const f = await fixture(t), input = await start(f); await fill(f, input);
  const done = await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW);
  const row = await getAttachment(f.db, done.attachmentId);
  await assert.rejects(readAttachmentChunk(f.bucket, row, 0, "different-version"), error(409, "attachment_object_changed"));
  f.objects.get(row.storage_key).version = "replaced-version";
  await assert.rejects(readAttachmentChunk(f.bucket, row, 0, row.object_version), error(409, "attachment_object_changed"));
  await deleteAttachment(f.db, row.id, NOW);
  assert.equal(await getAttachment(f.db, row.id), null);
  assert.ok(f.objects.has(row.storage_key));
});

test("staging substitution and executable magic cannot publish an attachment", async t => {
  const f = await fixture(t), input = await start(f); await fill(f, input);
  const staged = f.objects.get(`attachments-v2/staging/${input.upload.id}/0`);
  staged.bytes = new TextEncoder().encode("wrong");
  await assert.rejects(finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW), /mismatch|changed/u);
  const executable = await start(f, new Uint8Array([0x4d, 0x5a, 1]), { fileName: "image.bin", contentType: "application/octet-stream" }, "executable-key");
  await assert.rejects(fill(f, executable), error(415, "attachment_media_type_rejected"));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").get().n, 0);
});

test("uncertain R2 writes reconcile immutable bytes on retry without deleting them", async t => {
  const f = await fixture(t), input = await start(f), originalPut = f.bucket.put;
  let loseChunkReply = true, loseObjectReply = true;
  f.bucket.put = async (key, value, options) => {
    const result = await originalPut(key, value, options);
    if (key.includes("/staging/") && loseChunkReply) { loseChunkReply = false; throw new Error("lost chunk reply"); }
    if (key.includes("/objects/") && loseObjectReply) { loseObjectReply = false; throw new Error("lost object reply"); }
    return result;
  };
  await assert.rejects(fill(f, input), /lost chunk reply/u);
  await fill(f, input);
  await assert.rejects(finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW), /lost object reply/u);
  assert.equal(f.objects.size, 2);
  assert.equal((await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW)).state, "committed");
  assert.equal(f.objects.size, 2);
});

test("uncertain D1 commit acknowledgement does not recreate or delete committed objects", async t => {
  const f = await fixture(t), input = await start(f); await fill(f, input);
  const batch = f.db.batch;
  let loseReply = true;
  f.db.batch = async statements => {
    const result = await batch(statements);
    if (loseReply) { loseReply = false; throw new Error("lost commit reply"); }
    return result;
  };
  await assert.rejects(finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW), /lost commit reply/u);
  const retry = await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW);
  assert.equal(retry.state, "committed");
  assert.equal(retry.attachmentId, input.upload.id);
  assert.equal(f.objects.size, 2);
});

test("a live finalization lease is not stolen and an expired lease can recover", async t => {
  const f = await fixture(t), input = await start(f); await fill(f, input);
  f.sql.prepare("UPDATE attachment_v2_uploads SET state='finalizing',lease_owner='other',lease_expires_at=? WHERE id=?")
    .run(new Date(NOW.getTime() + 1000).toISOString(), input.upload.id);
  assert.equal((await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW)).state, "finalizing");
  assert.equal(f.objects.size, 1);
  const after = new Date(NOW.getTime() + 1001);
  assert.equal((await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, after)).state, "committed");
});

test("Workers assembly selects FixedLengthStream and validates UTF-8 across chunk boundaries", async t => {
  const previous = globalThis.FixedLengthStream;
  const lengths = [];
  globalThis.FixedLengthStream = class {
    constructor(length) {
      lengths.push(length); let actual = 0;
      const stream = new TransformStream({
        transform(bytes, controller) { actual += bytes.length; assert.ok(actual <= length); controller.enqueue(bytes); },
        flush() { assert.equal(actual, length); },
      });
      this.readable = stream.readable; this.writable = stream.writable;
    }
  };
  t.after(() => { if (previous === undefined) delete globalThis.FixedLengthStream; else globalThis.FixedLengthStream = previous; });
  const bytes = new Uint8Array(ATTACHMENT_CHUNK_BYTES + 2).fill(97);
  bytes[ATTACHMENT_CHUNK_BYTES - 1] = 0xe2;
  bytes[ATTACHMENT_CHUNK_BYTES] = 0x82;
  bytes[ATTACHMENT_CHUNK_BYTES + 1] = 0xac;
  const f = await fixture(t), input = await start(f, bytes); await fill(f, input);
  assert.equal((await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW)).state, "committed");
  assert.deepEqual(lengths, [bytes.length]);
  const invalid = await start(f, new Uint8Array([0xc3, 0x28]), {}, "invalid-utf8"); await fill(f, invalid);
  await assert.rejects(finishUpload(f.db, f.bucket, invalid.upload.id, IDENTITY, NOW));
});

test("a body stalled beyond upload TTL cannot persist a late chunk", async t => {
  const f = await fixture(t), input = await start(f);
  let instant = NOW, controller;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const pending = putUploadChunk(f.db, f.bucket, input.upload.id, 0, stream, IDENTITY, () => instant);
  await new Promise(resolve => setImmediate(resolve));
  instant = new Date(NOW.getTime() + 3600001);
  controller.enqueue(input.bytes); controller.close();
  await assert.rejects(pending, error(410, "attachment_upload_expired"));
  assert.equal(f.objects.size, 0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_chunks").get().n, 0);
});

test("a final PUT stalled beyond its lease cannot publish object metadata or commit status", async t => {
  const f = await fixture(t), input = await start(f); await fill(f, input);
  const put = f.bucket.put; let instant = NOW;
  f.bucket.put = async (...args) => {
    const stored = await put(...args);
    if (args[0].includes("/objects/")) instant = new Date(NOW.getTime() + 120001);
    return stored;
  };
  await assert.rejects(finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, () => instant), error(409, "attachment_finalization_expired"));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").get().n, 0);
  assert.equal((await uploadStatus(f.db, input.upload.id, IDENTITY, instant)).state, "uploading");
  assert.ok(f.objects.has(`attachments-v2/objects/${input.upload.id}`));
  assert.equal((await finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, () => instant)).state, "committed");
});

test("owner deletion or session revocation during bytes I/O prevents publication/release", async t => {
  const f = await fixture(t), input = await start(f); await fill(f, input);
  const put = f.bucket.put;
  f.bucket.put = async (...args) => {
    const stored = await put(...args);
    if (args[0].includes("/objects/")) f.sql.prepare("UPDATE organizations SET deleted_at=? WHERE id='account-1'").run(NOW.toISOString());
    return stored;
  };
  await assert.rejects(finishUpload(f.db, f.bucket, input.upload.id, IDENTITY, NOW), error(404, "owner_not_found"));
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").get().n, 0);
  const fresh = await fixture(t), valid = await start(fresh); await fill(fresh, valid);
  const done = await finishUpload(fresh.db, fresh.bucket, valid.upload.id, IDENTITY, NOW);
  const row = await getAttachment(fresh.db, done.attachmentId);
  await assert.rejects(readAttachmentChunk(fresh.bucket, row, 0, row.object_version, async () => {
    throw Object.assign(new Error("revoked"), { status: 401, code: "mobile_session_invalid" });
  }), error(401, "mobile_session_invalid"));
});

test("live authorization callback rejects a session revoked while the upload body was pending", async t => {
  const f = await fixture(t), input = await start(f);
  let controller, revoked = false;
  const stream = new ReadableStream({ start(value) { controller = value; } });
  const authorization = async () => {
    if (revoked) throw Object.assign(new Error("revoked"), { status: 401, code: "mobile_session_invalid" });
  };
  const pending = putUploadChunk(f.db, f.bucket, input.upload.id, 0, stream, IDENTITY, NOW, authorization);
  await new Promise(resolve => setImmediate(resolve));
  revoked = true; controller.enqueue(input.bytes); controller.close();
  await assert.rejects(pending, error(401, "mobile_session_invalid"));
  assert.equal(f.objects.size, 0);
  assert.equal(f.sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_chunks").get().n, 0);
});
