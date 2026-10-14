import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { acquireConnectionLease, commitConnection, ensureConnection } from "../lib/exchange-connection-store.ts";
import { createExchangeSendState, markExchangeMessagesRemoved, saveExchangeSyncCursor, transitionExchangeSendState, upsertExchangeMessageLink } from "../lib/exchange-mail-store.ts";

const directory = new URL("../drizzle/", import.meta.url);
const names = (await readdir(directory)).filter(name => /^\d+_.+\.sql$/u.test(name) && name < "0022").sort();
const sql = await Promise.all(names.map(name => readFile(new URL(name, directory), "utf8")));
const previous = sql.slice(0, -1).flatMap(split);
const migration = split(sql.at(-1));
assert.equal(names.at(-1), "0021_furry_the_anarchist.sql");
function split(source) { return source.split("--> statement-breakpoint").filter(value => value.trim()); }
const seed = [
  "INSERT OR IGNORE INTO mailboxes(id,address,local_part,display_name,purpose) VALUES('mailbox_alexis','alexis@27pm.org','alexis','Alexis','sales')",
  "INSERT INTO conversations(id,mailbox_id,thread_key,last_message_at) VALUES('migration-conversation','mailbox_alexis','migration-thread','2026-10-14')",
  ...[["42", "mailgun"], ["-15", "cakemail"], ["9007199254740993", "mailgun"]].map(([rowid, provider]) =>
    `INSERT INTO messages(rowid,id,conversation_id,mailbox_id,direction,sender,occurred_at,transport_provider,provider_message_id,external_message_id,text_body,headers_json)
     VALUES(${rowid},'legacy-${rowid}','migration-conversation','mailbox_alexis','inbound','client@example.test','2026-10-14','${provider}','provider-${rowid}','<legacy-${rowid}@example.test>','History ${rowid}','{"x-sentinel":"yes"}')`),
  "INSERT INTO attachments(rowid,id,message_id,r2_key,file_name,size_bytes,sha256,scan_status) VALUES(901,'sentinel-attachment','legacy-42','archive/key','proof.pdf',55,'abc','clean')",
  "INSERT INTO message_events(rowid,id,message_id,callback_key,event_type,event_timestamp,payload_json,transport_provider,provider_message_id) VALUES(902,'sentinel-event','legacy-42','sentinel-callback','delivered','2026-10-14','{\"original\":true}','mailgun','provider-42')",
  ...[["-5", "mailgun"], ["9007199254740994", "cakemail"]].map(([rowid, provider]) =>
    `INSERT INTO send_commands(rowid,id,idempotency_key,request_hash,mailbox_id,status,transport_provider,provider_message_id,operator_confirmed_at,compliance_snapshot_json,message_snapshot_json)
      VALUES(${rowid},'command-${rowid}','key-${rowid}','hash-${rowid}','mailbox_alexis','sent','${provider}','sent-${rowid}','2026-10-14','{"confirmed":true}','{"text":"legacy"}')`),
  "INSERT INTO webhook_receipts(id,kind,signature_token,signature_timestamp,callback_key) VALUES(900,'inbound','signature-900','123','receipt-900')",
  "INSERT INTO webhook_receipts(id,kind,signature_token,signature_timestamp,callback_key) VALUES(1000,'event','signature-1000','123','receipt-1000')",
  "DELETE FROM webhook_receipts WHERE id=1000",
  "CREATE TABLE migration_trigger_observation(value TEXT)",
  "CREATE TRIGGER migration_subject_sentinel AFTER UPDATE OF subject ON messages BEGIN INSERT INTO migration_trigger_observation VALUES(NEW.id); END",
];

