import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
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

const { syncExchangeFolder } = await import("../lib/exchange-sync-service.ts");
const { ensureConnection } = await import("../lib/exchange-connection-store.ts");
const { writeExchangeCredential } = await import("../lib/exchange-token-vault.ts");
const { getExchangeSyncCursor, getExchangeMessageLink } = await import("../lib/exchange-mail-store.ts");

const CONFIG = {
  tenantId: "a1234567-1234-1234-1234-123456789abc", mailboxId: "b1234567-1234-1234-1234-123456789abc",
  clientId: "c1234567-1234-1234-1234-123456789abc", clientSecret: "synthetic-fixture-secret",
  publicOrigin: "https://crm.example.com", callbackOrigin: "https://api.example.com",
};
const VAULT = { ...CONFIG, encryptionKey: Buffer.alloc(32, 8).toString("base64url") };
const BASE = `https://graph.microsoft.com/v1.0/users/${CONFIG.mailboxId}`;
const id = "immutable-inbound-item";
const deltaPath = name => `${BASE}/mailFolders/folder-${name}/messages/delta`;
const deltaLink = (name, token = "fixture") => `${deltaPath(name)}?$deltatoken=${token}`;
const providerMessage = (changes = {}) => ({
  id, parentFolderId: "folder-inbox", conversationId: "provider-thread",
  subject: "Question", body: { contentType: "text", content: "Texte conservé" },
  from: { emailAddress: { address: "client@example.com", name: "Client" } },
  toRecipients: [{ emailAddress: { address: "alexis@27pm.org" } }], ccRecipients: [], replyTo: [],
  receivedDateTime: "2026-10-14T12:00:00.000Z", isRead: false, isDraft: false,
  internetMessageId: "<incoming@example.com>", ...changes,
});

test("one bounded page projects an unread message, persists cursor, and replay is idempotent", async (t) => {
  const f = await fixture(t); f.details.set(id, providerMessage());
  const first = await syncExchangeFolder(f.ctx, "inbox");
  assert.deepEqual(first, { folder: "inbox", processed: 1, removed: 0, ambiguous: 0, externalSent: 0, more: false, deltaReset: false });
  assert.equal(f.count("messages"), 1);
  assert.equal((await f.cursor("inbox")).deltaLink, deltaLink("inbox"));
  assert.equal((await f.link(id)).classification, "mapped");
  const conversation = f.sqlite.prepare("SELECT conversation_id FROM messages WHERE provider_message_id=?").get(id).conversation_id;
  assert.equal(f.sqlite.prepare("SELECT is_unread FROM conversations WHERE id=?").get(conversation).is_unread, 1);
  f.sqlite.prepare("UPDATE conversations SET is_unread=0 WHERE id=?").run(conversation);
  await syncExchangeFolder(f.ctx, "inbox");
  assert.equal(f.count("messages"), 1); assert.equal(f.count("exchange_message_links"), 1);
  assert.equal(f.sqlite.prepare("SELECT is_unread FROM conversations WHERE id=?").get(conversation).is_unread, 0);
  assert.equal(f.graphCalls.filter(call => call.url.includes("/messages/delta"))[1].url, deltaLink("inbox"));
  assert.ok(f.graphCalls.every(call => call.method === "GET"), "sync cannot send, mark read or delete at Microsoft");
});

test("ambiguous multi-alias and BCC-only items stay quarantined in the mirror", async (t) => {
  const f = await fixture(t);
  f.details.set("multi", providerMessage({ id: "multi", toRecipients: [{ emailAddress: { address: "alexis@27pm.org" } }, { emailAddress: { address: "bonjour@27pm.org" } }] }));
  f.details.set("bcc", providerMessage({ id: "bcc", toRecipients: [], ccRecipients: [] }));
  f.hooks.page = () => ({ value: [{ id: "multi" }, { id: "bcc" }], "@odata.deltaLink": deltaLink("inbox") });
  const result = await syncExchangeFolder(f.ctx, "inbox");
  assert.equal(result.ambiguous, 2); assert.equal(result.processed, 2);
  assert.equal(f.count("messages"), 0); assert.equal(f.count("contacts"), 0);
  for (const item of ["multi", "bcc"]) {
    const row = await f.link(item); assert.equal(row.classification, "ambiguous"); assert.equal(row.crmMessageId, null);
  }
  assert.equal((await f.cursor("inbox")).deltaLink, deltaLink("inbox"));
});

