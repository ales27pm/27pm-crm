import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { acquireConnectionLease, commitConnection, disconnectConnection, ensureConnection } from "../lib/exchange-connection-store.ts";
import { createExchangeSendState, getExchangeMessageLink, getExchangeSendState, getExchangeSyncCursor,
  markExchangeMessagesRemoved, resetExchangeSyncCursor, saveExchangeSyncCursor, transitionExchangeSendState,
  upsertExchangeMessageLink } from "../lib/exchange-mail-store.ts";

const NOW = new Date("2026-10-14T10:00:00.000Z");
const scope = { tenantId: randomUUID(), mailboxId: randomUUID() };
const config = { ...scope, clientId: randomUUID() };
const later = seconds => new Date(NOW.valueOf() + seconds * 1000);
const cursorUrl = (folder = "inbox-id", token = "1") => `https://graph.microsoft.com/v1.0/users/${scope.mailboxId}/mailFolders/${encodeURIComponent(folder)}/messages/delta?$deltatoken=${token}`;
const cursorInput = context => ({ ...context, folderId: "inbox-id", expectedVersion: null, nextLink: null, deltaLink: cursorUrl() });
const message = changes => ({ id: "immutable-A", parentFolderId: "inbox-id", subject: "Client request", text: "History", internetMessageId: "<same@example.test>", from: { address: "client@example.test", name: "Client" }, toRecipients: [{ address: "bonjour@27pm.org" }], isRead: false, ...changes });

