import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier,context,nextResolve) {
    if(specifier==="server-only") return {shortCircuit:true,url:"data:text/javascript,export {};"};
    if(specifier==="cloudflare:workers") return {shortCircuit:true,url:"data:text/javascript,export const env={};"};
    return nextResolve(specifier,context);
  }
`)}`, import.meta.url);
const { projectExchangeMessage } = await import("../lib/exchange-message-import.ts");
const { recordAcceptedOutboundMessage } = await import("../lib/accepted-outbound-message.ts");

const inbound = (changes = {}) => ({
  id: `graph-${randomUUID()}`, parentFolderId: "inbox-id", conversationId: `thread-${randomUUID()}`,
  from: { address: "client@example.com", name: "Client" }, toRecipients: [{ address: "alexis@27pm.org" }], ccRecipients: [],
  subject: "Demande", text: "Texte entrant", receivedDateTime: "2026-10-14T12:00:00.000Z",
  internetMessageId: "<incoming@example.com>", isRead: false, isDraft: false, ...changes,
});

test("unique known To/CC alias selects the correct logical CRM mailbox", async (t) => {
  const f = await fixture(t);
  for (const local of ["alexis", "bonjour", "admin"]) {
    const result = await projectExchangeMessage(f.db, "inbox", inbound({
      toRecipients: [{ address: "unrelated@example.com" }], ccRecipients: [{ address: `${local}@27pm.org` }],
    }));
    assert.equal(result.mailboxId, `mailbox_${local}`); assert.equal(result.classification, "mapped");
    const row = f.sqlite.prepare("SELECT * FROM messages WHERE id=?").get(result.crmMessageId);
    assert.equal(row.mailbox_id, `mailbox_${local}`); assert.equal(row.direction, "inbound");
    assert.equal(row.transport_provider, "exchange"); assert.equal(row.status, "received");
    assert.equal(row.external_message_id, null, "provider RFC IDs are not global deduplication keys");
  }
  assert.equal(f.count("messages"), 3);
  assert.equal(f.count("send_commands"), 0); assert.equal(f.count("audit_entries"), 0);
  assert.equal(f.sqlite.prepare("SELECT contact_basis FROM contacts WHERE email='client@example.com'").get().contact_basis, "unknown", "reception does not fabricate prospecting permission");
});

test("multi-alias and hidden/BCC-only delivery remain ambiguous without creating CRM history", async (t) => {
  const f = await fixture(t);
  for (const changes of [
    { toRecipients: [{ address: "alexis@27pm.org" }, { address: "bonjour@27pm.org" }] },
    { toRecipients: [{ address: "alexis@27pm.org" }], ccRecipients: [{ address: "admin@27pm.org" }] },
    { toRecipients: [{ address: "external@example.com" }], ccRecipients: [] },
    { toRecipients: [], ccRecipients: [] },
  ]) assert.deepEqual(await projectExchangeMessage(f.db, "inbox", inbound(changes)), { mailboxId: null, crmMessageId: null, classification: "ambiguous" });
  for (const table of ["messages", "conversations", "contacts", "deals", "send_commands", "audit_entries"]) assert.equal(f.count(table), 0);
});

test("Junk stays quarantined without creating CRM work", async (t) => {
  const f = await fixture(t); const message = inbound({ parentFolderId: "junk-id" });
  const result = await projectExchangeMessage(f.db, "junkemail", message);
  assert.deepEqual(result, { mailboxId: null, crmMessageId: null, classification: "unclassified" });
  for (const table of ["messages", "conversations", "contacts", "deals", "send_commands", "audit_entries"]) {
    assert.equal(f.count(table), 0);
  }
});