test("Junk is mirrored without creating CRM contacts, conversations, or deals", async (t) => {
  const f = await fixture(t);
  f.details.set(id, providerMessage({ parentFolderId: "folder-junkemail" }));
  const result = await syncExchangeFolder(f.ctx, "junkemail");
  assert.equal(result.processed, 1);
  assert.equal((await f.link(id)).classification, "unclassified");
  for (const table of ["messages", "contacts", "conversations", "deals"]) {
    assert.equal(f.count(table), 0);
  }
});

test("Sent Items sync creates external history without send commands or operator send audit", async (t) => {
  const f = await fixture(t);
  f.details.set(id, providerMessage({ parentFolderId: "folder-sentitems", from: { emailAddress: { address: "alexis@27pm.org" } }, toRecipients: [{ emailAddress: { address: "client@example.com" } }], sentDateTime: "2026-10-14T12:00:00.000Z", isRead: true }));
  const result = await syncExchangeFolder(f.ctx, "sentitems");
  assert.equal(result.externalSent, 1); assert.equal(f.count("messages"), 1);
  assert.equal((await f.link(id)).classification, "external_sent");
  for (const table of ["send_commands", "exchange_send_state", "audit_entries", "deals"]) assert.equal(f.count(table), 0);
});

test("tombstone and expired delta reset never delete CRM history and never auto-retry the provider", async (t) => {
  const f = await fixture(t); f.details.set(id, providerMessage());
  await syncExchangeFolder(f.ctx, "inbox");
  f.hooks.page = () => ({ value: [{ id, "@removed": { reason: "deleted" } }], "@odata.deltaLink": deltaLink("inbox", "removed") });
  const removed = await syncExchangeFolder(f.ctx, "inbox");
  assert.equal(removed.removed, 1); assert.equal((await f.link(id)).remoteRemoved, 1); assert.equal(f.count("messages"), 1);
  const beforeReset = f.graphCalls.length;
  f.hooks.page = () => new Response(null, { status: 410 });
  const reset = await syncExchangeFolder(f.ctx, "inbox");
  assert.equal(reset.deltaReset, true); assert.equal(reset.more, true); assert.equal(reset.processed, 0);
  assert.equal(f.graphCalls.length - beforeReset, 2, "one folder lookup and one expired delta call, no automatic initial retry");
  assert.equal(await f.cursor("inbox"), null); assert.equal(f.count("messages"), 1); assert.equal(f.count("exchange_message_links"), 1);
  assert.equal(f.sqlite.prepare("SELECT text_body FROM messages WHERE provider_message_id=?").get(id).text_body, "Texte conservé");
  f.hooks.page = undefined;
  await syncExchangeFolder(f.ctx, "inbox");
  assert.equal(f.count("messages"), 1); assert.equal((await f.link(id)).remoteRemoved, 0);
});

test("a failed cursor write replays the page without duplicating already committed messages", async (t) => {
  const f = await fixture(t); f.details.set(id, providerMessage()); let refuse = true;
  f.hooks.beforeFirst = query => {
    if (refuse && query.startsWith("INSERT INTO exchange_sync_cursors")) { refuse = false; return { override: true, value: null }; }
  };
  await assert.rejects(syncExchangeFolder(f.ctx, "inbox"), /exchange_sync_cursor_persistence_failed/u);
  assert.equal(await f.cursor("inbox"), null); assert.equal(f.count("messages"), 1);
  await syncExchangeFolder(f.ctx, "inbox");
  assert.equal(f.count("messages"), 1); assert.equal(f.count("exchange_message_links"), 1);
  assert.equal((await f.cursor("inbox")).version, 0);
  const pages = f.graphCalls.filter(call => call.url.includes("/messages/delta"));
  assert.equal(pages.length, 2); assert.equal(pages[0].url, pages[1].url);
});

