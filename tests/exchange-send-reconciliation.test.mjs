import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return {shortCircuit:true,url:"data:text/javascript,export {};"};
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const {
  adjudicateExchangeUnknownSend,
  listUnresolvedExchangeSends,
  parseExchangeSendReconciliationRequest,
} = await import("../lib/exchange-send-reconciliation.ts");
const { EXCHANGE_GRAPH_COMMAND_PROPERTY } = await import("../lib/exchange-graph.ts");

const TENANT = "a1234567-1234-1234-1234-123456789abc";
const MAILBOX = "b1234567-1234-1234-1234-123456789abc";
const CLIENT = "c1234567-1234-1234-1234-123456789abc";
const OWNER = "d1234567-1234-1234-1234-123456789abc";
const NOW = new Date("2026-10-14T18:00:00.000Z");
const GRAPH_ID = "immutable+graph/message=";
const PROVIDER_THREAD = "provider-conversation-id";

test("request parsing requires one explicitly confirmed command", () => {
  const commandId = randomUUID();
  assert.deepEqual(parseExchangeSendReconciliationRequest({ commandId, confirmed: true }), { commandId });
  for (const value of [
    { commandId }, { commandId, confirmed: false }, { commandId: "bad", confirmed: true },
    { commandId, confirmed: true, resolution: "accepted" }, null,
  ]) assert.equal(parseExchangeSendReconciliationRequest(value), null);
});

test("read-only correlation moves a draft-only outcome to manual review, then confirms one Sent Item idempotently", async (t) => {
  const f = await fixture(t);
  let providerState = "draft";
  f.provider = () => providerState;

  const pending = await adjudicateExchangeUnknownSend(f.db, f.access, f.commandId);
  assert.deepEqual(pending, {
    resolved: false, outcome: "manual_review", commandId: f.commandId,
    reason: "no_sent_item", draftMatches: 1, sentMatches: 0, complete: true, idempotent: false,
  });
  assert.deepEqual(f.state(), { phase: "manual_review", graphMessageId: GRAPH_ID, version: 2 });
  assert.deepEqual(f.command(), {
    status: "dispatching", providerMessageId: null, failureCode: "exchange_reconciliation_manual_review",
  });
  assert.equal((await listUnresolvedExchangeSends(f.db))[0].commandId, f.commandId);

  const repeatedPending = await adjudicateExchangeUnknownSend(f.db, f.access, f.commandId);
  assert.equal(repeatedPending.idempotent, true);
  providerState = "sent";
  const accepted = await adjudicateExchangeUnknownSend(f.db, f.access, f.commandId);
  assert.equal(accepted.resolved, true);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.providerMessageId, GRAPH_ID);
  assert.equal(accepted.crmRecorded, true);
  assert.equal(accepted.idempotent, false);
  assert.deepEqual(f.state(), { phase: "accepted", graphMessageId: GRAPH_ID, version: 3 });
  assert.deepEqual(f.command(), { status: "sent", providerMessageId: GRAPH_ID, failureCode: null });
  assert.equal(f.sqlite.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE transport_provider='exchange' AND provider_message_id=?",
  ).get(GRAPH_ID).count, 1);
  const snapshot = JSON.parse(f.sqlite.prepare(
    "SELECT message_snapshot_json AS value FROM send_commands WHERE id=?",
  ).get(f.commandId).value);
  assert.equal(snapshot.providerConversationId, PROVIDER_THREAD);

  const callsBeforeRepeat = f.graphCalls.length;
  const repeatedAccepted = await adjudicateExchangeUnknownSend(f.db, f.access, f.commandId);
  assert.equal(repeatedAccepted.resolved, true);
  assert.equal(repeatedAccepted.idempotent, true);
  assert.equal(repeatedAccepted.crmRecorded, true);
  assert.equal(f.graphCalls.length, callsBeforeRepeat, "settled commands do not query or mutate Graph again");
  assert.ok(f.graphCalls.every(call => call.method === "GET"));
});

test("an exact correlated Sent Item can repair a prepared state after a lost local acknowledgement", async (t) => {
  const f = await fixture(t, null, "prepared", 0);
  f.provider = () => "sent";
  const result = await adjudicateExchangeUnknownSend(f.db, f.access, f.commandId);
  assert.equal(result.resolved, true);
  assert.equal(result.providerMessageId, GRAPH_ID);
  assert.deepEqual(f.state(), { phase: "accepted", graphMessageId: GRAPH_ID, version: 1 });
  assert.ok(f.graphCalls.every(call => call.method === "GET"));
});

