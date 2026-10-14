import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  acquireConnectionLease, claimCallback, claimFinalize, commitConnection, commitConnectionFlow,
  completeCredentialCleanup, completeFlow, countCredentialCleanup, createFlow,
  disconnectConnection, ensureConnection, failFlow, finishCallback, getConnection,
  listCredentialCleanup, queueCredentialCleanup, releaseConnectionLease,
} from "../lib/exchange-connection-store.ts";

const NOW = new Date("2026-10-14T04:00:00.000Z");
const config = { tenantId: randomUUID(), mailboxId: randomUUID(), clientId: randomUUID() };
const later = (seconds) => new Date(NOW.valueOf() + seconds * 1000);
const flowInput = (changes = {}) => ({
  id: randomUUID(), stateHash: "a".repeat(64), binderHash: "b".repeat(64),
  operatorEmail: "alexis@27pm.org", generation: 0,
  expiresAt: later(300).toISOString(), ...changes,
});

test("read-only status does not initialize a connection; initialization fixes the identity", async (t) => {
  const { db } = await setup(t);
  assert.equal(await getConnection(db), null);
  const row = await ensureConnection(db, config, NOW);
  assert.equal(row.status, "disconnected");
  assert.equal(row.generation, 0);
  assert.equal(row.version, 0);
  assert.equal(row.credentialVersion, null);
  assert.equal(await ensureConnection(db, { ...config, tenantId: randomUUID() }, NOW), null);
  assert.deepEqual(await ensureConnection(db, config, later(1)), row);
});

