import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { enqueueScanJob, claimScanJob, recordScannerHeartbeat, getScanJob } from "../lib/attachment-scan-store.ts";
import { completeScanJob, scannedAttachment, authorizedScanObject } from "../lib/attachment-scan-service.ts";

const NOW = new Date("2026-10-16T16:00:00.000Z");
const later = seconds => new Date(NOW.valueOf() + seconds * 1000);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const heartbeat = { engineVersion: "1.4.6", signatureVersion: "28155", signatureUpdatedAt: NOW.toISOString() };
const verdict = (f, override = {}) => ({ protocol: "crm-clamav-v1", status: "clean", sha256: hash(f.bytes),
  byteSize: f.bytes.length, ...heartbeat, scannedAt: NOW.toISOString(), ...override });

test("unscanned files stay quarantined; a clean immutable receipt releases only the exact object", async t => {
  const f = await setup(t);
  assert.equal(await scannedAttachment(f.db, f.bucket, f.id, NOW), null);
  assert.ok(await authorizedScanObject(f.db, f.bucket, f.claim.lease, NOW));
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), NOW), "completed");
  assert.equal((await scannedAttachment(f.db, f.bucket, f.id, NOW)).id, f.id);
  assert.equal(f.objects.size, 2, "customer object plus immutable receipt");
  assert.equal((await getScanJob(f.db, f.claim.job.id)).resultStatus, "clean");
});

test("identical report retry reconciles a lost response but a different report cannot overwrite the pointer", async t => {
  const f = await setup(t);
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), NOW), "completed");
  const before = await getScanJob(f.db, f.claim.job.id);
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), later(1)), "duplicate");
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f, { status: "infected" }), later(1)), "rejected");
  assert.equal((await getScanJob(f.db, f.claim.job.id)).receiptKey, before.receiptKey);
  assert.equal(f.objects.size, 2);
});

test("a superseded worker's late clean receipt cannot overwrite a newer infected result", async t => {
  const f = await setup(t);
  const originalPut = f.bucket.put;
  let superseded = false;
  f.bucket.put = async (...args) => {
    const result = await originalPut(...args);
    if (!superseded) {
      superseded = true;
      await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, later(120));
      const current = await claimScanJob(f.db, "scanner-a", later(120));
      assert.ok(current);
      assert.equal(await completeScanJob(f.db, f.bucket, current.lease,
        verdict(f, { status: "infected", scannedAt: later(120).toISOString() }), later(120)), "completed");
    }
    return result;
  };
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), NOW), "rejected");
  const authoritative = await getScanJob(f.db, f.claim.job.id);
  assert.equal(authoritative.resultStatus, "infected");
  assert.equal(await scannedAttachment(f.db, f.bucket, f.id, later(121)), null);
  assert.equal((await enqueueScanJob(f.db, f.id, later(86401))).state, "completed", "infected never auto-reopens");
});

test("old tokens, expired leases and stale scanner signatures cannot publish a result", async t => {
  const f = await setup(t);
  assert.equal(await completeScanJob(f.db, f.bucket, { ...f.claim.lease, scannerId: "wrong" }, verdict(f), NOW), "rejected");
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), later(120)), "rejected");
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease,
    verdict(f, { signatureUpdatedAt: "2000-01-01T00:00:00Z" }), NOW), "rejected");
  assert.equal(f.objects.size, 1);
});

test("a stalled receipt write cannot freeze the lease clock and publish after expiry", async t => {
  const f = await setup(t), originalPut = f.bucket.put;
  let currentTime = NOW;
  f.bucket.put = async (...args) => {
    const result = await originalPut(...args);
    currentTime = later(120);
    return result;
  };
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), () => currentTime), "rejected");
  assert.equal((await getScanJob(f.db, f.claim.job.id)).receiptKey, null);
  assert.equal(await scannedAttachment(f.db, f.bucket, f.id, currentTime), null);
});

test("deleted object or owner and same-byte replacement during publication do not become downloadable", async t => {
  for (const reason of ["deleted", "owner", "version"]) {
    const f = await setup(t), put = f.bucket.put;
    f.bucket.put = async (...args) => {
      const result = await put(...args);
      if (reason === "deleted") f.sqlite.prepare("UPDATE attachment_v2_objects SET deleted_at=?").run(NOW.toISOString());
      if (reason === "owner") f.sqlite.prepare("UPDATE organizations SET deleted_at=?").run(NOW.toISOString());
      if (reason === "version") f.objects.get(f.key).version = "replacement-version";
      return result;
    };
    assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), NOW), "rejected");
    assert.equal(await scannedAttachment(f.db, f.bucket, f.id, NOW), null);
  }
});

