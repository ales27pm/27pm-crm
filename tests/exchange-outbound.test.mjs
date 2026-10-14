import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return {shortCircuit:true,url:"data:text/javascript,export {};"};
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { sendApprovedExchangeMessage } = await import("../lib/exchange-outbound.ts");
const { ensureConnection, getConnection } = await import("../lib/exchange-connection-store.ts");
const { writeExchangeCredential } = await import("../lib/exchange-token-vault.ts");
const { getExchangeSendState } = await import("../lib/exchange-mail-store.ts");
const { OutboundSendError, classifyOutboundFailure } = await import("../lib/outbound-send-outcome.ts");

const CONFIG = {
  tenantId: "a1234567-1234-1234-1234-123456789abc",
  mailboxId: "b1234567-1234-1234-1234-123456789abc",
  clientId: "c1234567-1234-1234-1234-123456789abc",
  clientSecret: "synthetic-fixture-client-secret",
  publicOrigin: "https://crm.example.com", callbackOrigin: "https://api.example.com",
};
const VAULT = { ...CONFIG, encryptionKey: Buffer.alloc(32, 9).toString("base64url") };
const DRAFT = "immutable+draft/fixture=";
const CONVERSATION = "graph-conversation-fixture";
const GRAPH = `https://graph.microsoft.com/v1.0/users/${CONFIG.mailboxId}`;
const command = () => ({
  commandId: randomUUID(), fromAddress: "alexis@27pm.org", fromName: "Alexis — 27PM",
  to: ["controlled-test@example.com"], subject: "Test contrôlé", text: "Texte approuvé.", replyTo: "alexis@27pm.org",
});

test("real D1: immutable draft ID and send-request fence are durable before exactly one submission", async (t) => {
  const f = await fixture(t);
  await f.seed();
  let dispatched = 0;
  const result = await sendApprovedExchangeMessage(f.db, f.ctx, f.message, { onDispatchStart() { dispatched += 1; } });
  assert.equal(dispatched, 1);
  assert.deepEqual(f.graphCalls.map(call => call.url), [`${GRAPH}/messages`, `${GRAPH}/messages/${encodeURIComponent(DRAFT)}/send`]);
  assert.deepEqual(f.observedPhases, ["prepared", "send_requested"]);
  assert.deepEqual(result, {
    provider: "exchange", providerMessageId: DRAFT, providerConversationId: CONVERSATION,
    externalMessageId: null,
    message: "Accepted by Microsoft Graph for submission.", responseStatus: 202,
  });
  const state = await f.state();
  assert.equal(state.phase, "accepted"); assert.equal(state.graphMessageId, DRAFT); assert.equal(state.version, 3);
  assert.equal((await getConnection(f.db)).leaseOwner, null);
  assert.equal("delivered" in result, false); assert.equal("inbox" in result, false);
  await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), /exchange_send_already_started/u);
  assert.equal(f.graphCalls.length, 2, "a repeated command may refresh credentials but cannot make any additional Graph request");
});

test("real D1: an explicit provider rejection is terminal without another POST", async (t) => {
  for (const phase of ["create", "submit"]) {
    await t.test(phase, async (t) => {
      const f = await fixture(t);
      await f.seed();
      f.hooks.graph = async (url) => (phase === "create" ? url.endsWith("/messages") : url.endsWith("/send"))
        ? Response.json({ error: { code: "ErrorAccessDenied", message: "provider-private-description" } }, { status: 403 }) : undefined;
      await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), error => {
        assert.ok(error instanceof OutboundSendError); assert.equal(error.provider, "exchange");
        assert.equal(error.kind, "rejected"); assert.equal(error.status, 403);
        assert.equal(classifyOutboundFailure(true, error), "definitive_failure");
        assert.equal(String(error).includes("provider-private-description"), false); return true;
      });
      const state = await f.state();
      assert.equal(state.phase, "rejected"); assert.equal(state.graphMessageId, phase === "create" ? null : DRAFT);
      const count = f.graphCalls.length;
      await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), /exchange_send_already_started/u);
      assert.equal(f.graphCalls.length, count);
      assert.equal(count, phase === "create" ? 1 : 2);
    });
  }
});