test("unread Inbox import is idempotent and replay does not undo an operator read", async (t) => {
  const f = await fixture(t); const message = inbound();
  const first = await projectExchangeMessage(f.db, "inbox", message);
  const conversationId = f.sqlite.prepare("SELECT conversation_id FROM messages WHERE id=?").get(first.crmMessageId).conversation_id;
  assert.equal(f.sqlite.prepare("SELECT is_unread FROM conversations WHERE id=?").get(conversationId).is_unread, 1);
  assert.deepEqual(await projectExchangeMessage(f.db, "inbox", message), first);
  f.sqlite.prepare("UPDATE conversations SET is_unread=0 WHERE id=?").run(conversationId);
  await projectExchangeMessage(f.db, "inbox", message);
  assert.equal(f.sqlite.prepare("SELECT is_unread FROM conversations WHERE id=?").get(conversationId).is_unread, 0);
  assert.equal(f.count("messages"), 1); assert.equal(f.count("conversations"), 1); assert.equal(f.count("deals"), 1);
});

test("external Sent Items stay external history on replay without invented send approval or audit", async (t) => {
  const f = await fixture(t);
  const message = inbound({ from: { address: "alexis@27pm.org" }, toRecipients: [{ address: "client@example.com" }], sentDateTime: "2026-10-14T12:00:00.000Z", isRead: true });
  const first = await projectExchangeMessage(f.db, "sentitems", message);
  const replay = await projectExchangeMessage(f.db, "sentitems", message);
  const row = f.sqlite.prepare("SELECT direction,tags_json,status FROM messages WHERE id=?").get(first.crmMessageId);
  assert.equal(row.direction, "outbound"); assert.equal(row.status, "accepted");
  assert.deepEqual(JSON.parse(row.tags_json), ["source-exchange", "external-history"]);
  for (const table of ["send_commands", "audit_entries", "deals"]) assert.equal(f.count(table), 0);
  assert.equal(f.count("messages"), 1); assert.equal(first.classification, "external_sent");
  assert.equal(replay.classification, "external_sent", "a replay must preserve externally-sent provenance");
});

test("an existing CRM-origin outbound message without external-history remains mapped", async (t) => {
  const f = await fixture(t);
  const message = inbound({ from: { address: "alexis@27pm.org" }, toRecipients: [{ address: "client@example.com" }], sentDateTime: "2026-10-14T12:00:00.000Z" });
  const row = await projectExchangeMessage(f.db, "sentitems", message);
  // Seed the trusted CRM-origin tag shape used by accepted-outbound-message.
  f.sqlite.prepare("UPDATE messages SET tags_json=?,traffic_type='prospecting' WHERE id=?")
    .run(JSON.stringify(["source-crm", "traffic-prospecting"]), row.crmMessageId);
  const replay = await projectExchangeMessage(f.db, "sentitems", message);
  assert.equal(replay.classification, "mapped"); assert.equal(replay.crmMessageId, row.crmMessageId);
  assert.equal(f.count("messages"), 1);
});

test("spoofed RFC IDs cannot join a different contact or mailbox; exact scoped reply can", async (t) => {
  const f = await fixture(t);
  f.sqlite.exec(`INSERT INTO contacts(id,email) VALUES('trusted-contact','trusted@example.com');
    INSERT INTO conversations(id,mailbox_id,contact_id,subject,thread_key,last_message_at)
      VALUES('trusted-conversation','mailbox_alexis','trusted-contact','Trusted','trusted-thread','2026-10-10T12:00:00.000Z');
    INSERT INTO messages(id,conversation_id,mailbox_id,direction,transport_provider,provider_message_id,external_message_id,sender,recipients_json,subject,status,occurred_at)
      VALUES('trusted-message','trusted-conversation','mailbox_alexis','outbound','mailgun','old-provider-id','<trusted@27pm.org>','alexis@27pm.org','["trusted@example.com"]','Trusted','delivered','2026-10-10T12:00:00.000Z');`);
  const base = { internetMessageId: "<trusted@27pm.org>", headers: [{ name: "in-reply-to", value: "<trusted@27pm.org>" }] };
  const otherContact = await projectExchangeMessage(f.db, "inbox", inbound({ ...base, from: { address: "attacker@example.com" } }));
  const otherMailbox = await projectExchangeMessage(f.db, "inbox", inbound({ ...base, from: { address: "trusted@example.com" }, toRecipients: [{ address: "bonjour@27pm.org" }] }));
  const actualReply = await projectExchangeMessage(f.db, "inbox", inbound({ ...base, from: { address: "trusted@example.com" } }));
  const conversation = result => f.sqlite.prepare("SELECT conversation_id FROM messages WHERE id=?").get(result.crmMessageId).conversation_id;
  assert.notEqual(conversation(otherContact), "trusted-conversation");
  assert.notEqual(conversation(otherMailbox), "trusted-conversation");
  assert.equal(conversation(actualReply), "trusted-conversation");
  assert.equal(f.count("messages"), 4, "three distinct immutable IDs remain three messages despite the same RFC ID");
});