test("a detail 404 leaves the cursor unchanged instead of silently losing a message", async (t) => {
  const f = await fixture(t); f.details.set(id, providerMessage());
  await syncExchangeFolder(f.ctx, "inbox");
  const before = await f.link(id); f.details.delete(id);
  f.hooks.page = () => ({ value: [{ id, isRead: true }], "@odata.deltaLink": deltaLink("inbox", "moved") });
  await assert.rejects(syncExchangeFolder(f.ctx, "inbox"), /exchange_graph_not_found/u);
  const after = await f.link(id);
  assert.equal(f.count("messages"), 1);
  assert.equal(after.classification, before.classification); assert.equal(after.crmMessageId, before.crmMessageId);
  assert.equal(JSON.parse(after.messageJson).text, "Texte conservé");
  assert.equal(JSON.parse(after.messageJson).isRead, false);
  assert.equal((await f.cursor("inbox")).deltaLink, deltaLink("inbox"));
  f.hooks.page = () => ({ value: [{ id: "new-404", isRead: false }], "@odata.deltaLink": deltaLink("inbox", "moved2") });
  await assert.rejects(syncExchangeFolder(f.ctx, "inbox"), /exchange_graph_not_found/u);
  assert.equal(f.count("messages"), 1); assert.equal(await f.link("new-404"), null);
  assert.equal((await f.cursor("inbox")).deltaLink, deltaLink("inbox"));
});

test("nextLink is persisted unchanged and only a later explicit sync reads the next page", async (t) => {
  const f = await fixture(t);
  const next = `${deltaPath("inbox")}?$skiptoken=opaque%2B%2F%3D`;
  f.hooks.page = () => ({ value: [], "@odata.nextLink": next });
  const first = await syncExchangeFolder(f.ctx, "inbox");
  assert.equal(first.more, true); assert.equal((await f.cursor("inbox")).nextLink, next);
  assert.equal(f.graphCalls.filter(call => call.url.includes("/messages/delta")).length, 1);
  f.hooks.page = () => ({ value: [], "@odata.deltaLink": deltaLink("inbox", "completed") });
  assert.equal((await syncExchangeFolder(f.ctx, "inbox")).more, false);
  assert.equal(f.graphCalls.filter(call => call.url.includes("/messages/delta"))[1].url, next);
});

test("lease loss after provider detail read fences CRM projection as well as the mirror and cursor", async (t) => {
  const f = await fixture(t); f.details.set(id, providerMessage());
  f.hooks.afterDetail = () => f.sqlite.exec("UPDATE exchange_connections SET lease_expires_at='2000-01-01T00:00:00.000Z'");
  await assert.rejects(syncExchangeFolder(f.ctx, "inbox"));
  assert.equal(f.count("messages"), 0, "a revoked/expired operation cannot continue writing CRM history");
  assert.equal(f.count("exchange_message_links"), 0); assert.equal(await f.cursor("inbox"), null);
});

test("the SQL fence rejects lease loss between the application guard and the message batch", async (t) => {
  const f = await fixture(t); f.details.set(id, providerMessage());
  f.hooks.beforeBatch = () => f.sqlite.exec("UPDATE exchange_connections SET lease_expires_at='2000-01-01T00:00:00.000Z'");
  await assert.rejects(syncExchangeFolder(f.ctx, "inbox"), /exchange_message_persistence_failed/u);
  assert.equal(f.count("messages"), 0); assert.equal(f.count("exchange_message_links"), 0);
  assert.equal(await f.cursor("inbox"), null);
});