for (const runtime of ["sqlite", "d1"]) {
  test(`0021 ${runtime}: preserves every legacy row, rowid, child, index, trigger, FK and sequence`, { timeout: 30000 }, async t => {
    const db = runtime === "sqlite" ? sqliteDb(t) : await nativeD1(t);
    for (const query of previous) await db.run(query);
    for (const query of seed) await db.run(query);
    const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name")).map(row => row.name);
    const before = await snapshot(db, tables);
    assert.ok(before.rows.messages.some(row => row.__rowid === "9007199254740993"));
    assert.deepEqual(before.rows.attachments.map(row => row.message_id), ["legacy-42"]);
    assert.deepEqual(before.rows.message_events.map(row => row.message_id), ["legacy-42"]);
    assert.equal(before.rows.sqlite_sequence.find(row => row.name === "webhook_receipts").seq, 1000);
    assert.doesNotMatch(sql.at(-1).replace(/^--.*$/gmu, ""), /DROP TABLE|PRAGMA foreign_keys\s*=\s*OFF/iu);
    assert.doesNotMatch(sql.at(-1), /ALTER TABLE `?(message_events|webhook_receipts)`?/u);
    await db.batch(migration);
    assert.deepEqual(await snapshot(db, tables), before);
    assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
    assert.equal((await db.all("PRAGMA foreign_keys"))[0].foreign_keys, 1);
    await db.run("INSERT INTO messages(id,conversation_id,mailbox_id,direction,sender,occurred_at,transport_provider) VALUES('graph-1','migration-conversation','mailbox_alexis','inbound','client@example.test','2026-10-14','exchange')");
    await db.run("INSERT INTO messages(id,conversation_id,mailbox_id,direction,sender,occurred_at,transport_provider) VALUES('graph-2','migration-conversation','mailbox_alexis','inbound','client@example.test','2026-10-14','exchange')");
    await db.run("INSERT INTO send_commands(id,idempotency_key,request_hash,mailbox_id,transport_provider) VALUES('graph-command','graph-key','hash','mailbox_alexis','exchange')");
    await assert.rejects(db.run("UPDATE messages SET transport_provider='arbitrary' WHERE id='graph-1'"));
    await assert.rejects(db.run("UPDATE send_commands SET transport_provider='arbitrary' WHERE id='graph-command'"));
    await assert.rejects(db.run("UPDATE message_events SET transport_provider='exchange' WHERE id='sentinel-event'"));
    await assert.rejects(db.run("UPDATE webhook_receipts SET transport_provider='exchange' WHERE id=900"));
    await assert.rejects(db.run("UPDATE messages SET external_message_id='<legacy-42@example.test>' WHERE id='graph-1'"));
    await assert.rejects(db.run("UPDATE messages SET provider_message_id='provider-42',transport_provider='mailgun' WHERE id='graph-1'"));
    await db.run("UPDATE messages SET subject='trigger check' WHERE id='graph-1'");
    assert.deepEqual(await db.all("SELECT * FROM migration_trigger_observation"), [{ value: "graph-1" }]);
  });
}

