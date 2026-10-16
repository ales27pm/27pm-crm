import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { enqueueScanJob, claimScanJob, renewScanJob, authorizedScanJob,
  recordScannerHeartbeat, scannerFresh, failScanJob, getScanJob } from "../lib/attachment-scan-store.ts";

const NOW = new Date("2026-10-16T16:00:00.000Z");
const later = n => new Date(NOW.valueOf() + n * 1000);
const heartbeat = { engineVersion: "1.4.6", signatureVersion: "28155", signatureUpdatedAt: NOW.toISOString() };

test("claims are atomic, credential hashes only are persisted, and another scanner cannot use a lease", async t => {
  const f = await setup(t);
  assert.equal(await claimScanJob(f.db, "scanner-a", NOW), null, "no fresh heartbeat");
  assert.equal(await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, NOW), true);
  assert.equal(await scannerFresh(f.db, NOW), true);
  const first = await enqueueScanJob(f.db, f.id, NOW);
  assert.equal((await enqueueScanJob(f.db, f.id, NOW)).id, first.id, "enqueue is idempotent");
  const attempts = await Promise.all([claimScanJob(f.db, "scanner-a", NOW), claimScanJob(f.db, "scanner-a", NOW)]);
  assert.equal(attempts.filter(Boolean).length, 1);
  const claimed = attempts.find(Boolean);
  const stored = f.sqlite.prepare("SELECT * FROM attachment_scan_jobs").get();
  assert.notEqual(stored.lease_token_hash, claimed.lease.leaseToken);
  assert.match(stored.lease_token_hash, /^[0-9a-f]{64}$/u);
  assert.ok(await authorizedScanJob(f.db, claimed.lease, NOW));
  assert.equal(await authorizedScanJob(f.db, { ...claimed.lease, scannerId: "scanner-b" }, NOW), null);
  assert.equal(await authorizedScanJob(f.db, { ...claimed.lease, leaseToken: "x".repeat(43) }, NOW), null);
});

test("expired leases are never revived and replacement claims fence every old token", async t => {
  const f = await setup(t);
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, NOW);
  await enqueueScanJob(f.db, f.id, NOW);
  const old = await claimScanJob(f.db, "scanner-a", NOW);
  assert.equal(await renewScanJob(f.db, old.lease, later(120)), null);
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, later(120));
  const current = await claimScanJob(f.db, "scanner-a", later(120));
  assert.equal(current.job.generation, old.job.generation + 1);
  assert.equal(await authorizedScanJob(f.db, old.lease, later(121)), null);
  assert.ok(await authorizedScanJob(f.db, current.lease, later(121)));
  const renewed = await renewScanJob(f.db, current.lease, later(121));
  assert.equal(renewed.leaseExpiresAt, later(241).toISOString());
});

test("deleted owners and objects, changed metadata, and stale heartbeats fail closed", async t => {
  const f = await setup(t);
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, NOW);
  await enqueueScanJob(f.db, f.id, NOW);
  const claim = await claimScanJob(f.db, "scanner-a", NOW);
  f.sqlite.prepare("UPDATE organizations SET deleted_at=?").run(NOW.toISOString());
  assert.equal(await authorizedScanJob(f.db, claim.lease, NOW), null);
  f.sqlite.prepare("UPDATE organizations SET deleted_at=NULL").run();
  f.sqlite.prepare("UPDATE attachment_v2_objects SET object_version='replaced'").run();
  assert.equal(await authorizedScanJob(f.db, claim.lease, NOW), null);
  const requeued = await enqueueScanJob(f.db, f.id, NOW);
  assert.equal(requeued.state, "pending");
  assert.ok(requeued.generation > claim.job.generation);
  assert.equal(await scannerFresh(f.db, later(120)), false);
  f.sqlite.prepare("UPDATE attachment_v2_objects SET deleted_at=?").run(NOW.toISOString());
  assert.equal(await enqueueScanJob(f.db, f.id, NOW), null);
});

test("policy refusal is terminal and transient failures back off without unbounded attempts", async t => {
  const f = await setup(t);
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, NOW);
  await enqueueScanJob(f.db, f.id, NOW);
  const claim = await claimScanJob(f.db, "scanner-a", NOW);
  assert.equal(await failScanJob(f.db, claim.lease, "archive_policy_blocked", NOW), true);
  assert.equal((await enqueueScanJob(f.db, f.id, later(1))).state, "blocked");
  assert.equal(await claimScanJob(f.db, "scanner-a", later(1)), null);
  assert.equal(await failScanJob(f.db, claim.lease, "unavailable", NOW), false);
  assert.equal((await getScanJob(f.db, claim.job.id)).errorCode, "archive_policy_blocked");
});