test("lost D1 acknowledgements are observed after commit without another provider mutation", async (t) => {
  for (const prefix of ["UPDATE exchange_send_state SET phase=?", "UPDATE send_commands SET status='sent'"]) {
    await t.test(prefix.includes("exchange_send_state") ? "state CAS" : "command acceptance", async (t) => {
      const f = await fixture(t);
      f.provider = () => "sent";
      const db = lostAcknowledgementAfterCommit(f.db, prefix);
      const result = await adjudicateExchangeUnknownSend(db, f.access, f.commandId);
      assert.equal(result.resolved, true);
      assert.equal(f.command().status, "sent");
      assert.equal(f.state().phase, "accepted");
      assert.equal(f.graphCalls.length, 2);
      assert.ok(f.graphCalls.every(call => call.method === "GET"));
    });
  }
});

test("partial, duplicate, simultaneous and identity-conflicting evidence never confirms a send", async (t) => {
  for (const [name, graph, reason] of [
    ["partial", { drafts: [], sent: [], sentPartial: true }, "incomplete_results"],
    ["duplicate sent", { drafts: [], sent: [GRAPH_ID, "second-id"] }, "ambiguous_matches"],
    ["draft and sent", { drafts: [GRAPH_ID], sent: [GRAPH_ID] }, "ambiguous_matches"],
    ["different correlated draft", { drafts: ["different-id"], sent: [], initialGraphId: GRAPH_ID }, "provider_identity_conflict"],
    ["different immutable id", { drafts: [], sent: ["different-id"], initialGraphId: GRAPH_ID }, "provider_identity_conflict"],
  ]) {
    await t.test(name, async (t) => {
      const f = await fixture(t, graph.initialGraphId);
      f.provider = () => graph;
      const result = await adjudicateExchangeUnknownSend(f.db, f.access, f.commandId);
      assert.equal(result.resolved, false);
      assert.equal(result.outcome, "manual_review");
      assert.equal(result.reason, reason);
      assert.equal(f.command().status, "dispatching");
      assert.equal(f.state().phase, "manual_review");
      assert.ok(f.graphCalls.every(call => call.method === "GET"));
      assert.equal(f.sqlite.prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE transport_provider='exchange'",
      ).get().count, 0);
    });
  }
});