test("read-only getters never create a connection or mail state", async t => {
  const { db, sqlite } = await setup(t, false);
  assert.equal(await getExchangeMessageLink(db, scope, "missing"), null);
  assert.equal(await getExchangeSyncCursor(db, scope, "inbox-id"), null);
  assert.equal(await getExchangeSendState(db, scope, randomUUID()), null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM exchange_connections").get().count, 0);
});

test("cursor creation and advancement are single-CAS and preserve independent folders", async t => {
  const { db, context } = await setup(t);
  const input = cursorInput(context);
  const candidates = await Promise.all([saveExchangeSyncCursor(db, input, NOW), saveExchangeSyncCursor(db, input, NOW)]);
  assert.equal(candidates.filter(Boolean).length, 1);
  assert.equal(candidates.find(Boolean).version, 0);
  assert.equal(await saveExchangeSyncCursor(db, { ...input, expectedVersion: 5 }, NOW), null);
  const next = await saveExchangeSyncCursor(db, { ...input, expectedVersion: 0, deltaLink: null, nextLink: cursorUrl("inbox-id", "next") }, NOW);
  assert.equal(next.version, 1);
  assert.equal(next.deltaLink, null);
  assert.equal(await saveExchangeSyncCursor(db, { ...input, expectedVersion: 0 }, NOW), null);
  assert.ok(await saveExchangeSyncCursor(db, { ...input, folderId: "junk-id", deltaLink: cursorUrl("junk-id") }, NOW));
  assert.equal((await getExchangeSyncCursor(db, scope, "inbox-id")).version, 1);
});

test("cursor targets are pinned to exact Graph mailbox and folder; invalid pointers fail closed", async t => {
  const { db, context } = await setup(t);
  const input = cursorInput(context);
  for (const deltaLink of [cursorUrl().replace("graph.microsoft.com", "evil.example"), cursorUrl().replace(scope.mailboxId, randomUUID()), cursorUrl("different"), cursorUrl()+"#fragment", cursorUrl().replace("https://", "https://user:pass@"), "https://graph.microsoft.com/v1.0/users/x/sendMail", "x".repeat(17000), "\n" + cursorUrl()]) {
    assert.equal(await saveExchangeSyncCursor(db, { ...input, deltaLink }, NOW), null);
  }
  assert.equal(await saveExchangeSyncCursor(db, { ...input, nextLink: cursorUrl() }, NOW), null);
  assert.equal(await saveExchangeSyncCursor(db, { ...input, deltaLink: null }, NOW), null);
  assert.ok(await saveExchangeSyncCursor(db, input, NOW));
});

test("cursor persistence accepts Graph's documented OData-key canonical link", async t => {
  const { db, context } = await setup(t);
  const folder = "inbox-id";
  const canonical = `https://graph.microsoft.com/v1.0/users('${scope.mailboxId}')/mailFolders('${folder}')/messages/delta?$deltatoken=opaque`;
  const saved = await saveExchangeSyncCursor(db, { ...cursorInput(context), folderId: folder, deltaLink: canonical }, NOW);
  assert.equal(saved?.deltaLink, canonical);
});

test("all writers are fenced by owner, generation, identity, status and strict lease expiry", async t => {
  const { db, sqlite, context } = await setup(t);
  const commandId = seedCommand(sqlite);
  for (const [changed, time] of [
    [{ ...context, guard: { ...context.guard, owner: randomUUID() } }, NOW],
    [{ ...context, guard: { ...context.guard, generation: 1 } }, NOW],
    [{ ...context, scope: { ...scope, mailboxId: randomUUID() } }, NOW],
    [context, later(60)],
  ]) {
    assert.equal(await saveExchangeSyncCursor(db, cursorInput(changed), time), null);
    assert.equal(await upsertExchangeMessageLink(db, { ...changed, message: message() }, time), null);
    assert.equal(await createExchangeSendState(db, { ...changed, commandId, correlationId: randomUUID() }, time), null);
    assert.equal(await markExchangeMessagesRemoved(db, { ...changed, folderId: "inbox-id", graphMessageIds: ["immutable-A"] }, time), 0);
  }
  assert.ok(await saveExchangeSyncCursor(db, cursorInput(context), NOW));
  assert.ok(await disconnectConnection(db, { ...context.guard, version: 1 }, NOW));
  assert.equal(await resetExchangeSyncCursor(db, { ...context, folderId: "inbox-id", expectedVersion: 0 }, NOW), false);
  assert.equal(await upsertExchangeMessageLink(db, { ...context, message: message() }, NOW), null);
});

test("partial deltas retain absent fields and cannot merge distinct Graph items using spoofed RFC IDs", async t => {
  const { db, context } = await setup(t);
  const first = await upsertExchangeMessageLink(db, { ...context, message: message() }, NOW);
  assert.equal(first.internetMessageId, "<same@example.test>");
  const second = await upsertExchangeMessageLink(db, { ...context, message: message({ id: "immutable-B" }) }, NOW);
  assert.notEqual(first.id, second.id);
  const updated = await upsertExchangeMessageLink(db, { ...context, message: { id: "immutable-A", isRead: true } }, later(1));
  assert.deepEqual(JSON.parse(updated.messageJson), message({ isRead: true }));
  assert.equal(updated.folderId, "inbox-id");
  assert.equal(updated.internetMessageId, first.internetMessageId);
  const recipientChange = await upsertExchangeMessageLink(db, { ...context, message: { id: "immutable-A", from: { address: "another@example.test" } } }, NOW);
  assert.deepEqual(JSON.parse(recipientChange.messageJson).from, { address: "another@example.test" });
  assert.equal(await getExchangeMessageLink(db, { ...scope, tenantId: randomUUID() }, "immutable-A"), null);
});

test("projection links preserve CRM history and reject reassignment or cross-item linking", async t => {
  const { db, sqlite, context } = await setup(t);
  seedMessage(sqlite, "crm-A"); seedMessage(sqlite, "crm-B");
  const projection = { mailboxId: "mailbox_bonjour", crmMessageId: "crm-A", classification: "mapped" };
  assert.ok(await upsertExchangeMessageLink(db, { ...context, message: message(), projection }, NOW));
  const partial = await upsertExchangeMessageLink(db, { ...context, message: { id: "immutable-A", isRead: true } }, NOW);
  assert.equal(partial.crmMessageId, "crm-A");
  assert.equal(partial.logicalMailboxId, "mailbox_bonjour");
  assert.equal(partial.classification, "mapped");
  assert.equal(await upsertExchangeMessageLink(db, { ...context, message: message(), projection: { ...projection, crmMessageId: "crm-B" } }, NOW), null);
  assert.equal(await upsertExchangeMessageLink(db, { ...context, message: message(), projection: { ...projection, mailboxId: "mailbox_admin" } }, NOW), null);
  await assert.rejects(upsertExchangeMessageLink(db, { ...context, message: message({ id: "immutable-B" }), projection }, NOW));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 2);
});