for (const [stage, prefix] of [
  ["contact", "INSERT INTO contacts"],
  ["conversation", "INSERT OR IGNORE INTO conversations"],
  ["deal", "INSERT OR IGNORE INTO deals"],
]) {
  test(`lease expiry after the ${stage} write rolls back every first-seen inbound side effect`, async (t) => {
    const f = await fixture(t); f.details.set(id, providerMessage());
    let expire = true;
    f.hooks.afterRun = (query) => {
      if (expire && query.startsWith(prefix)) {
        expire = false;
        f.sqlite.exec("UPDATE exchange_connections SET lease_expires_at='2000-01-01T00:00:00.000Z'");
      }
    };
    await assert.rejects(syncExchangeFolder(f.ctx, "inbox"), /exchange_message_persistence_failed/u);
    for (const table of ["contacts", "conversations", "deals", "messages"]) {
      assert.equal(f.count(table), 0, `${table} must roll back after ${stage} expiry`);
    }
    assert.equal(f.count("exchange_message_links"), 0);
    assert.equal(await f.cursor("inbox"), null);
  });
}

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
      const statement = sqlite.prepare(query); const results = statement.columns().length ? statement.all(...values) : undefined;
      const changes = results ? sqlite.prepare("SELECT changes() AS n").get().n : statement.run(...values).changes;
      hooks.afterRun?.(query, values);
      return { results, success: true, meta: { changes } };
    };
    return {
      query, bind(...input) { values = input; return this; }, execute,
      async first() { const override = hooks.beforeFirst?.(query, values); return override?.override ? override.value : sqlite.prepare(query).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(query).all(...values), success: true }; },
      async run() { return execute(); },
    };
  }, async batch(statements) {
    hooks.beforeBatch?.();
    sqlite.exec("BEGIN");
    try { const result = statements.map(statement => statement.execute()); sqlite.exec("COMMIT"); return result; }
    catch (error) { sqlite.exec("ROLLBACK"); throw error; }
  } };
  const objects = new Map(); let revision = 0;
  const bucket = {
    async get(key) {
      const entry = objects.get(key); if (!entry) return null;
      return { etag: entry.etag, size: entry.bytes.length, body: new ReadableStream({ start(c) { c.enqueue(entry.bytes.slice()); c.close(); } }) };
    },
    async put(key, bytes, options) {
      const previous = objects.get(key);
      if (options.onlyIf.etagDoesNotMatch === "*" && previous) return null;
      if (options.onlyIf.etagMatches && previous?.etag !== options.onlyIf.etagMatches) return null;
      const etag = createHash("sha256").update(bytes).update(String(++revision)).digest("hex");
      objects.set(key, { bytes: bytes.slice(), etag }); return { etag };
    },
  };
  await ensureConnection(db, CONFIG); const version = randomUUID();
  await writeExchangeCredential(bucket, VAULT, `credential:${version}`, { refreshToken: "synthetic-initial-refresh" }, { expectedEtag: null });
  sqlite.prepare("UPDATE exchange_connections SET status='connected',credential_version=? WHERE id='alexis'").run(version);
  const details = new Map(); const graphCalls = []; let sequence = 0;
  const fetcher = async (url, init) => {
    const endpoint = String(url);
    if (endpoint === `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`) {
      sequence += 1;
      return Response.json({ token_type: "Bearer", scope: "Mail.ReadWrite Mail.Send openid profile", expires_in: 3600,
        access_token: `synthetic-access-${sequence}`, refresh_token: `synthetic-refresh-${sequence}` });
    }
    assert.equal(init.method, "GET"); graphCalls.push({ url: endpoint, method: init.method });
    assert.ok(endpoint.startsWith(BASE + "/"));
    const parsed = new URL(endpoint);
    const folder = /\/mailFolders\/(inbox|junkemail|sentitems)$/u.exec(parsed.pathname)?.[1];
    if (folder) return Response.json({ id: `folder-${folder}` });
    const deltaFolder = /\/mailFolders\/folder-(inbox|junkemail|sentitems)\/messages\/delta$/u.exec(parsed.pathname)?.[1];
    if (deltaFolder) {
      const page = hooks.page?.(endpoint) ?? { value: [{ id }], "@odata.deltaLink": deltaLink(deltaFolder) };
      return page instanceof Response ? page : Response.json(page);
    }
    const item = decodeURIComponent(parsed.pathname.slice(parsed.pathname.lastIndexOf("/") + 1));
    const detail = details.get(item);
    if (!detail) return new Response(null, { status: 404 });
    await hooks.afterDetail?.(detail); return Response.json(detail);
  };
  const ctx = { db, bucket, oauth: CONFIG, vault: VAULT, fetcher };
  const tables = ["messages", "contacts", "conversations", "deals", "send_commands", "exchange_send_state", "audit_entries", "exchange_message_links"];
  const baseline = new Map(tables.map(table => [table, sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n]));
  return {
    db, sqlite, ctx, hooks, details, graphCalls,
    count: table => sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n - baseline.get(table),
    cursor: name => getExchangeSyncCursor(db, CONFIG, `folder-${name}`),
    link: messageId => getExchangeMessageLink(db, CONFIG, messageId),
  };
}