async function fixture(t, initialGraphId = null, initialPhase = "unknown", initialVersion = 1) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(migrationDirectory)).filter(name => /^\d+_.+\.sql$/u.test(name)).sort()) {
    const migration = await readFile(new URL(name, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) sqlite.exec(statement);
  }
  const commandId = randomUUID();
  const contactId = `contact-${commandId}`;
  const requestHash = "a".repeat(64);
  const snapshot = JSON.stringify({
    version: 1, requestHash, provider: "exchange", contactId,
    mailbox: { id: "mailbox_alexis", address: "alexis@27pm.org", purpose: "sales" },
    recipient: "controlled@example.com", subject: "Message approuvé", contentMode: "text",
    text: "Texte approuvé.", html: null, actorEmail: "operator@27pm.org",
    conversationId: null, occurredAt: "2026-10-14T17:55:00.000Z",
  });
  sqlite.prepare("INSERT INTO contacts(id,email,display_name) VALUES(?,?,?)")
    .run(contactId, "controlled@example.com", "Controlled");
  sqlite.prepare(`INSERT INTO exchange_connections
    (id,tenant_id,mailbox_id,client_id,generation,version,status,credential_version,lease_owner,lease_expires_at)
    VALUES('alexis',?,?,?,0,1,'connected',?,?,?)`)
    .run(TENANT, MAILBOX, CLIENT, randomUUID(), OWNER, "2026-10-14T18:01:00.000Z");
  sqlite.prepare(`INSERT INTO send_commands
    (id,transport_provider,idempotency_key,request_hash,mailbox_id,status,contact_id,
     dispatched_at,operator_confirmed_at,compliance_snapshot_json,message_snapshot_json,
     response_status,failure_code)
    VALUES(?,'exchange',?,?, 'mailbox_alexis','dispatching',?, ?,?,'{}',?,503,'transport_outcome_unknown')`)
    .run(commandId, `reconcile:${commandId}`, requestHash, contactId,
      "2026-10-14T17:56:00.000Z", "2026-10-14T17:55:00.000Z", snapshot);
  sqlite.prepare(`INSERT INTO exchange_send_state
    (command_id,connection_id,tenant_id,physical_mailbox_id,correlation_id,graph_message_id,phase,version)
    VALUES(?,'alexis',?,?,?,?, ?,?)`)
    .run(commandId, TENANT, MAILBOX, commandId, initialGraphId, initialPhase, initialVersion);
  const db = d1Adapter(sqlite);
  const graphCalls = [];
  const holder = { provider: () => "none" };
  const access = {
    accessToken: "synthetic-access-token-with-safe-length", mailboxId: MAILBOX,
    scope: { tenantId: TENANT, mailboxId: MAILBOX }, guard: { owner: OWNER, generation: 0 },
    now: () => NOW, async assertCurrent() {},
    async fetcher(url, init) {
      graphCalls.push({ url: String(url), method: init.method });
      const path = new URL(String(url)).pathname;
      const folder = path.includes("/drafts/") ? "drafts" : path.includes("/sentitems/") ? "sent" : null;
      assert.ok(folder, "reconciliation is pinned to Drafts and Sent Items");
      assert.equal(init.method, "GET");
      const configured = holder.provider();
      const model = typeof configured === "string"
        ? configured === "draft" ? { drafts: [GRAPH_ID], sent: [] }
          : configured === "sent" ? { drafts: [], sent: [GRAPH_ID] }
            : { drafts: [], sent: [] }
        : configured;
      const ids = model[folder] ?? [];
      const value = ids.map(id => ({
        id, isDraft: folder === "drafts", parentFolderId: `${folder}-folder`,
        ...(folder === "sent" ? { conversationId: PROVIDER_THREAD, sentDateTime: "2026-10-14T17:57:00Z" } : {}),
        singleValueExtendedProperties: [{ id: EXCHANGE_GRAPH_COMMAND_PROPERTY, value: commandId }],
      }));
      const partial = folder === "drafts" ? model.draftsPartial : model.sentPartial;
      return Response.json({ value, ...(partial ? { "@odata.nextLink": `${path.startsWith("/") ? "https://graph.microsoft.com" : ""}${path}?$skiptoken=next` } : {}) });
    },
  };
  return {
    sqlite, db, access, commandId, graphCalls,
    set provider(value) { holder.provider = value; },
    state() {
      const row = sqlite.prepare("SELECT phase,graph_message_id AS graphMessageId,version FROM exchange_send_state WHERE command_id=?").get(commandId);
      return { ...row };
    },
    command() {
      const row = sqlite.prepare("SELECT status,provider_message_id AS providerMessageId,failure_code AS failureCode FROM send_commands WHERE id=?").get(commandId);
      return { ...row };
    },
  };
}

function d1Adapter(database) {
  return {
    prepare(query) { return preparedQuery(database, query, []); },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function preparedQuery(database, query, bindings) {
  return {
    bind(...values) { return preparedQuery(database, query, values); },
    async first() { return database.prepare(query).get(...bindings) ?? null; },
    async all() { return { results: database.prepare(query).all(...bindings), success: true }; },
    async run() {
      const result = database.prepare(query).run(...bindings);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  };
}

function lostAcknowledgementAfterCommit(db, prefix) {
  let lost = false;
  const wrap = (statement, query) => ({
    bind(...values) { return wrap(statement.bind(...values), query); },
    async first() {
      const result = await statement.first();
      if (!lost && query.startsWith(prefix)) {
        lost = true;
        throw new Error("synthetic_lost_d1_acknowledgement");
      }
      return result;
    },
    all() { return statement.all(); },
    async run() {
      const result = await statement.run();
      if (!lost && query.startsWith(prefix)) {
        lost = true;
        throw new Error("synthetic_lost_d1_acknowledgement");
      }
      return result;
    },
  });
  return {
    prepare(query) { return wrap(db.prepare(query), query); },
    batch(statements) { return db.batch(statements); },
  };
}