test("a flow contains hashes only, has a five-minute lifetime and one active flow per operator", async (t) => {
  const { db, sqlite } = await setup(t);
  await ensureConnection(db, config, NOW);
  const input = flowInput();
  assert.equal((await createFlow(db, input, NOW)).id, input.id);
  assert.equal(await createFlow(db, flowInput({ stateHash: "c".repeat(64) }), NOW), null);
  assert.equal(await createFlow(db, flowInput({ stateHash: "d".repeat(64), expiresAt: later(301).toISOString() }), NOW), null);
  assert.equal(await createFlow(db, flowInput({ stateHash: "raw-state" }), NOW), null);
  assert.equal(await createFlow(db, flowInput({ binderHash: "raw-binder" }), NOW), null);
  assert.equal(await createFlow(db, flowInput({ generation: 1 }), NOW), null);
  assert.equal(await createFlow(db, flowInput({ expiresAt: NOW.toISOString() }), NOW), null);
  const columns = sqlite.prepare("PRAGMA table_info('exchange_oauth_flows')").all().map((r) => r.name);
  assert.deepEqual(columns, ["id", "connection_id", "generation", "state_hash", "binder_hash", "operator_email", "status", "expires_at", "created_at", "updated_at"]);
  assert.equal((await createFlow(db, flowInput({ stateHash: "c".repeat(64), expiresAt: later(600).toISOString() }), later(300))).status, "pending");
  assert.equal(sqlite.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").get(input.id).status, "failed");
});

test("callback and finalization are single-use and bind the operator, browser and generation", async (t) => {
  const { db } = await setup(t);
  await ensureConnection(db, config, NOW);
  const input = flowInput();
  await createFlow(db, input, NOW);
  const claims = await Promise.all([claimCallback(db, { stateHash: input.stateHash }, NOW), claimCallback(db, { stateHash: input.stateHash }, NOW)]);
  assert.equal(claims.filter(Boolean).length, 1);
  assert.equal(claims.find(Boolean).stateHash, input.stateHash);
  assert.equal(claims.find(Boolean).operatorEmail, input.operatorEmail);
  assert.equal(await finishCallback(db, { id: input.id, generation: 1 }, NOW), false);
  assert.equal(await finishCallback(db, { id: input.id, generation: 0 }, NOW), true);
  assert.equal(await finishCallback(db, { id: input.id, generation: 0 }, NOW), false);
  const finish = { id: input.id, binderHash: input.binderHash, operatorEmail: input.operatorEmail };
  assert.equal(await claimFinalize(db, { ...finish, operatorEmail: "other@27pm.org" }, NOW), null);
  assert.equal(await claimFinalize(db, { ...finish, binderHash: "c".repeat(64) }, NOW), null);
  const finalizers = await Promise.all([claimFinalize(db, finish, NOW), claimFinalize(db, finish, NOW)]);
  assert.equal(finalizers.filter(Boolean).length, 1);
  const lease = await acquireConnectionLease(db, { owner: randomUUID() }, NOW);
  assert.equal(await completeFlow(db, { id: input.id, generation: 0, owner: randomUUID() }, NOW), false);
  assert.equal(await completeFlow(db, { id: input.id, generation: 0, owner: lease.leaseOwner }, NOW), false);
  assert.ok(await commitConnection(db, { owner: lease.leaseOwner, generation: 0, version: 0, status: "connected", credentialVersion: randomUUID() }, NOW));
  assert.equal(await completeFlow(db, { id: input.id, generation: 0, owner: lease.leaseOwner }, later(60)), false);
  assert.equal(await completeFlow(db, { id: input.id, generation: 0, owner: lease.leaseOwner }, NOW), true);
  assert.equal(await completeFlow(db, { id: input.id, generation: 0, owner: lease.leaseOwner }, NOW), false);
});

test("all flow transitions fail closed at expiry", async (t) => {
  const { db } = await setup(t);
  await ensureConnection(db, config, NOW);
  const input = flowInput();
  await createFlow(db, input, NOW);
  assert.equal(await claimCallback(db, { stateHash: input.stateHash }, later(300)), null);
  await claimCallback(db, { stateHash: input.stateHash }, NOW);
  assert.equal(await finishCallback(db, { id: input.id, generation: 0 }, later(300)), false);
  await finishCallback(db, { id: input.id, generation: 0 }, NOW);
  assert.equal(await claimFinalize(db, { id: input.id, operatorEmail: input.operatorEmail, binderHash: input.binderHash }, later(300)), null);
});

test("the lease serializes writers, expires in sixty seconds and guards commits by version", async (t) => {
  const { db } = await setup(t);
  await ensureConnection(db, config, NOW);
  const owners = [randomUUID(), randomUUID()];
  const candidates = await Promise.all(owners.map((owner) => acquireConnectionLease(db, { owner }, NOW)));
  assert.equal(candidates.filter(Boolean).length, 1);
  const lease = candidates.find(Boolean);
  assert.equal(lease.leaseExpiresAt, later(60).toISOString());
  const input = { owner: lease.leaseOwner, generation: 0, version: 0, status: "connected", credentialVersion: randomUUID() };
  assert.equal(await commitConnection(db, { ...input, owner: randomUUID() }, NOW), null);
  assert.equal(await commitConnection(db, { ...input, version: 99 }, NOW), null);
  assert.equal(await commitConnection(db, input, later(60)), null);
  const committed = await commitConnection(db, input, later(1));
  assert.equal(committed.version, 1);
  assert.equal(committed.credentialVersion, input.credentialVersion);
  assert.equal(await commitConnection(db, input, later(2)), null);
  assert.equal(await releaseConnectionLease(db, { owner: randomUUID() }), false);
  assert.equal((await getConnection(db)).leaseOwner, lease.leaseOwner);
  const replacement = await acquireConnectionLease(db, { owner: randomUUID() }, later(60));
  assert.ok(replacement);
  assert.equal(await releaseConnectionLease(db, { owner: lease.leaseOwner }), false);
  assert.equal(await commitConnection(db, { ...input, version: 1 }, later(61)), null);
});

test("disconnect fences late callbacks and finalizers and clears the credential pointer before external cleanup", async (t) => {
  const { db, sqlite } = await setup(t);
  await ensureConnection(db, config, NOW);
  const input = flowInput();
  await createFlow(db, input, NOW);
  await claimCallback(db, { stateHash: input.stateHash }, NOW);
  await finishCallback(db, { id: input.id, generation: 0 }, NOW);
  await claimFinalize(db, { id: input.id, operatorEmail: input.operatorEmail, binderHash: input.binderHash }, NOW);
  const lease = await acquireConnectionLease(db, { owner: randomUUID() }, NOW);
  const oldWrite = { owner: lease.leaseOwner, generation: 0, version: 0, status: "connected", credentialVersion: randomUUID() };
  const row = await disconnectConnection(db, { owner: lease.leaseOwner, generation: 0, version: 0 }, NOW);
  assert.equal(row.generation, 1);
  assert.equal(row.version, 1);
  assert.equal(row.status, "disconnected");
  assert.equal(row.credentialVersion, null);
  assert.equal(row.leaseOwner, lease.leaseOwner);
  assert.equal(sqlite.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").get(input.id).status, "failed");
  assert.equal(await commitConnection(db, oldWrite, NOW), null);
  assert.equal(await completeFlow(db, { id: input.id, generation: 0, owner: lease.leaseOwner }, NOW), false);
  assert.equal(await createFlow(db, flowInput({ stateHash: "d".repeat(64) }), NOW), null);
  assert.ok(await createFlow(db, flowInput({ stateHash: "d".repeat(64), generation: 1 }), NOW));
});

test("failed or stale disconnects do not invalidate a newer flow", async (t) => {
  const { db, sqlite } = await setup(t);
  await ensureConnection(db, config, NOW);
  const input = flowInput();
  await createFlow(db, input, NOW);
  const lease = await acquireConnectionLease(db, { owner: randomUUID() }, NOW);
  assert.equal(await disconnectConnection(db, { owner: randomUUID(), generation: 0, version: 0 }, NOW), null);
  assert.equal(await disconnectConnection(db, { owner: lease.leaseOwner, generation: 0, version: 0 }, later(60)), null);
  assert.equal(sqlite.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").get(input.id).status, "pending");
  assert.equal(await failFlow(db, { id: input.id }), true);
  assert.equal(await failFlow(db, { id: input.id }), false);
  assert.equal(await claimCallback(db, { stateHash: input.stateHash }, NOW), null);
});

test("refresh and reauthentication share the same lease and immutable-version compare-and-swap", async (t) => {
  const { db } = await setup(t);
  await ensureConnection(db, config, NOW);
  const owner = randomUUID();
  assert.equal(await acquireConnectionLease(db, { owner, generation: 1 }, NOW), null);
  assert.equal(await acquireConnectionLease(db, { owner, version: 1 }, NOW), null);
  const lease = await acquireConnectionLease(db, { owner, generation: 0, version: 0 }, NOW);
  assert.ok(lease);
  assert.equal(await acquireConnectionLease(db, { owner }, NOW), null);
  const firstCredential = randomUUID();
  assert.ok(await commitConnection(db, { owner, generation: 0, version: 0, status: "connected", credentialVersion: firstCredential }, NOW));
  const reauth = await commitConnection(db, { owner, generation: 0, version: 1, status: "reauth_required", credentialVersion: firstCredential }, NOW);
  assert.equal(reauth.status, "reauth_required");
  const secondCredential = randomUUID();
  const reconnected = await commitConnection(db, { owner, generation: 0, version: 2, status: "connected", credentialVersion: secondCredential }, NOW);
  assert.equal(reconnected.credentialVersion, secondCredential);
  assert.equal(reconnected.version, 3);
  assert.equal(await commitConnection(db, { owner, generation: 0, version: 3, status: "connected", credentialVersion: "raw-refresh-token" }, NOW), null);
  assert.equal(await commitConnection(db, { owner, generation: 0, version: 3, status: "connected", credentialVersion: null }, NOW), null);
  assert.equal(await releaseConnectionLease(db, { owner }), true);
  assert.equal(await releaseConnectionLease(db, { owner }), false);
  assert.ok(await acquireConnectionLease(db, { owner: randomUUID(), version: 3 }, NOW));
});

test("whole migrations preserve foreign keys and database-level hash, singleton and lifetime constraints", async (t) => {
  const { db, sqlite } = await setup(t);
  await ensureConnection(db, config, NOW);
  const connectionColumns = sqlite.prepare("PRAGMA table_info('exchange_connections')").all().map((r) => r.name);
  assert.deepEqual(connectionColumns, ["id", "tenant_id", "mailbox_id", "client_id", "generation", "version", "status", "credential_version", "lease_owner", "lease_expires_at", "created_at", "updated_at"]);
  assert.throws(() => sqlite.prepare("UPDATE exchange_connections SET id = 'other'").run(), /check constraint/iu);
  assert.throws(() => sqlite.prepare("UPDATE exchange_connections SET status = 'connected'").run(), /check constraint/iu);
  assert.throws(() => sqlite.prepare("UPDATE exchange_connections SET lease_owner = ?").run(randomUUID()), /check constraint/iu);
  const input = flowInput();
  await createFlow(db, input, NOW);
  assert.throws(() => sqlite.prepare("UPDATE exchange_oauth_flows SET state_hash = 'raw-state'").run(), /check constraint/iu);
  assert.throws(() => sqlite.prepare("UPDATE exchange_oauth_flows SET binder_hash = 'raw-binder'").run(), /check constraint/iu);
  assert.throws(() => sqlite.prepare("UPDATE exchange_oauth_flows SET expires_at = ?").run(later(301).toISOString()), /check constraint/iu);
  assert.equal(await createFlow(db, flowInput({ operatorEmail: "another@27pm.org" }), NOW), null);
  assert.equal(await createFlow(db, flowInput({ stateHash: "c".repeat(64), operatorEmail: "Alexis@27pm.org" }), NOW), null);
  assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
});

test("OAuth commit atomically rechecks a live consuming flow and marks it completed with its pointer", async (t) => {
  const { db, sqlite } = await setup(t);
  await ensureConnection(db, config, NOW);
  const input = flowInput();
  await createFlow(db, input, NOW);
  await claimCallback(db, { stateHash: input.stateHash }, NOW);
  await finishCallback(db, { id: input.id, generation: 0 }, NOW);
  const lease = await acquireConnectionLease(db, { owner: randomUUID() }, NOW);
  const commit = { owner: lease.leaseOwner, generation: 0, version: 0, credentialVersion: randomUUID(), flowId: input.id };
  assert.equal(await commitConnectionFlow(db, commit, NOW), null);
  await claimFinalize(db, { id: input.id, binderHash: input.binderHash, operatorEmail: input.operatorEmail }, NOW);
  const attempts = await Promise.all([commitConnectionFlow(db, commit, NOW), commitConnectionFlow(db, commit, NOW)]);
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(attempts.find(Boolean).credentialVersion, commit.credentialVersion);
  assert.equal(sqlite.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").get(input.id).status, "completed");
  assert.equal((await getConnection(db)).version, 1);
  assert.equal(await commitConnectionFlow(db, { ...commit, version: 1, credentialVersion: randomUUID() }, NOW), null);
});

test("OAuth commit refuses flows failed or expired while provider calls were in flight", async (t) => {
  for (const reason of ["failed", "expired", "disconnected"]) {
    const { db } = await setup(t);
    await ensureConnection(db, config, NOW);
    const input = flowInput({ expiresAt: later(30).toISOString() });
    await createFlow(db, input, NOW);
    await claimCallback(db, { stateHash: input.stateHash }, NOW);
    await finishCallback(db, { id: input.id, generation: 0 }, NOW);
    await claimFinalize(db, { id: input.id, binderHash: input.binderHash, operatorEmail: input.operatorEmail }, NOW);
    const lease = await acquireConnectionLease(db, { owner: randomUUID() }, NOW);
    const commit = { owner: lease.leaseOwner, generation: 0, version: 0, credentialVersion: randomUUID(), flowId: input.id };
    if (reason === "failed") await failFlow(db, { id: input.id }, later(1));
    if (reason === "disconnected") await disconnectConnection(db, { owner: lease.leaseOwner, generation: 0, version: 0 }, later(1));
    assert.equal(await commitConnectionFlow(db, commit, reason === "expired" ? later(30) : later(1)), null, reason);
    assert.equal((await getConnection(db)).credentialVersion, null, reason);
    assert.equal((await getConnection(db)).status, "disconnected", reason);
  }
});

test("rotation and disconnect durably queue only obsolete opaque credential versions", async (t) => {
  const { db } = await setup(t);
  assert.equal(await countCredentialCleanup(db), 0);
  assert.equal(await getConnection(db), null);
  await ensureConnection(db, config, NOW);
  const owner = randomUUID();
  await acquireConnectionLease(db, { owner }, NOW);
  const first = randomUUID();
  const second = randomUUID();
  await commitConnection(db, { owner, generation: 0, version: 0, status: "connected", credentialVersion: first }, NOW);
  assert.equal(await countCredentialCleanup(db), 0);
  assert.equal(await queueCredentialCleanup(db, first, NOW), false);
  await commitConnection(db, { owner, generation: 0, version: 1, status: "connected", credentialVersion: second }, NOW);
  assert.deepEqual((await listCredentialCleanup(db)).map((row) => row.credentialVersion), [first]);
  assert.equal(await queueCredentialCleanup(db, first, NOW), false);
  await disconnectConnection(db, { owner, generation: 0, version: 2 }, NOW);
  assert.deepEqual(new Set((await listCredentialCleanup(db)).map((row) => row.credentialVersion)), new Set([first, second]));
  assert.equal(await countCredentialCleanup(db), 2);
  assert.equal(await completeCredentialCleanup(db, first), true);
  assert.equal(await completeCredentialCleanup(db, first), false);
  assert.equal(await countCredentialCleanup(db), 1);
  assert.equal(await completeCredentialCleanup(db, second), true);
  assert.equal(await countCredentialCleanup(db), 0);
});

test("cleanup jobs survive lost disconnect acknowledgements and are bounded and secret-free", async (t) => {
  const { db, sqlite } = await setup(t);
  await ensureConnection(db, config, NOW);
  const owner = randomUUID();
  await acquireConnectionLease(db, { owner }, NOW);
  const active = randomUUID();
  await commitConnection(db, { owner, generation: 0, version: 0, status: "connected", credentialVersion: active }, NOW);
  const ambiguousDb = { ...db, async batch(statements) { await db.batch(statements); throw new Error("lost acknowledgement"); } };
  await assert.rejects(disconnectConnection(ambiguousDb, { owner, generation: 0, version: 1 }, NOW));
  assert.equal((await getConnection(db)).status, "disconnected");
  assert.deepEqual((await listCredentialCleanup(db)).map((row) => row.credentialVersion), [active]);
  assert.equal(await queueCredentialCleanup(db, "raw-refresh-token", NOW), false);
  for (let i = 0; i < 22; i += 1) assert.equal(await queueCredentialCleanup(db, randomUUID(), NOW), true);
  assert.equal((await listCredentialCleanup(db, 999)).length, 20);
  assert.equal((await listCredentialCleanup(db, 2)).length, 2);
  assert.equal((await listCredentialCleanup(db, 0)).length, 0);
  assert.equal(await countCredentialCleanup(db), 23);
  assert.deepEqual(sqlite.prepare("PRAGMA table_info('exchange_credential_cleanup')").all().map((r) => r.name), ["credential_version", "created_at"]);
});

test("even an unexpectedly queued active pointer cannot be listed or completed for cleanup", async (t) => {
  const { db, sqlite } = await setup(t);
  await ensureConnection(db, config, NOW);
  const owner = randomUUID();
  await acquireConnectionLease(db, { owner }, NOW);
  const active = randomUUID();
  await commitConnection(db, { owner, generation: 0, version: 0, status: "connected", credentialVersion: active }, NOW);
  sqlite.prepare("INSERT INTO exchange_credential_cleanup (credential_version) VALUES (?)").run(active);
  assert.equal(await queueCredentialCleanup(db, active, NOW), false);
  assert.deepEqual(await listCredentialCleanup(db), []);
  assert.equal(await completeCredentialCleanup(db, active), false);
  assert.equal(await countCredentialCleanup(db), 1);
});

test("native D1 acknowledges disconnect despite the cleanup trigger counting a second change", { timeout: 30000 }, async (t) => {
  const { db, batches } = await setupD1(t);
  await ensureConnection(db, config, NOW);
  const owner = randomUUID();
  const credentialVersion = randomUUID();
  await acquireConnectionLease(db, { owner }, NOW);
  await commitConnection(db, { owner, generation: 0, version: 0, status: "connected", credentialVersion }, NOW);
  const input = flowInput();
  await createFlow(db, input, NOW);
  const guard = { owner, generation: 0, version: 1 };
  for (const invalid of [{ ...guard, owner: randomUUID() }, { ...guard, generation: 1 }, { ...guard, version: 0 }]) {
    assert.equal(await disconnectConnection(db, invalid, NOW), null);
  }
  assert.equal(await disconnectConnection(db, guard, later(60)), null);
  assert.equal(await countCredentialCleanup(db), 0);
  assert.equal((await getConnection(db)).credentialVersion, credentialVersion);
  assert.equal((await db.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").bind(input.id).first()).status, "pending");

  const disconnected = await disconnectConnection(db, guard, later(1));
  const result = batches.at(-1);
  assert.equal(result[0].meta.changes, 2, "D1 counts the row update plus the cleanup trigger insert");
  assert.equal(result[0].results.length, 1, "RETURNING counts only the guarded connection row");
  assert.equal(disconnected?.status, "disconnected");
  assert.equal(disconnected.generation, 1);
  assert.equal(disconnected.version, 2);
  assert.equal(disconnected.credentialVersion, null);
  assert.equal((await db.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").bind(input.id).first()).status, "failed");
  assert.deepEqual((await listCredentialCleanup(db)).map((row) => row.credentialVersion), [credentialVersion]);
  assert.equal(await disconnectConnection(db, guard, later(2)), null, "stale replay cannot acknowledge a second disconnect");
  assert.equal((await getConnection(db)).version, 2);
  assert.equal(await countCredentialCleanup(db), 1);
});

test("native D1 acknowledges OAuth credential rotation and completes only its successful CAS flow", { timeout: 30000 }, async (t) => {
  const { db, batches } = await setupD1(t);
  await ensureConnection(db, config, NOW);
  const owner = randomUUID();
  const oldCredential = randomUUID();
  await acquireConnectionLease(db, { owner }, NOW);
  await commitConnection(db, { owner, generation: 0, version: 0, status: "connected", credentialVersion: oldCredential }, NOW);
  const input = flowInput();
  await createFlow(db, input, NOW);
  await claimCallback(db, { stateHash: input.stateHash }, NOW);
  await finishCallback(db, { id: input.id, generation: 0 }, NOW);
  await claimFinalize(db, { id: input.id, binderHash: input.binderHash, operatorEmail: input.operatorEmail }, NOW);
  const commit = { owner, generation: 0, version: 1, credentialVersion: randomUUID(), flowId: input.id };
  for (const invalid of [{ ...commit, owner: randomUUID() }, { ...commit, generation: 1 }, { ...commit, version: 0 }]) {
    assert.equal(await commitConnectionFlow(db, invalid, NOW), null);
  }
  assert.equal(await commitConnectionFlow(db, commit, later(60)), null);
  assert.equal((await db.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").bind(input.id).first()).status, "consuming");
  assert.equal(await countCredentialCleanup(db), 0);

  const connected = await commitConnectionFlow(db, commit, later(1));
  const result = batches.at(-1);
  assert.equal(result[0].meta.changes, 2);
  assert.equal(result[0].results.length, 1);
  assert.equal(connected?.credentialVersion, commit.credentialVersion);
  assert.equal(connected.version, 2);
  assert.equal((await db.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").bind(input.id).first()).status, "completed");
  assert.deepEqual((await listCredentialCleanup(db)).map((row) => row.credentialVersion), [oldCredential]);
  assert.equal(await commitConnectionFlow(db, commit, later(2)), null);
  assert.equal((await getConnection(db)).version, 2);
  assert.equal(await countCredentialCleanup(db), 1);

  // A stale connection CAS must not complete a different consuming flow merely
  // because the desired credential pointer already happens to be current.
  const next = flowInput({ stateHash: "c".repeat(64) });
  await createFlow(db, next, later(2));
  await claimCallback(db, { stateHash: next.stateHash }, later(2));
  await finishCallback(db, { id: next.id, generation: 0 }, later(2));
  await claimFinalize(db, { id: next.id, binderHash: next.binderHash, operatorEmail: next.operatorEmail }, later(2));
  assert.equal(await commitConnectionFlow(db, { ...commit, flowId: next.id }, later(2)), null);
  assert.equal((await db.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").bind(next.id).first()).status, "consuming");
});

test("batch acknowledgements require successful statements and exactly one RETURNING row", async (t) => {
  const { db } = await setup(t);
  const owner = randomUUID();
  const commit = { owner, generation: 0, version: 0, credentialVersion: randomUUID(), flowId: randomUUID() };
  const row = { id: "alexis", status: "connected" };
  const valid = { ...db, async batch() {
    return [{ success: true, results: [row], meta: { changes: 2 } }, { success: true, results: [{ id: commit.flowId }], meta: { changes: 1 } }];
  } };
  assert.deepEqual(await commitConnectionFlow(valid, commit, NOW), row);
  assert.deepEqual(await disconnectConnection(valid, commit, NOW), row);
  for (const returned of [undefined, [], [row, row]]) {
    const invalid = { ...db, async batch() {
      return [{ success: true, results: returned, meta: { changes: 1 } }, { success: true, results: [{ id: commit.flowId }], meta: { changes: 1 } }];
    } };
    assert.equal(await disconnectConnection(invalid, commit, NOW), null);
    assert.equal(await commitConnectionFlow(invalid, commit, NOW), null);
  }
  for (const second of [
    { success: false, results: [{ id: commit.flowId }], meta: { changes: 1 } },
    { success: true, results: [], meta: { changes: 1 } },
    { success: true, results: [{ id: commit.flowId }, { id: commit.flowId }], meta: { changes: 1 } },
  ]) {
    const invalid = { ...db, async batch() { return [{ success: true, results: [row], meta: { changes: 1 } }, second]; } };
    assert.equal(await commitConnectionFlow(invalid, commit, NOW), null);
    if (!second.success) assert.equal(await disconnectConnection(invalid, commit, NOW), null);
  }
});

async function setupD1(t) {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  // Exercise the native Workers D1 binding and its trigger-aware metadata, not
  // node:sqlite's changes() adapter. Everything is ephemeral and local.
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-09-11", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: randomUUID() },
    script: `export default { async fetch(request, env) {
      const input = await request.json();
      const statements = input.statements.map(({ query, values }) => env.DB.prepare(query).bind(...values));
      return Response.json(input.batch ? await env.DB.batch(statements) : await statements[0][input.mode]());
    } };`,
  }));
  t.after(() => mf.dispose());
  const call = async (input) => {
    const response = await mf.dispatchFetch("http://local.invalid", { method: "POST", body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    return response.json();
  };
  const batches = [];
  const db = {
    prepare(query) {
      const statement = {
        query, values: [],
        bind(...values) { statement.values = values; return statement; },
        first() { return call({ statements: [statement], mode: "first" }); },
        all() { return call({ statements: [statement], mode: "all" }); },
        run() { return call({ statements: [statement], mode: "run" }); },
      };
      return statement;
    },
    async batch(statements) {
      const results = await call({ statements, batch: true });
      batches.push(results);
      return results;
    },
  };
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort()) {
    for (const statement of (await readFile(new URL(name, directory), "utf8")).split("--> statement-breakpoint")) {
      if (statement.trim()) assert.equal((await db.prepare(statement).run()).success, true);
    }
  }
  return { db, batches };
}

async function setup(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort();
  for (const name of names) {
    for (const statement of (await readFile(new URL(name, directory), "utf8")).split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  const db = {
    prepare(query) {
      let values = [];
      const execute = () => {
        const statement = sqlite.prepare(query);
        const results = statement.columns().length ? statement.all(...values) : undefined;
        const changes = results ? sqlite.prepare("SELECT changes() AS changes").get().changes : statement.run(...values).changes;
        return { results, success: true, meta: { changes } };
      };
      return {
        bind(...input) { values = input; return this; },
        async first() { return sqlite.prepare(query).get(...values) ?? null; },
        async all() { return { results: sqlite.prepare(query).all(...values), success: true }; },
        async run() { return execute(); },
        execute,
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((statement) => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return { db, sqlite };
}