test("threads an Exchange reply only through its exact mapped mailbox and contact", async (t) => {
  const f = await fixture(t);
  f.sqlite.exec(`INSERT INTO contacts(id,email) VALUES('exchange-contact','exchange-client@example.com');
    INSERT INTO conversations(id,mailbox_id,contact_id,subject,thread_key,last_message_at)
      VALUES('exchange-conversation','mailbox_alexis','exchange-contact','Exchange','exchange-thread','2026-10-10T12:00:00.000Z');
    INSERT INTO messages(id,conversation_id,mailbox_id,direction,transport_provider,provider_message_id,external_message_id,sender,recipients_json,subject,status,occurred_at)
      VALUES('exchange-parent','exchange-conversation','mailbox_alexis','outbound','exchange','graph-parent',NULL,'alexis@27pm.org','["exchange-client@example.com"]','Exchange','accepted','2026-10-10T12:00:00.000Z');
    INSERT INTO exchange_connections(id,tenant_id,mailbox_id,client_id,status)
      VALUES('alexis','a1234567-1234-1234-1234-123456789abc','b1234567-1234-1234-1234-123456789abc','c1234567-1234-1234-1234-123456789abc','disconnected');
    INSERT INTO exchange_message_links(id,connection_id,tenant_id,physical_mailbox_id,graph_message_id,crm_message_id,logical_mailbox_id,internet_message_id,folder_id,classification,message_json)
      VALUES('exchange-parent-link','alexis','a1234567-1234-1234-1234-123456789abc','b1234567-1234-1234-1234-123456789abc','graph-parent','exchange-parent','mailbox_alexis','<Exchange-Parent@Example.com>','sent-id','mapped','{}');`);
  const reply = await projectExchangeMessage(f.db, "inbox", inbound({
    from: { address: "exchange-client@example.com" },
    internetMessageId: "<exchange-reply@example.com>",
    headers: [{ name: "references", value: "<Exchange-Parent@Example.com>" }],
  }));
  const conversationId = f.sqlite.prepare("SELECT conversation_id FROM messages WHERE id=?").get(reply.crmMessageId).conversation_id;
  assert.equal(conversationId, "exchange-conversation");
});

test("an immediate Exchange reply joins the accepted send before Sent Items sync", async (t) => {
  const f = await fixture(t);
  f.sqlite.exec(`INSERT INTO contacts(id,email) VALUES('fast-contact','fast@example.com');
    INSERT INTO send_commands(id,idempotency_key,request_hash,mailbox_id,status,transport_provider,
      contact_id,provider_message_id,response_status)
      VALUES('fast-command','fast-key','fast-hash','mailbox_alexis','sent','exchange',
        'fast-contact','fast-draft',202);`);
  const conversationId = await recordAcceptedOutboundMessage(f.db, {
    commandId: "fast-command",
    contactId: "fast-contact",
    provider: "exchange",
    providerMessageId: "fast-draft",
    providerConversationId: "graph-conversation-fast",
    externalMessageId: null,
    mailbox: { id: "mailbox_alexis", address: "alexis@27pm.org", purpose: "sales" },
    recipient: "fast@example.com",
    subject: "Échange rapide",
    text: "Message sortant",
    html: null,
    actorEmail: "alexis@27pm.org",
    occurredAt: "2026-10-14T11:59:00.000Z",
  });
  const reply = await projectExchangeMessage(f.db, "inbox", inbound({
    conversationId: "graph-conversation-fast",
    from: { address: "fast@example.com", name: "Fast" },
    subject: "RE: Échange rapide",
    internetMessageId: "<fast-reply@example.com>",
  }));
  assert.equal(
    f.sqlite.prepare("SELECT conversation_id FROM messages WHERE id=?").get(reply.crmMessageId).conversation_id,
    conversationId,
  );
  assert.equal(f.count("conversations"), 1);
  assert.equal(f.count("deals"), 1);
});