test("0021 native D1 batch rollback leaves history and schema unchanged on a late migration failure", { timeout: 30000 }, async t => {
  const db = await nativeD1(t);
  for (const query of previous) await db.run(query);
  for (const query of seed) await db.run(query);
  const tables = (await db.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '_cf_%' ORDER BY name")).map(row => row.name);
  const before = await snapshot(db, tables);
  const schemaBefore = await db.all("SELECT type,name,sql FROM sqlite_master ORDER BY type,name");
  await assert.rejects(db.batch([...migration, "INSERT INTO nonexistent_migration_guard VALUES(1)"]));
  assert.deepEqual(await snapshot(db, tables), before);
  assert.deepEqual(await db.all("SELECT type,name,sql FROM sqlite_master ORDER BY type,name"), schemaBefore);
  assert.deepEqual(await db.all("PRAGMA foreign_key_check"), []);
});

test("0021 native D1 executes mail-store JSON merging, cursor CAS and exactly-once send transitions", { timeout: 30000 }, async t => {
  const db = await nativeD1(t);
  for (const query of previous) await db.run(query);
  await db.batch(migration);
  const now = new Date("2026-10-14T12:00:00.000Z");
  const scope = { tenantId: randomUUID(), mailboxId: randomUUID() };
  const guard = { owner: randomUUID(), generation: 0 };
  await ensureConnection(db, { ...scope, clientId: randomUUID() }, now);
  await acquireConnectionLease(db, { owner: guard.owner }, now);
  assert.ok(await commitConnection(db, { ...guard, version: 0, status: "connected", credentialVersion: randomUUID() }, now));
  const first = { id: "graph-id", subject: "History", from: { address: "client@example.test", name: "Old name" }, parentFolderId: "folder" };
  assert.ok(await upsertExchangeMessageLink(db, { scope, guard, message: first }, now));
  const updated = await upsertExchangeMessageLink(db, { scope, guard, message: { id: "graph-id", isRead: true, from: { address: "new@example.test" } } }, now);
  assert.deepEqual(JSON.parse(updated.messageJson), { ...first, isRead: true, from: { address: "new@example.test" } });
  assert.equal(await markExchangeMessagesRemoved(db, { scope, guard, folderId: "folder", graphMessageIds: ["graph-id"] }, now), 1);
  const input = { scope, guard, folderId: "folder", expectedVersion: null, nextLink: null, deltaLink: `https://graph.microsoft.com/v1.0/users/${scope.mailboxId}/mailFolders/folder/messages/delta?$deltatoken=opaque` };
  assert.equal((await saveExchangeSyncCursor(db, input, now)).version, 0);
  assert.equal(await saveExchangeSyncCursor(db, input, now), null);
  const commandId = randomUUID();
  await db.run(seed[0]);
  await db.prepare("INSERT INTO send_commands(id,idempotency_key,request_hash,mailbox_id,status,transport_provider,operator_confirmed_at,compliance_snapshot_json,message_snapshot_json) VALUES(?,?,?,'mailbox_alexis','dispatching','exchange',?,'{}','{}')").bind(commandId, commandId, "hash", now.toISOString()).run();
  assert.equal((await createExchangeSendState(db, { scope, guard, commandId, correlationId: commandId }, now)).phase, "prepared");
  const transition = { scope, guard, commandId, expectedVersion: 0, from: "prepared", to: "drafted", graphMessageId: "draft-id" };
  assert.equal((await transitionExchangeSendState(db, transition, now)).version, 1);
  const send = { ...transition, expectedVersion: 1, from: "drafted", to: "send_requested" };
  const claims = await Promise.all([transitionExchangeSendState(db, send, now), transitionExchangeSendState(db, send, now)]);
  assert.equal(claims.filter(Boolean).length, 1);
});

async function snapshot(db, tables) {
  const result = { rows: {}, indexes: {}, foreignKeys: {}, triggers: await db.all("SELECT name,tbl_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name") };
  for (const table of tables) {
    const quote = '"' + table.replaceAll('"', '""') + '"';
    result.rows[table] = await db.all(`SELECT CAST(rowid AS TEXT) AS __rowid,* FROM ${quote} ORDER BY rowid`);
    result.indexes[table] = [];
    for (const { name, unique, origin, partial } of (await db.all(`PRAGMA index_list(${quote})`)).sort((a,b) => a.name.localeCompare(b.name))) {
      // Physical column positions move, not the index's columns or semantics.
      result.indexes[table].push({ name, unique, origin, partial, columns: (await db.all(`PRAGMA index_info('${name}')`)).map(row => row.name) });
    }
    result.foreignKeys[table] = await db.all(`PRAGMA foreign_key_list(${quote})`);
  }
  return result;
}

function sqliteDb(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys=ON");
  return {
    async run(sql) { db.exec(sql); },
    async all(sql) { return db.prepare(sql).all().map(row => ({ ...row })); },
    async batch(queries) {
      db.exec("BEGIN");
      try { for (const query of queries) db.exec(query); db.exec("COMMIT"); }
      catch(error) { db.exec("ROLLBACK"); throw error; }
    },
  };
}

async function nativeD1(t) {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-09-11", compatibilityFlags: ["nodejs_compat"], d1Databases: { DB: randomUUID() },
    script: `export default { async fetch(request, env) {
      const {queries,batch}=await request.json();
      try { const statements=queries.map(value=>typeof value==='string' ? env.DB.prepare(value) : env.DB.prepare(value.query).bind(...value.values));
        return Response.json(batch ? await env.DB.batch(statements) : await statements[0].all());
      } catch { return Response.json({failed:true}); }
    } };`,
  }));
  t.after(() => mf.dispose());
  async function call(queries, batch = false) {
    const response = await mf.dispatchFetch("http://local.invalid", { method: "POST", body: JSON.stringify({queries,batch}) });
    assert.equal(response.status, 200);
    const data = await response.json();
    if (data.failed) throw new Error("native D1 rejected query");
    return data;
  }
  return { async run(query) { return call([query]); }, async all(query) { return (await call([query])).results; }, async batch(queries) { return call(queries, true); },
    prepare(query) {
      const statement = { query, values: [], bind(...values) { statement.values = values; return statement; },
        async first() { return (await call([statement])).results[0] ?? null; },
        async all() { return call([statement]); }, async run() { return call([statement]); } };
      return statement;
    },
  };
}