test("receipt corruption, malformed receipts, wrong object checksum and stale clean verdict remain blocked", async t => {
  const f = await setup(t);
  await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), NOW);
  const job = await getScanJob(f.db, f.claim.job.id);
  const receipt = f.objects.get(job.receiptKey);
  const old = receipt.bytes;
  receipt.bytes = new TextEncoder().encode("{broken");
  assert.equal(await scannedAttachment(f.db, f.bucket, f.id, NOW), null);
  receipt.bytes = old;
  f.objects.get(f.key).checksums = {};
  assert.equal(await scannedAttachment(f.db, f.bucket, f.id, NOW), null);
  f.objects.get(f.key).checksums = { sha256: Uint8Array.from(Buffer.from(hash(f.bytes), "hex")).buffer };
  assert.equal(await scannedAttachment(f.db, f.bucket, f.id, later(86401)), null);
  assert.equal((await enqueueScanJob(f.db, f.id, later(86401))).state, "pending");
});

test("cached clean verdicts remain verifiable independently of a scanner heartbeat", async t => {
  const f = await setup(t);
  await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f), NOW);
  assert.equal((await scannedAttachment(f.db, f.bucket, f.id, later(180))).id, f.id);
});

test("unsupported result states, mismatched digest and oversize diagnostics cannot create clean receipts", async t => {
  const f = await setup(t);
  for (const bad of [{ status: "unknown" }, { sha256: "0".repeat(64) }, { byteSize: 20971521 }]) {
    assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f, bad), NOW), "rejected");
  }
  assert.equal(await completeScanJob(f.db, f.bucket, f.claim.lease, verdict(f, { diagnostics: "x".repeat(10000) }), NOW), "completed");
  const job = await getScanJob(f.db, f.claim.job.id);
  assert.doesNotMatch(new TextDecoder().decode(f.objects.get(job.receiptKey).bytes), /diagnostics/);
});

async function setup(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organizations(id TEXT PRIMARY KEY,deleted_at TEXT);
    CREATE TABLE deals(id TEXT PRIMARY KEY);
    CREATE TABLE conversations(id TEXT PRIMARY KEY);
    INSERT INTO organizations VALUES ('owner',NULL);`);
  sqlite.exec(await readFile(new URL("../drizzle/0022_attachment_v2_uploads.sql", import.meta.url), "utf8"));
  sqlite.exec(await readFile(new URL("../drizzle/0023_attachment_scan_jobs.sql", import.meta.url), "utf8"));
  const id = randomUUID(), bytes = new TextEncoder().encode("a safe fixture"), key = `attachments-v2/objects/${id}`;
  sqlite.prepare("INSERT INTO attachment_v2_objects VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)").run(
    id, "account", "owner", "fixture.txt", "text/plain", bytes.length, hash(bytes), key,
    "r2-version-1", "fixture", NOW.toISOString());
  const db = { prepare(sql) { let values = []; return {
    bind(...v) { values = v; return this; },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
    async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; },
  }; } };
  const objects = new Map();
  function meta(key) {
    const o = objects.get(key);
    return o ? { key, size: o.bytes.length, version: o.version, etag: o.version, checksums: o.checksums } : null;
  }
  const bucket = {
    async head(key) { return meta(key); },
    async get(key) { const o = objects.get(key); return o ? { ...meta(key), body: new Response(o.bytes).body } : null; },
    async put(key, value, options) {
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
      objects.set(key, { bytes, version: randomUUID(), checksums: { sha256: Uint8Array.from(Buffer.from(hash(bytes), "hex")).buffer } });
      return meta(key);
    },
  };
  await bucket.put(key, bytes);
  objects.get(key).version = "r2-version-1";
  await recordScannerHeartbeat(db, "scanner-a", heartbeat, NOW);
  await enqueueScanJob(db, id, NOW);
  const claim = await claimScanJob(db, "scanner-a", NOW);
  return { db, sqlite, bucket, objects, id, bytes, key, claim };
}
