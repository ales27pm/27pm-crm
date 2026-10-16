import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createUpload, uploadStatus, validateAttachmentManifest, listAttachments, deleteAttachment } from "../lib/attachment-v2-store.ts";
import { sha256Hex, ATTACHMENT_CHUNK_BYTES } from "../lib/attachment-v2-protocol.ts";

const NOW = new Date("2026-10-16T17:00:00.000Z");
const IDENTITY = { creator: "operator@example.test", sessionId: "device-session-1" };
async function fixture(t) {
  const sql = new DatabaseSync(":memory:");
  t.after(() => sql.close());
  sql.exec("PRAGMA foreign_keys=ON; CREATE TABLE organizations(id text PRIMARY KEY,deleted_at text); CREATE TABLE deals(id text PRIMARY KEY); CREATE TABLE conversations(id text PRIMARY KEY); INSERT INTO organizations VALUES ('account-1',NULL)");
  sql.exec(await readFile(new URL("../drizzle/0022_attachment_v2_uploads.sql", import.meta.url), "utf8"));
  const db = { async batch(statements) {
    sql.exec("BEGIN");
    try { const result = []; for (const statement of statements) result.push(await statement.run()); sql.exec("COMMIT"); return result; }
    catch (cause) { sql.exec("ROLLBACK"); throw cause; }
  }, prepare(query) { let args = []; const statement = sql.prepare(query); return {
    bind(...values) { args = values; return this; },
    async first() { return statement.get(...args) ?? null; },
    async all() { return { success: true, results: statement.all(...args) }; },
    async run() { return { success: true, meta: { changes: Number(statement.run(...args).changes) } }; },
  }; } };
  return { sql, db };
}
async function manifest(bytes = new TextEncoder().encode("hello")) {
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += ATTACHMENT_CHUNK_BYTES) {
    const part = bytes.subarray(offset, offset + ATTACHMENT_CHUNK_BYTES);
    chunks.push({ byteSize: part.length, sha256: await sha256Hex(part) });
  }
  return { ownerKind: "account", ownerId: "account-1", fileName: "document.txt", contentType: "text/plain",
    byteSize: bytes.length, sha256: await sha256Hex(bytes), chunks };
}
const error = (status, code) => e => e.status === status && e.code === code;

test("manifest fixes raw chunk size, exact arithmetic and safe allowed metadata", async () => {
  const valid = await manifest(new Uint8Array(ATTACHMENT_CHUNK_BYTES + 1).fill(97));
  assert.equal(validateAttachmentManifest(valid).chunks[1].byteSize, 1);
  for (const invalid of [
    { ...valid, extra: true }, { ...valid, byteSize: 20971521 }, { ...valid, byteSize: 0 },
    { ...valid, chunks: [valid.chunks[0]] }, { ...valid, chunks: [{ ...valid.chunks[0], byteSize: 1 }, valid.chunks[1]] },
    { ...valid, fileName: "../secret.txt" }, { ...valid, fileName: "payload.exe" },
    { ...valid, fileName: "x.txt\r\nheader" }, { ...valid, sha256: "A".repeat(64) },
    { ...valid, contentType: "text/html" }, { ...valid, ownerKind: "__proto__" },
    { ...valid, chunks: [{ ...valid.chunks[0], other: true }, valid.chunks[1]] },
  ]) assert.throws(() => validateAttachmentManifest(invalid), error(400, "attachment_validation_failed"));
});

test("create upload persists identity-scoped idempotency without exposing private keys", async t => {
  const { db, sql } = await fixture(t), input = await manifest();
  const first = await createUpload(db, input, IDENTITY, "stable-key-1", NOW);
  const retry = await createUpload(db, input, IDENTITY, "stable-key-1", NOW);
  assert.deepEqual(retry, first);
  assert.equal(first.chunkBytes, 2097152);
  assert.equal(first.state, "uploading");
  assert.deepEqual(first.receivedChunks, []);
  assert.equal(first.attachmentId, null);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_uploads").get().n, 1);
  assert.doesNotMatch(JSON.stringify(first), /storage_key|creator|session_id|manifest_json/u);
  await assert.rejects(createUpload(db, { ...input, fileName: "other.txt" }, IDENTITY, "stable-key-1", NOW), error(409, "attachment_idempotency_conflict"));
  const other = await createUpload(db, input, { ...IDENTITY, sessionId: "other-session" }, "stable-key-1", NOW);
  assert.notEqual(other.id, first.id);
  await assert.rejects(uploadStatus(db, first.id, { ...IDENTITY, sessionId: "other-session" }, NOW), error(404, "attachment_upload_not_found"));
});