test("heartbeat validation does not accept stale/future signatures or unknown engines", async t => {
  const f = await setup(t);
  for (const invalid of [
    { ...heartbeat, signatureUpdatedAt: "2000-01-01T00:00:00.000Z" },
    { ...heartbeat, signatureUpdatedAt: later(31).toISOString() },
    { ...heartbeat, engineVersion: "unknown" },
  ]) assert.equal(await recordScannerHeartbeat(f.db, "scanner-a", invalid, NOW), false);
  assert.equal(await scannerFresh(f.db, NOW), false);
});

test("renewals cannot keep a single claim alive beyond ten minutes", async t => {
  const f = await setup(t);
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, NOW);
  await enqueueScanJob(f.db, f.id, NOW);
  const claim = await claimScanJob(f.db, "scanner-a", NOW);
  for (const seconds of [100, 200, 300, 400, 500]) {
    await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, later(seconds));
    assert.ok(await renewScanJob(f.db, claim.lease, later(seconds)));
  }
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, later(590));
  assert.equal((await renewScanJob(f.db, claim.lease, later(590))).leaseExpiresAt, later(600).toISOString());
  assert.equal(await renewScanJob(f.db, claim.lease, later(600)), null);
});

test("transient retry is delayed, uses a new generation, and stops after five attempts", async t => {
  const f = await setup(t);
  await enqueueScanJob(f.db, f.id, NOW);
  for (let attempt = 0; attempt < 5; attempt++) {
    const when = later(attempt * 30);
    await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, when);
    const claim = await claimScanJob(f.db, "scanner-a", when);
    assert.equal(claim.job.attemptCount, attempt + 1);
    assert.equal(claim.job.generation, attempt + 1);
    assert.equal(await failScanJob(f.db, claim.lease, "unavailable", when), true);
    assert.equal(await claimScanJob(f.db, "scanner-a", when), null);
  }
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, later(150));
  assert.equal(await claimScanJob(f.db, "scanner-a", later(150)), null);
  assert.equal((await enqueueScanJob(f.db, f.id, later(150))).state, "blocked");
});

test("exhausted expired leases are terminal and cannot create a sixth claim", async t => {
  const f = await setup(t);
  const job = await enqueueScanJob(f.db, f.id, NOW);
  for (let attempt = 0; attempt < 5; attempt++) {
    const when = later(attempt * 120);
    await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, when);
    assert.equal((await claimScanJob(f.db, "scanner-a", when)).job.attemptCount, attempt + 1);
  }
  await recordScannerHeartbeat(f.db, "scanner-a", heartbeat, later(600));
  assert.equal(await claimScanJob(f.db, "scanner-a", later(600)), null);
  assert.equal((await getScanJob(f.db, job.id)).state, "blocked");
  assert.equal((await getScanJob(f.db, job.id)).errorCode, "attempts_exhausted");
});

test("the actual migration chain is additive and enforces receipt, size, hash and nonce constraints", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(dir)).filter(n => /^\d+.*\.sql$/u.test(n)).sort()) {
    sqlite.exec(await readFile(new URL(name, dir), "utf8"));
  }
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  const id = randomUUID();
  sqlite.prepare(`INSERT INTO attachment_v2_objects
    (id,owner_kind,owner_id,file_name,content_type,byte_size,sha256,storage_key,object_version,created_by,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(id, "account", "owner", "a.txt", "text/plain", 5, "a".repeat(64),
      `attachments-v2/objects/${id}`, "v1", "fixture", NOW.toISOString());
  sqlite.prepare(`INSERT INTO attachment_scan_jobs
    (id,attachment_id,storage_key,object_version,sha256,byte_size,policy,available_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), id, `attachments-v2/objects/${id}`, "v1", "a".repeat(64),
      5, "sha256-bound-r2-pull-v2", NOW.toISOString(), NOW.toISOString(), NOW.toISOString());
  assert.throws(() => sqlite.exec("UPDATE attachment_scan_jobs SET state='completed'"), /constraint/iu);
  assert.throws(() => sqlite.exec("UPDATE attachment_scan_jobs SET byte_size=20971521"), /constraint/iu);
  assert.throws(() => sqlite.exec("UPDATE attachment_scan_jobs SET sha256='z'"), /constraint/iu);
  sqlite.prepare("INSERT INTO attachment_scanner_request_nonces VALUES (?,?,?)").run("key:nonce", 2000, 1000);
  assert.throws(() => sqlite.prepare("INSERT INTO attachment_scanner_request_nonces VALUES (?,?,?)").run("key:nonce", 2000, 1000), /constraint/iu);
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
  const id = randomUUID();
  sqlite.prepare("INSERT INTO attachment_v2_objects VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)").run(
    id, "account", "owner", "fixture.txt", "text/plain", 5, "a".repeat(64),
    `attachments-v2/objects/${id}`, "r2-version-1", "fixture", NOW.toISOString());
  const db = { prepare(sql) { let values = []; return {
    bind(...v) { values = v; return this; },
    async first() { return sqlite.prepare(sql).get(...values) ?? null; },
    async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
    async run() { const result = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: result.changes } }; },
  }; } };
  return { db, sqlite, id };
}