test("conversation update failure rolls back the message atomically, then replay completes unread projection", async (t) => {
  const f = await fixture(t); const message = inbound();
  let fail = true;
  f.hooks.beforeRun = query => {
    if (fail && query.startsWith("UPDATE conversations SET")) { fail = false; throw new Error("injected conversation update failure"); }
  };
  await assert.rejects(projectExchangeMessage(f.db, "inbox", message), /exchange_message_persistence_failed/u);
  assert.equal(f.count("messages"), 0, "message and conversation summary must commit together");
  await projectExchangeMessage(f.db, "inbox", message);
  assert.equal(f.count("messages"), 1);
  assert.equal(f.sqlite.prepare("SELECT c.is_unread FROM conversations c JOIN messages m ON m.conversation_id=c.id WHERE m.provider_message_id=?").get(message.id).is_unread, 1, "cursor replay must repair the incomplete projection");
});

test("lost batch acknowledgement does not duplicate history or undo a later operator read", async (t) => {
  const f = await fixture(t); const message = inbound(); let fail = true;
  f.hooks.afterBatch = () => { if (fail) { fail = false; throw new Error("injected acknowledgement loss"); } };
  await assert.rejects(projectExchangeMessage(f.db, "inbox", message), /exchange_message_persistence_failed/u);
  const conversation = f.sqlite.prepare("SELECT conversation_id FROM messages WHERE provider_message_id=?").get(message.id).conversation_id;
  assert.equal(f.count("messages"), 1);
  f.sqlite.prepare("UPDATE conversations SET is_unread=0 WHERE id=?").run(conversation);
  await projectExchangeMessage(f.db, "inbox", message);
  assert.equal(f.count("messages"), 1);
  assert.equal(f.sqlite.prepare("SELECT is_unread FROM conversations WHERE id=?").get(conversation).is_unread, 0);
});

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close()); sqlite.exec("PRAGMA foreign_keys=ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/u.test(name)).sort()) {
    for (const statement of (await readFile(new URL(name, directory), "utf8")).split("--> statement-breakpoint")) if (statement.trim()) sqlite.exec(statement);
  }
  const hooks = {};
  const db = { prepare(query) {
    let values = [];
    const execute = () => {
      hooks.beforeRun?.(query, values);
      const statement = sqlite.prepare(query);
      const results = statement.columns().length ? statement.all(...values) : undefined;
      const changes = results ? sqlite.prepare("SELECT changes() AS n").get().n : statement.run(...values).changes;
      return { results, success: true, meta: { changes } };
    };
    return {
      bind(...input) { values = input; return this; }, execute,
      async first() { return sqlite.prepare(query).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(query).all(...values), success: true }; },
      async run() { return execute(); },
    };
  }, async batch(statements) {
    sqlite.exec("BEGIN"); let result;
    try { result = statements.map(statement => statement.execute()); sqlite.exec("COMMIT"); }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    hooks.afterBatch?.(); return result;
  } };
  // Migrations include demo contacts/conversations/deals; assert only this operation's additions.
  const baseline = new Map(["messages", "conversations", "contacts", "deals", "send_commands", "audit_entries"].map(table => [table, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  const count = table => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n - baseline.get(table);
  return { db, sqlite, hooks, count };
}