test("real D1: unknown creation is recorded without sending or recreating a draft", async (t) => {
  const f = await fixture(t); await f.seed();
  f.hooks.graph = async () => { throw new Error("synthetic lost create response"); };
  await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), unknownOutcome);
  const state = await f.state();
  assert.equal(state.phase, "unknown"); assert.equal(state.graphMessageId, null);
  await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), /exchange_send_already_started/u);
  assert.equal(f.graphCalls.length, 1);
});

test("real D1: unknown submission retains the immutable ID without a second submission", async (t) => {
  const f = await fixture(t); await f.seed();
  f.hooks.graph = async (url) => { if (url.endsWith("/send")) throw new Error("synthetic lost submit response"); };
  await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), unknownOutcome);
  const state = await f.state();
  assert.equal(state.phase, "unknown"); assert.equal(state.graphMessageId, DRAFT);
  await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), /exchange_send_already_started/u);
  assert.equal(f.graphCalls.filter(call => call.url.endsWith("/send")).length, 1);
});

test("real D1: refused local transitions never authorize a second provider POST", async (t) => {
  for (const target of ["drafted", "send_requested", "accepted"]) {
    await t.test(target, async (t) => {
      const f = await fixture(t); await f.seed();
      f.hooks.beforeFirst = async (query, values) => {
        if (query.startsWith("UPDATE exchange_send_state") && values[0] === target) return { override: true, value: null };
      };
      await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), unknownOutcome);
      const state = await f.state();
      assert.equal(state.phase, { drafted: "prepared", send_requested: "drafted", accepted: "send_requested" }[target]);
      assert.equal(state.graphMessageId, target === "drafted" ? null : DRAFT);
      const expectedCalls = target === "accepted" ? 2 : 1;
      assert.equal(f.graphCalls.length, expectedCalls);
      await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), /exchange_send_already_started/u);
      assert.equal(f.graphCalls.length, expectedCalls);
    });
  }
});

test("real D1: lost transition acknowledgement after commit remains non-retryable", async (t) => {
  for (const target of ["drafted", "send_requested", "accepted"]) {
    await t.test(target, async (t) => {
      const f = await fixture(t); await f.seed();
      f.hooks.afterFirst = async (query, values) => {
        if (query.startsWith("UPDATE exchange_send_state") && values[0] === target) throw new Error("synthetic D1 acknowledgement lost");
      };
      await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), error => {
        assert.equal(classifyOutboundFailure(true, error), "outcome_unknown"); return true;
      });
      assert.equal((await f.state()).phase, target, "the database committed despite the missing acknowledgement");
      const expectedCalls = target === "accepted" ? 2 : 1;
      assert.equal(f.graphCalls.length, expectedCalls);
      await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), /exchange_send_already_started/u);
      assert.equal(f.graphCalls.length, expectedCalls);
    });
  }
});

test("real D1: a command lacking durable approval/snapshot cannot reach Graph", async (t) => {
  const f = await fixture(t); await f.seed();
  await f.db.prepare("UPDATE send_commands SET message_snapshot_json=NULL WHERE id=?").bind(f.message.commandId).run();
  await assert.rejects(sendApprovedExchangeMessage(f.db, f.ctx, f.message), /exchange_send_state_unavailable/u);
  assert.equal(f.graphCalls.length, 0); assert.equal(await f.state(), null);
});