test("folder removal is mirror-only, move-aware and replay-safe; cursor reset cannot erase history", async t => {
  const { db, sqlite, context } = await setup(t);
  seedMessage(sqlite, "crm-A");
  await upsertExchangeMessageLink(db, { ...context, message: message(), projection: { mailboxId: "mailbox_bonjour", crmMessageId: "crm-A", classification: "mapped" } }, NOW);
  await saveExchangeSyncCursor(db, cursorInput(context), NOW);
  await upsertExchangeMessageLink(db, { ...context, message: { id: "immutable-A", parentFolderId: "junk-id" } }, NOW);
  assert.equal(await markExchangeMessagesRemoved(db, { ...context, folderId: "inbox-id", graphMessageIds: ["immutable-A"] }, NOW), 0);
  assert.equal(await markExchangeMessagesRemoved(db, { ...context, folderId: "junk-id", graphMessageIds: ["immutable-A", "immutable-A"] }, NOW), 1);
  assert.equal(await markExchangeMessagesRemoved(db, { ...context, folderId: "junk-id", graphMessageIds: ["immutable-A"] }, NOW), 0);
  assert.equal((await getExchangeMessageLink(db, scope, "immutable-A")).remoteRemoved, 1);
  assert.equal(await resetExchangeSyncCursor(db, { ...context, folderId: "inbox-id", expectedVersion: 9 }, NOW), false);
  assert.equal(await resetExchangeSyncCursor(db, { ...context, folderId: "inbox-id", expectedVersion: 0 }, NOW), true);
  assert.equal(await getExchangeSyncCursor(db, scope, "inbox-id"), null);
  assert.equal(sqlite.prepare("SELECT text_body FROM messages WHERE id='crm-A'").get().text_body, "Original archive");
  assert.equal((await upsertExchangeMessageLink(db, { ...context, message: { id: "immutable-A", isRead: true } }, NOW)).remoteRemoved, 0);
});