test("atomic creation enforces per-creator concurrent reservations across device sessions", async t => {
  const { db, sql } = await fixture(t), input = await manifest();
  const result = await Promise.allSettled([0, 1, 2, 3].map(i => createUpload(db, input,
    { ...IDENTITY, sessionId: `session-${i}` }, `quota-key-${i}`, NOW)));
  assert.equal(result.filter(r => r.status === "fulfilled").length, 3);
  assert.equal(result.filter(r => r.status === "rejected" && r.reason.status === 429).length, 1);
  assert.equal(sql.prepare("SELECT COUNT(*) AS n FROM attachment_v2_uploads").get().n, 3);
});

test("expired uploads do not resume and owner removal prevents creation", async t => {
  const { db, sql } = await fixture(t), input = await manifest();
  const upload = await createUpload(db, input, IDENTITY, "expired-key", NOW);
  const expired = new Date(NOW.getTime() + 3600000);
  await assert.rejects(uploadStatus(db, upload.id, IDENTITY, expired), error(410, "attachment_upload_expired"));
  sql.prepare("UPDATE organizations SET deleted_at = ?").run(NOW.toISOString());
  await assert.rejects(createUpload(db, input, IDENTITY, "another-key", NOW), error(404, "owner_not_found"));
});

test("rolling daily byte and count quotas retain accounting after cancellation and expiry", async t => {
  const bytesFixture = await fixture(t), large = await manifest(new Uint8Array(20971520).fill(97));
  for (let i = 0; i < 5; i++) {
    await createUpload(bytesFixture.db, large, IDENTITY, `daily-bytes-${i}`,
      new Date(NOW.getTime() + i * 3660000));
  }
  await assert.rejects(createUpload(bytesFixture.db, large, IDENTITY, "daily-bytes-extra",
    new Date(NOW.getTime() + 5 * 3660000)), error(429, "attachment_upload_quota_exceeded"));
  const countFixture = await fixture(t), small = await manifest();
  for (let i = 0; i < 40; i++) {
    const upload = await createUpload(countFixture.db, small, IDENTITY, `daily-count-${i}`, NOW);
    countFixture.sql.prepare("UPDATE attachment_v2_uploads SET state='cancelled' WHERE id=?").run(upload.id);
  }
  await assert.rejects(createUpload(countFixture.db, small, IDENTITY, "daily-count-extra", NOW), error(429, "attachment_upload_quota_exceeded"));
});

test("active dedup index survives tombstones and deletion preserves immutable object bytes", async t => {
  const { db, sql } = await fixture(t), sha = "a".repeat(64);
  const id = crypto.randomUUID();
  sql.prepare(`INSERT INTO attachment_v2_objects VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`)
    .run(id, "account", "account-1", "test.txt", "text/plain", 1, sha, `attachments-v2/objects/${id}`, "version-1", IDENTITY.creator, NOW.toISOString());
  const list = await listAttachments(db, "account", "account-1");
  assert.equal(list[0].id, id);
  assert.doesNotMatch(JSON.stringify(list), /storage_key|attachments-v2\/objects/u);
  const other = crypto.randomUUID();
  const clone = sql.prepare(`INSERT INTO attachment_v2_objects
    SELECT ?,owner_kind,owner_id,file_name,content_type,byte_size,sha256,?,object_version,created_by,created_at,NULL
    FROM attachment_v2_objects WHERE id=?`);
  assert.throws(() => clone.run(other, `attachments-v2/objects/${other}`, id), /UNIQUE/u);
  await deleteAttachment(db, id, NOW);
  await deleteAttachment(db, id, NOW);
  assert.deepEqual(await listAttachments(db, "account", "account-1"), []);
  assert.equal(sql.prepare("SELECT storage_key FROM attachment_v2_objects WHERE id=?").get(id).storage_key, `attachments-v2/objects/${id}`);
  clone.run(other, `attachments-v2/objects/${other}`, id);
  assert.equal((await listAttachments(db, "account", "account-1"))[0].id, other);
});