test("send route preserves same-origin authorization, idempotency and the durable Exchange-only dispatch seam", async () => {
  const source = await readFile(new URL("../app/api/messages/send/route.ts", import.meta.url), "utf8");
  const auth = source.indexOf("requireSameOriginOperatorRequest(request)");
  const lookup = source.indexOf("const existing = await loadSendCommand(db, idempotencyKey)");
  const dispatch = source.indexOf("? await sendApprovedExchangeMessage(");
  assert.ok(auth >= 0 && auth < lookup && lookup < dispatch);
  assert.ok(source.indexOf("const snapshotRecorded = await db") < dispatch);
  assert.match(source, /if \(changedRows\(snapshotRecorded\) !== 1\)[\s\S]*outbound_snapshot_persistence_failed/u);
  assert.match(source, /transport\.provider === "exchange"\s*\? await sendApprovedExchangeMessage/u);
  assert.match(source, /onDispatchStart: \(\) => \{\s*providerDispatchStarted = true;/u);
  assert.match(source, /classifyOutboundFailure\(providerDispatchStarted, cause\) ===\s*"outcome_unknown"/u);
  assert.match(source, /jsonError\(503, "outbound_send_unconfirmed"\)/u);
  assert.match(source, /existing\.status === "dispatching"[\s\S]*send_command_in_progress/u);
});

function unknownOutcome(error) {
  assert.ok(error instanceof OutboundSendError);
  assert.equal(error.provider, "exchange"); assert.equal(error.kind, "outcome_unknown");
  assert.equal(classifyOutboundFailure(true, error), "outcome_unknown");
  return true;
}

async function fixture(t) {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-09-11", compatibilityFlags: ["nodejs_compat"],
    d1Databases: { DB: randomUUID() },
    script: `export default { async fetch(request,env) {
      const input=await request.json();
      const statements=input.statements.map(({query,values})=>env.DB.prepare(query).bind(...values));
      return Response.json(input.batch?await env.DB.batch(statements):await statements[0][input.mode]());
    } };`,
  }));
  t.after(() => mf.dispose());
  const hooks = {};
  const call = async input => {
    const response = await mf.dispatchFetch("http://local.invalid", { method: "POST", body: JSON.stringify(input) });
    assert.equal(response.status, 200); return response.json();
  };
  const db = {
    prepare(query) {
      const statement = {
        query, values: [], bind(...values) { statement.values = values; return statement; },
        async first() {
          const override = await hooks.beforeFirst?.(query, statement.values);
          if (override?.override) return override.value;
          const result = await call({ statements: [statement], mode: "first" });
          await hooks.afterFirst?.(query, statement.values, result); return result;
        },
        all() { return call({ statements: [statement], mode: "all" }); },
        run() { return call({ statements: [statement], mode: "run" }); },
      }; return statement;
    },
    batch(statements) { return call({ statements, batch: true }); },
  };
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(directory)).filter(name => /^\d+_.+\.sql$/u.test(name)).sort()) {
    for (const statement of (await readFile(new URL(name, directory), "utf8")).split("--> statement-breakpoint")) {
      if (statement.trim()) assert.equal((await db.prepare(statement).run()).success, true);
    }
  }
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
  await ensureConnection(db, CONFIG);
  const version = randomUUID();
  await writeExchangeCredential(bucket, VAULT, `credential:${version}`, { refreshToken: "synthetic-initial-refresh" }, { expectedEtag: null });
  await db.prepare("UPDATE exchange_connections SET status='connected',credential_version=? WHERE id='alexis'").bind(version).run();
  const message = command(); const graphCalls = []; const observedPhases = [];
  const state = () => getExchangeSendState(db, CONFIG, message.commandId);
  let refresh = 0;
  const fetcher = async (url, init) => {
    const endpoint = String(url);
    if (endpoint === `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`) {
      refresh += 1;
      return Response.json({ token_type: "Bearer", scope: "Mail.ReadWrite Mail.Send openid profile", expires_in: 3600,
        access_token: `synthetic-access-${refresh}`, refresh_token: `synthetic-refresh-${refresh}` });
    }
    assert.ok(endpoint === `${GRAPH}/messages` || endpoint === `${GRAPH}/messages/${encodeURIComponent(DRAFT)}/send`, "only the two approved Graph POST endpoints are reachable");
    assert.equal(init.method, "POST"); graphCalls.push({ url: endpoint, init });
    const durable = await state(); observedPhases.push(durable?.phase);
    if (endpoint.endsWith("/send")) {
      assert.equal(durable.phase, "send_requested"); assert.equal(durable.graphMessageId, DRAFT);
    } else assert.equal(durable.phase, "prepared");
    const overridden = await hooks.graph?.(endpoint, init); if (overridden) return overridden;
    return endpoint.endsWith("/send") ? new Response(null, { status: 202 }) : Response.json({
      id: DRAFT, conversationId: CONVERSATION, isDraft: true,
      subject: message.subject, body: { contentType: "text", content: message.text },
    }, { status: 201 });
  };
  const ctx = { db, bucket, oauth: CONFIG, vault: VAULT, fetcher };
  const seed = () => db.prepare(`INSERT INTO send_commands
    (id,idempotency_key,request_hash,mailbox_id,status,transport_provider,operator_confirmed_at,compliance_snapshot_json,message_snapshot_json)
    VALUES (?,?,?,'mailbox_alexis','dispatching','exchange',?,'{}','{}')`)
    .bind(message.commandId, randomUUID(), "fixture-hash", new Date().toISOString()).run();
  return { db, ctx, hooks, message, graphCalls, observedPhases, state, seed };
}