test("unmapped/ambiguous items remain unprojected; unsupported payloads and secret-shaped properties are rejected", async t => {
  const { db, sqlite, context } = await setup(t);
  assert.equal((await upsertExchangeMessageLink(db, { ...context, message: message(), projection: { mailboxId: null, crmMessageId: null, classification: "ambiguous" } }, NOW)).crmMessageId, null);
  for (const invalid of [
    { ...message(), accessToken: "secret" }, { ...message(), subject: null }, { ...message(), isRead: "true" },
    { ...message(), from: { address: "client@example.test", refreshToken: "secret" } },
    { ...message(), headers: [{ name: "Authorization", value: "Bearer secret" }] },
    { ...message(), headers: [{ name: "message-id", value: "ok", secret: "secret" }] },
    { ...message(), text: "x".repeat(262145) }, { ...message(), commandId: "not-a-uuid" },
  ]) assert.equal(await upsertExchangeMessageLink(db, { ...context, message: invalid }, NOW), null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
  assert.doesNotMatch((await getExchangeMessageLink(db, scope, "immutable-A")).messageJson, /secret/u);
});

test("send state requires durable Exchange authorization and has unique command/correlation identities", async t => {
  const { db, sqlite, context } = await setup(t);
  for (const changes of [{ provider: "mailgun" }, { status: "pending" }, { confirmed: null }, { compliance: null }, { snapshot: null }]) {
    const commandId = seedCommand(sqlite, changes);
    assert.equal(await createExchangeSendState(db, { ...context, commandId, correlationId: randomUUID() }, NOW), null);
  }
  const commandId = seedCommand(sqlite);
  const correlationId = randomUUID();
  const row = await createExchangeSendState(db, { ...context, commandId, correlationId }, NOW);
  assert.equal(row.phase, "prepared"); assert.equal(row.version, 0); assert.equal(row.graphMessageId, null);
  assert.equal(await createExchangeSendState(db, { ...context, commandId, correlationId: randomUUID() }, NOW), null);
  assert.equal(await createExchangeSendState(db, { ...context, commandId: seedCommand(sqlite), correlationId }, NOW), null);
  assert.deepEqual(await getExchangeSendState(db, scope, commandId), row);
});

test("draft then submit is exactly one CAS; immutable draft ID cannot be swapped", async t => {
  const { db, sqlite, context } = await setup(t);
  const commandId = seedCommand(sqlite);
  await createExchangeSendState(db, { ...context, commandId, correlationId: randomUUID() }, NOW);
  const transition = { ...context, commandId, expectedVersion: 0, from: "prepared", to: "drafted" };
  assert.equal(await transitionExchangeSendState(db, transition, NOW), null);
  assert.equal(await transitionExchangeSendState(db, { ...transition, to: "send_requested", graphMessageId: "draft-A" }, NOW), null);
  assert.equal((await transitionExchangeSendState(db, { ...transition, graphMessageId: "draft-A" }, NOW)).version, 1);
  const send = { ...context, commandId, expectedVersion: 1, from: "drafted", to: "send_requested", graphMessageId: "draft-A" };
  assert.equal(await transitionExchangeSendState(db, { ...send, graphMessageId: "draft-B" }, NOW), null);
  assert.equal(await transitionExchangeSendState(db, { ...send, guard: { ...context.guard, generation: 99 } }, NOW), null);
  assert.equal(await transitionExchangeSendState(db, send, later(60)), null);
  const claims = await Promise.all([transitionExchangeSendState(db, send, NOW), transitionExchangeSendState(db, send, NOW)]);
  assert.equal(claims.filter(Boolean).length, 1);
  const accepted = await transitionExchangeSendState(db, { ...send, expectedVersion: 2, from: "send_requested", to: "accepted" }, NOW);
  assert.equal(accepted.phase, "accepted"); assert.equal(accepted.version, 3);
  for (const to of ["prepared", "drafted", "send_requested", "unknown", "manual_review", "rejected"])
    assert.equal(await transitionExchangeSendState(db, { ...send, expectedVersion: 3, from: "accepted", to }, NOW), null);
});

test("uncertain and rejected sends can never transition into another submission attempt", async t => {
  const { db, sqlite, context } = await setup(t);
  const commandId = seedCommand(sqlite);
  await createExchangeSendState(db, { ...context, commandId, correlationId: randomUUID() }, NOW);
  assert.ok(await transitionExchangeSendState(db, { ...context, commandId, expectedVersion: 0, from: "prepared", to: "unknown" }, NOW));
  for (const to of ["prepared", "drafted", "send_requested"])
    assert.equal(await transitionExchangeSendState(db, { ...context, commandId, expectedVersion: 1, from: "unknown", to, graphMessageId: "recovered-draft" }, NOW), null);
  assert.equal(await transitionExchangeSendState(db, { ...context, commandId, expectedVersion: 1, from: "unknown", to: "accepted" }, NOW), null);
  assert.ok(await transitionExchangeSendState(db, { ...context, commandId, expectedVersion: 1, from: "unknown", to: "accepted", graphMessageId: "confirmed-sent-item" }, NOW));
  const second = seedCommand(sqlite);
  await createExchangeSendState(db, { ...context, commandId: second, correlationId: randomUUID() }, NOW);
  assert.ok(await transitionExchangeSendState(db, { ...context, commandId: second, expectedVersion: 0, from: "prepared", to: "rejected" }, NOW));
  assert.equal(await transitionExchangeSendState(db, { ...context, commandId: second, expectedVersion: 1, from: "rejected", to: "drafted", graphMessageId: "x" }, NOW), null);

  const third = seedCommand(sqlite);
  await createExchangeSendState(db, { ...context, commandId: third, correlationId: randomUUID() }, NOW);
  const manual = await transitionExchangeSendState(db, {
    ...context, commandId: third, expectedVersion: 0, from: "prepared", to: "manual_review",
    graphMessageId: "correlated-draft",
  }, NOW);
  assert.equal(manual.phase, "manual_review");
  for (const to of ["prepared", "drafted", "send_requested", "unknown", "rejected"])
    assert.equal(await transitionExchangeSendState(db, { ...context, commandId: third, expectedVersion: 1, from: "manual_review", to, graphMessageId: "correlated-draft" }, NOW), null);
  assert.equal((await transitionExchangeSendState(db, {
    ...context, commandId: third, expectedVersion: 1, from: "manual_review", to: "accepted",
    graphMessageId: "correlated-draft",
  }, NOW)).phase, "accepted");
});

test("database constraints reject malformed persisted phases, mapping JSON and cursor ambiguity", async t => {
  const { db, sqlite, context } = await setup(t);
  await upsertExchangeMessageLink(db, { ...context, message: message() }, NOW);
  await saveExchangeSyncCursor(db, cursorInput(context), NOW);
  const commandId = seedCommand(sqlite);
  await createExchangeSendState(db, { ...context, commandId, correlationId: randomUUID() }, NOW);
  for (const query of [
    "UPDATE exchange_message_links SET message_json='[]'", "UPDATE exchange_message_links SET message_json='broken'",
    "UPDATE exchange_message_links SET classification='trusted'", "UPDATE exchange_sync_cursors SET next_link=delta_link",
    "UPDATE exchange_sync_cursors SET next_link=NULL,delta_link=NULL", "UPDATE exchange_send_state SET phase='accepted'",
    "UPDATE exchange_send_state SET phase='resend'", "UPDATE exchange_send_state SET version=-1",
  ]) assert.throws(() => sqlite.exec(query));
});

function seedCommand(sqlite, changes = {}) {
  const id = randomUUID();
  const value = { provider: "exchange", status: "dispatching", confirmed: NOW.toISOString(), compliance: "{}", snapshot: "{}", ...changes };
  sqlite.prepare(`INSERT INTO send_commands(id,idempotency_key,request_hash,mailbox_id,transport_provider,status,
    operator_confirmed_at,compliance_snapshot_json,message_snapshot_json) VALUES(?,?,?,'mailbox_alexis',?,?,?,?,?)`)
    .run(id, randomUUID(), "approved-hash", value.provider, value.status, value.confirmed, value.compliance, value.snapshot);
  return id;
}
function seedMessage(sqlite, id) {
  sqlite.prepare("INSERT INTO messages(id,conversation_id,mailbox_id,direction,sender,occurred_at,text_body,transport_provider) VALUES(?,'conversation','mailbox_bonjour','inbound','client@example.test',?,'Original archive','exchange')").run(id, NOW.toISOString());
}
async function setup(t, connected = true) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/u.test(name)).sort())
    sqlite.exec(await readFile(new URL(name, directory), "utf8"));
  for (const [local, purpose] of [["alexis", "sales"], ["bonjour", "sales"], ["admin", "operations"]])
    sqlite.prepare("INSERT OR IGNORE INTO mailboxes(id,address,local_part,display_name,purpose) VALUES(?,?,?,?,?)").run(`mailbox_${local}`, `${local}@27pm.org`, local, local, purpose);
  sqlite.exec("INSERT INTO conversations(id,mailbox_id,thread_key,last_message_at) VALUES('conversation','mailbox_bonjour','thread','2026-10-14')");
  const db = { prepare(query) {
    let values = [];
    const execute = () => {
      const statement = sqlite.prepare(query);
      const results = statement.columns().length ? statement.all(...values) : [];
      const changes = results.length ? sqlite.prepare("SELECT changes() AS n").get().n : statement.columns().length ? 0 : statement.run(...values).changes;
      return { success: true, results, meta: { changes } };
    };
    return { bind(...input) { values = input; return this; }, async first() { return sqlite.prepare(query).get(...values) ?? null; }, async all() { return { success: true, results: sqlite.prepare(query).all(...values) }; }, async run() { return execute(); }, execute };
  }, async batch(statements) { sqlite.exec("BEGIN"); try { const results = statements.map(statement => statement.execute()); sqlite.exec("COMMIT"); return results; } catch(error) { sqlite.exec("ROLLBACK"); throw error; } } };
  const context = { scope, guard: { owner: randomUUID(), generation: 0 } };
  if (connected) {
    await ensureConnection(db, config, NOW);
    await acquireConnectionLease(db, { owner: context.guard.owner }, NOW);
    assert.ok(await commitConnection(db, { ...context.guard, version: 0, status: "connected", credentialVersion: randomUUID() }, NOW));
  }
  return { db, sqlite, context };
}
