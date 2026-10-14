import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  checkExchangeConnection, disconnectExchangeConnection, exchangeConnectionStatus,
  finalizeExchangeConnection, stageExchangeCallback, startExchangeConnection,
  withExchangeAccess,
} from "../lib/exchange-connection-service.ts";
import { getConnection } from "../lib/exchange-connection-store.ts";
import { credentialObjectKey, readExchangeCredential } from "../lib/exchange-token-vault.ts";

const CONFIG = {
  tenantId: "a1234567-1234-1234-1234-123456789abc",
  mailboxId: "b1234567-1234-1234-1234-123456789abc",
  clientId: "c1234567-1234-1234-1234-123456789abc",
  clientSecret: "fixture-client-secret-only",
  publicOrigin: "https://crm.example.com", callbackOrigin: "https://api.example.com",
};
const NOW = new Date("2026-10-14T04:00:00.000Z");
const VAULT = { ...CONFIG, encryptionKey: Buffer.alloc(32, 7).toString("base64url") };
const OPERATOR = "alexis@27pm.org";
const BINDER = "b".repeat(43);
const CODE = "fixture-sensitive-provider-code";
const KEY = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
const JWK = { ...await exportJWK(KEY.publicKey), kid: "service-fixture", use: "sig", alg: "RS256" };

test("status/start/callback/finalize/check/disconnect keep credentials encrypted and mail flow disabled", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await exchangeConnectionStatus(f.ctx), { configured: true, status: "disconnected", updatedAt: null, mailFlowEnabled: false, cleanupPending: false });
  assert.equal(await getConnection(f.db), null);
  const flow = await prepareFlow(f);
  const plaintextDb = JSON.stringify(f.sqlite.prepare("SELECT * FROM exchange_oauth_flows").all());
  for (const secret of [CODE, BINDER, flow.state, flow.nonce]) assert.equal(plaintextDb.includes(secret), false);
  assert.equal(f.providerCalls.length, 0);
  const result = await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  assert.deepEqual(Object.keys(result).sort(), ["cleanupPending", "configured", "mailFlowEnabled", "ok", "status", "updatedAt"]);
  assert.equal(result.status, "connected");
  assert.equal(result.mailFlowEnabled, false);
  const initial = await getConnection(f.db);
  assert.equal((await credential(f, `flow:${flow.flowId}`)).payload, null);
  assert.deepEqual((await credential(f, `credential:${initial.credentialVersion}`)).payload, { refreshToken: "fixture-refresh-1" });
  assert.equal(f.sqlite.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").get(flow.flowId).status, "completed");
  assert.equal(initial.leaseOwner, null);
  assert.equal(f.providerCalls.filter((c) => c.url.endsWith("/token")).length, 1);
  const checked = await checkExchangeConnection(f.ctx);
  assert.equal(checked.status, "connected");
  const refreshed = await getConnection(f.db);
  assert.notEqual(refreshed.credentialVersion, initial.credentialVersion);
  assert.equal((await credential(f, `credential:${initial.credentialVersion}`)).payload, null);
  assert.deepEqual((await credential(f, `credential:${refreshed.credentialVersion}`)).payload, { refreshToken: "fixture-refresh-2" });
  const disconnected = await disconnectExchangeConnection(f.ctx);
  assert.equal(disconnected.status, "disconnected");
  assert.equal(disconnected.cleanupPending, false);
  assert.equal((await credential(f, `credential:${refreshed.credentialVersion}`)).payload, null);
  assert.equal((await getConnection(f.db)).credentialVersion, null);
  assert.equal((await getConnection(f.db)).generation, 1);
  for (const output of [result, checked, disconnected]) assertPublicOnly(output);
  for (const entry of f.objects.values()) {
    const serialized = Buffer.from(entry.bytes).toString();
    for (const secret of [CODE, "fixture-refresh", "fixture-access", CONFIG.clientSecret, BINDER]) assert.equal(serialized.includes(secret), false);
  }
  assert.equal(f.providerCalls.every((c) => new URL(c.url).hostname === "login.microsoftonline.com"), true);
});

test("a bounded Graph operation receives an access token only after durable refresh rotation", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  const before = await getConnection(f.db);
  let callbackCalls = 0;
  let delayed = false;
  f.hooks.afterPut = () => {
    if (!delayed) {
      delayed = true;
      f.time.value += 45_000;
    }
  };
  const result = await withExchangeAccess(f.ctx, async (access) => {
    callbackCalls += 1;
    const current = await getConnection(f.db);
    assert.notEqual(current.credentialVersion, before.credentialVersion);
    assert.equal(current.leaseOwner?.length > 0, true);
    assert.deepEqual(
      (await credential(f, `credential:${current.credentialVersion}`)).payload,
      { refreshToken: "fixture-refresh-2" },
    );
    assert.equal(access.accessToken, "fixture-access-2");
    assert.equal(access.mailboxId, CONFIG.mailboxId);
    await access.assertCurrent();
    assert.equal(
      (await getConnection(f.db)).leaseExpiresAt,
      new Date(f.time.value + 60_000).toISOString(),
      "credential rotation delay is followed by a fresh bounded-operation lease",
    );
    return "graph-result";
  });
  assert.equal(result, "graph-result");
  assert.equal(callbackCalls, 1);
  assert.equal((await getConnection(f.db)).leaseOwner, null);
  assert.equal((await credential(f, `credential:${before.credentialVersion}`)).payload, null);
  assert.equal(f.providerCalls.filter((c) => c.url.endsWith("/token")).length, 2);
});

test("the Graph lease guard fences expiry and callback errors are never retried", async (t) => {
  for (const scenario of ["expired", "callback-error"]) {
    const f = await fixture(t);
    const flow = await prepareFlow(f);
    await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
    let callbackCalls = 0;
    await assert.rejects(withExchangeAccess(f.ctx, async (access) => {
      callbackCalls += 1;
      if (scenario === "expired") {
        f.time.value += 61_000;
        await access.assertCurrent();
      }
      throw new Error("single-graph-attempt");
    }), scenario === "expired" ? errorCode("exchange_connection_changed") : /single-graph-attempt/u);
    assert.equal(callbackCalls, 1);
    assert.equal(f.providerCalls.filter((c) => c.url.endsWith("/token")).length, 2);
    assert.equal((await getConnection(f.db)).leaseOwner, null);
  }
});

test("Graph access fails closed when the connection is absent, disconnected or leased", async (t) => {
  const f = await fixture(t);
  await assert.rejects(withExchangeAccess(f.ctx, async () => "unused"), errorCode("exchange_reauthentication_required"));
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  const owner = "d1234567-1234-1234-1234-123456789abc";
  f.sqlite.prepare(`UPDATE exchange_connections SET lease_owner = ?, lease_expires_at = ? WHERE id = 'alexis'`)
    .run(owner, new Date(f.time.value + 60_000).toISOString());
  await assert.rejects(withExchangeAccess(f.ctx, async () => "unused"), errorCode("exchange_connection_busy"));
});

test("callback and finalization cannot replay, switch operator or switch the original browser", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await assert.rejects(stageExchangeCallback(f.ctx, { state: flow.state, code: CODE }), errorCode("exchange_authorization_invalid"));
  await assert.rejects(finalizeExchangeConnection(f.ctx, "another@27pm.org", flow.flowId, BINDER), errorCode("exchange_authorization_invalid"));
  await assert.rejects(finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, "c".repeat(43)), errorCode("exchange_authorization_invalid"));
  assert.equal(f.providerCalls.length, 0);
  assert.equal(f.sqlite.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").get(flow.flowId).status, "ready");
  assert.equal((await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER)).status, "connected");
  await assert.rejects(finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER), errorCode("exchange_authorization_invalid"));
  assert.equal(f.providerCalls.filter((c) => c.url.endsWith("/token")).length, 1);
  await assert.rejects(startExchangeConnection(f.ctx, OPERATOR, BINDER), errorCode("exchange_already_connected"));
});

test("concurrent finalizers exchange the Microsoft authorization code exactly once", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  const results = await Promise.allSettled([
    finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER),
    finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(f.providerCalls.filter((c) => c.url.endsWith("/token")).length, 1);
  assert.equal((await getConnection(f.db)).status, "connected");
});

test("a denied callback and a provider code older than fifty-five seconds fail without replay", async (t) => {
  for (const scenario of ["denied", "aged", "expired-flow"]) {
    const f = await fixture(t);
    const flow = await prepareFlow(f, { stage: scenario !== "denied" });
    if (scenario === "denied") {
      await assert.rejects(stageExchangeCallback(f.ctx, { state: flow.state, denied: true }), errorCode("exchange_authorization_invalid"));
    } else {
      f.time.value += (scenario === "aged" ? 56 : 301) * 1000;
      await assert.rejects(finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER), errorCode("exchange_authorization_invalid"));
    }
    assert.equal(f.providerCalls.length, 0);
    assert.equal((await getConnection(f.db)).status, "disconnected");
  }
});

test("invalid grant is sanitized and consumes the flow without an automatic retry", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  f.hooks.provider = async () => Response.json({ error: "invalid_grant", error_description: "DO-NOT-EXPOSE-provider-details" }, { status: 400 });
  await assert.rejects(finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER), (error) => {
    assert.equal(error.message.includes("DO-NOT-EXPOSE"), false);
    return true;
  });
  assert.equal(f.providerCalls.filter((c) => c.url.endsWith("/token")).length, 1);
  assert.equal(f.sqlite.prepare("SELECT status FROM exchange_oauth_flows WHERE id = ?").get(flow.flowId).status, "failed");
  assert.equal((await credential(f, `flow:${flow.flowId}`)).payload, null);
  assert.equal((await getConnection(f.db)).leaseOwner, null);
});

test("expired lease and concurrent disconnect fence a delayed connect or refresh provider response", async (t) => {
  for (const scenario of ["connect-expiry", "connect-disconnect", "refresh-disconnect"]) {
    const f = await fixture(t);
    const flow = await prepareFlow(f);
    if (scenario === "refresh-disconnect") await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
    f.hooks.provider = async () => {
      f.time.value += 61_000;
      if (scenario.includes("disconnect")) assert.equal((await disconnectExchangeConnection(f.ctx)).status, "disconnected");
    };
    const operation = scenario === "refresh-disconnect"
      ? checkExchangeConnection(f.ctx)
      : finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
    await assert.rejects(operation, errorCode("exchange_connection_changed"));
    assert.equal((await getConnection(f.db)).status, "disconnected");
    assert.equal((await getConnection(f.db)).credentialVersion, null);
    assert.equal((await getConnection(f.db)).leaseOwner, null);
  }
});

test("a disconnect inside the active lease is rejected without interfering with the finalizer", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  f.hooks.provider = async () => {
    await assert.rejects(disconnectExchangeConnection(f.ctx), errorCode("exchange_connection_busy"));
  };
  assert.equal((await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER)).status, "connected");
});

test("lost immutable R2 write acknowledgements are reconciled without another provider call", async (t) => {
  const f = await fixture(t);
  f.hooks.afterPut = async (_key, _bytes, options) => {
    if (options.onlyIf.etagDoesNotMatch === "*") throw new Error("lost R2 acknowledgement");
  };
  const flow = await prepareFlow(f);
  assert.equal((await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER)).status, "connected");
  assert.equal(f.providerCalls.filter((c) => c.url.endsWith("/token")).length, 1);
  const row = await getConnection(f.db);
  assert.equal((await credential(f, `credential:${row.credentialVersion}`)).payload.refreshToken, "fixture-refresh-1");
});

test("lost D1 commit acknowledgements are reconciled and do not tombstone the active credential", async (t) => {
  for (const operation of ["finalize", "refresh"]) {
    const f = await fixture(t);
    const flow = await prepareFlow(f);
    if (operation === "refresh") await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
    let injected = false;
    const inject = (queries) => {
      if (!injected && queries.some((q) => /UPDATE exchange_connections/u.test(q) && /credential_version = \?/u.test(q))) {
        injected = true;
        throw new Error("D1 commit acknowledged late");
      }
    };
    f.hooks.afterBatch = inject;
    f.hooks.afterFirst = (query) => inject([query]);
    const result = operation === "finalize"
      ? await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER)
      : await checkExchangeConnection(f.ctx);
    assert.equal(injected, true);
    assert.equal(result.status, "connected");
    const row = await getConnection(f.db);
    assert.ok((await credential(f, `credential:${row.credentialVersion}`)).payload?.refreshToken);
  }
});

test("if D1 commit and reconciliation acknowledgements are lost, possibly active credentials are retained", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  let committed = false;
  f.hooks.afterBatch = (queries) => {
    if (queries.some((q) => /UPDATE exchange_connections/u.test(q) && /credential_version = \?/u.test(q))) {
      committed = true;
      throw new Error("lost D1 acknowledgement");
    }
  };
  f.hooks.beforeFirst = (query) => {
    if (committed && /SELECT .*\s*.*FROM exchange_connections/su.test(query)) throw new Error("D1 unavailable for reconciliation");
  };
  await assert.rejects(finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER));
  f.hooks.beforeFirst = undefined;
  const row = await getConnection(f.db);
  assert.equal(row.status, "connected");
  assert.ok((await credential(f, `credential:${row.credentialVersion}`)).payload?.refreshToken);
});

test("failed credential persistence never connects and failed cleanup is surfaced on a successful disconnect", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  f.hooks.beforePut = async (_key, _bytes, options) => {
    if (options.onlyIf.etagDoesNotMatch === "*") throw new Error("R2 write unavailable");
  };
  await assert.rejects(finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER), errorCode("exchange_storage_unavailable"));
  assert.equal((await getConnection(f.db)).status, "disconnected");
  f.hooks.beforePut = undefined;
  const replacement = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, replacement.flowId, BINDER);
  f.hooks.beforePut = async () => { throw new Error("R2 cleanup unavailable"); };
  const result = await disconnectExchangeConnection(f.ctx);
  assert.equal(result.status, "disconnected");
  assert.equal(result.cleanupPending, true);
  assert.equal((await getConnection(f.db)).credentialVersion, null);
});

test("revoked refresh consent marks reauthentication required without sending a message", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  f.hooks.provider = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
  await assert.rejects(checkExchangeConnection(f.ctx), errorCode("exchange_reauthentication_required"));
  assert.equal((await exchangeConnectionStatus(f.ctx)).status, "reauth_required");
  assert.equal((await getConnection(f.db)).leaseOwner, null);
});

test("retrying a disconnect finishes pending credential cleanup before reporting cleanupPending false", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  const connected = await getConnection(f.db);
  const purpose = `credential:${connected.credentialVersion}`;
  f.hooks.beforePut = async () => { throw new Error("Temporary R2 outage during disconnect"); };
  const initial = await disconnectExchangeConnection(f.ctx);
  assert.equal(initial.status, "disconnected");
  assert.equal(initial.cleanupPending, true);
  assert.ok((await credential(f, purpose)).payload?.refreshToken);
  f.hooks.beforePut = undefined;
  const retried = await disconnectExchangeConnection(f.ctx);
  assert.equal(retried.status, "disconnected");
  assert.equal(retried.cleanupPending, false);
  assert.equal((await credential(f, purpose)).payload, null, "A successful cleanup retry must erase the former recoverable refresh token");
});

test("a lost D1 disconnect acknowledgement does not permanently orphan the encrypted refresh token", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  const connected = await getConnection(f.db);
  let injected = false;
  f.hooks.afterBatch = (queries) => {
    if (!injected && queries.some((q) => /UPDATE exchange_connections/u.test(q) && /generation = generation \+ 1/u.test(q))) {
      injected = true;
      throw new Error("Lost disconnect commit acknowledgement");
    }
  };
  try { await disconnectExchangeConnection(f.ctx); } catch { /* A transient error may require a retry. */ }
  assert.equal(injected, true);
  const retried = await disconnectExchangeConnection(f.ctx);
  assert.equal(retried.status, "disconnected");
  assert.equal(retried.cleanupPending, false);
  assert.equal((await credential(f, `credential:${connected.credentialVersion}`)).payload, null);
});

test("later rotations retry earlier pending cleanup instead of forgetting an obsolete refresh credential", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  const oldVersion = (await getConnection(f.db)).credentialVersion;
  const oldKey = await f.key(`credential:${oldVersion}`);
  f.hooks.beforePut = async (key) => { if (key === oldKey) throw new Error("Temporary tombstone outage"); };
  const initial = await checkExchangeConnection(f.ctx);
  assert.equal(initial.status, "connected");
  assert.equal(initial.cleanupPending, true);
  assert.ok((await credential(f, `credential:${oldVersion}`)).payload?.refreshToken);
  f.hooks.beforePut = undefined;
  const retried = await checkExchangeConnection(f.ctx);
  assert.equal(retried.cleanupPending, false);
  assert.equal((await credential(f, `credential:${oldVersion}`)).payload, null);
});

test("status reports durable pending cleanup without mutations, provider calls or vault access", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  f.hooks.beforePut = async () => { throw new Error("Temporary R2 cleanup outage"); };
  await disconnectExchangeConnection(f.ctx);
  const before = f.sqlite.prepare("SELECT total_changes() AS count").get().count;
  const providerCount = f.providerCalls.length;
  const queueBefore = f.sqlite.prepare("SELECT * FROM exchange_credential_cleanup ORDER BY credential_version").all();
  assert.equal(queueBefore.length, 1);
  f.hooks.beforeGet = async () => assert.fail("Status must not read encrypted credentials");
  f.hooks.beforePut = async () => assert.fail("Status must not write encrypted credentials");
  const result = await exchangeConnectionStatus(f.ctx);
  assert.equal(result.status, "disconnected");
  assert.equal(result.cleanupPending, true);
  assert.equal(result.mailFlowEnabled, false);
  assertPublicOnly(result);
  assert.equal(f.sqlite.prepare("SELECT total_changes() AS count").get().count, before);
  assert.deepEqual(f.sqlite.prepare("SELECT * FROM exchange_credential_cleanup ORDER BY credential_version").all(), queueBefore);
  assert.equal(f.providerCalls.length, providerCount);
  f.hooks.beforeGet = undefined;
  f.hooks.beforePut = undefined;
  assert.equal((await checkExchangeConnection(f.ctx)).cleanupPending, false);
  assert.equal((await exchangeConnectionStatus(f.ctx)).cleanupPending, false);
});

test("an identity configuration change cannot read status, reconnect or refresh the former connection", async (t) => {
  const f = await fixture(t);
  const flow = await prepareFlow(f);
  await finalizeExchangeConnection(f.ctx, OPERATOR, flow.flowId, BINDER);
  const former = await getConnection(f.db);
  const foreignCtx = { ...f.ctx, oauth: { ...CONFIG, mailboxId: CONFIG.tenantId } };
  const providerCount = f.providerCalls.length;
  for (const action of [
    () => exchangeConnectionStatus(foreignCtx),
    () => startExchangeConnection(foreignCtx, OPERATOR, BINDER),
    () => checkExchangeConnection(foreignCtx),
    () => disconnectExchangeConnection(foreignCtx),
  ]) await assert.rejects(action(), errorCode("exchange_configuration_mismatch"));
  assert.equal(f.providerCalls.length, providerCount);
  assert.deepEqual(await getConnection(f.db), former);
});

function assertPublicOnly(value) {
  const serialized = JSON.stringify(value);
  for (const secret of ["fixture-refresh", "fixture-access", "credentialVersion", "tenantId", "mailboxId", "clientId", CONFIG.clientSecret, VAULT.encryptionKey]) assert.equal(serialized.includes(secret), false);
}
function errorCode(code) { return (error) => { assert.equal(error.code, code); assert.equal(error.message, code); return true; }; }
async function credential(f, purpose) { return readExchangeCredential(f.ctx.bucket, VAULT, purpose); }

async function prepareFlow(f, { stage = true } = {}) {
  const started = await startExchangeConnection(f.ctx, OPERATOR, BINDER);
  const authorization = new URL(started.authorizationUrl);
  const state = authorization.searchParams.get("state");
  const nonce = authorization.searchParams.get("nonce");
  f.nonce.value = nonce;
  if (stage) await stageExchangeCallback(f.ctx, { state, code: CODE });
  return { ...started, state, nonce };
}

async function fixture(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(directory)).filter((n) => /^\d+_.+\.sql$/u.test(n)).sort()) {
    for (const statement of (await readFile(new URL(name, directory), "utf8")).split("--> statement-breakpoint")) {
      if (statement.trim()) sqlite.exec(statement);
    }
  }
  const hooks = {};
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
        query, bind(...input) { values = input; return this; }, execute,
        async first() { hooks.beforeFirst?.(query); const value = sqlite.prepare(query).get(...values) ?? null; hooks.afterFirst?.(query); return value; },
        async all() { return { results: sqlite.prepare(query).all(...values), success: true }; },
        async run() { return execute(); },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      let result;
      try { result = statements.map((s) => s.execute()); sqlite.exec("COMMIT"); }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      hooks.afterBatch?.(statements.map((s) => s.query));
      return result;
    },
  };
  const objects = new Map();
  let revision = 0;
  const bucket = {
    async get(key) {
      await hooks.beforeGet?.(key);
      const row = objects.get(key);
      if (!row) return null;
      return { etag: row.etag, size: row.bytes.byteLength, body: new ReadableStream({ start(c) { c.enqueue(row.bytes.slice()); c.close(); } }) };
    },
    async put(key, bytes, options) {
      await hooks.beforePut?.(key, bytes, options);
      const current = objects.get(key);
      if (options.onlyIf.etagDoesNotMatch === "*" && current) return null;
      if (options.onlyIf.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null;
      const etag = createHash("sha256").update(bytes).update(String(++revision)).digest("hex");
      objects.set(key, { bytes: bytes.slice(), etag });
      await hooks.afterPut?.(key, bytes, options);
      return { etag };
    },
  };
  const time = { value: NOW.valueOf() };
  const nonce = { value: "" };
  const providerCalls = [];
  let tokenSequence = 0;
  const fetcher = async (url, init) => {
    const endpoint = String(url);
    providerCalls.push({ url: endpoint, init });
    if (endpoint === `https://login.microsoftonline.com/${CONFIG.tenantId}/discovery/v2.0/keys`) return Response.json({ keys: [JWK] });
    assert.equal(endpoint, `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`, "No message, send or delete endpoint may be invoked");
    const custom = await hooks.provider?.(endpoint, init);
    if (custom) return custom;
    const body = new URLSearchParams(init.body);
    const timestamp = Math.floor(NOW.valueOf() / 1000);
    const idToken = await new SignJWT({
      iss: `https://login.microsoftonline.com/${CONFIG.tenantId}/v2.0`, aud: CONFIG.clientId,
      tid: CONFIG.tenantId, oid: CONFIG.mailboxId, sub: "fixture-subject", nonce: nonce.value,
      iat: timestamp, nbf: timestamp, exp: timestamp + 3600,
    }).setProtectedHeader({ alg: "RS256", kid: JWK.kid, typ: "JWT" }).sign(KEY.privateKey);
    tokenSequence += 1;
    return Response.json({
      token_type: "Bearer", scope: "Mail.ReadWrite Mail.Send openid profile", expires_in: 3600,
      access_token: `fixture-access-${tokenSequence}`, refresh_token: `fixture-refresh-${tokenSequence}`,
      ...(body.get("grant_type") === "authorization_code" ? { id_token: idToken } : {}),
    });
  };
  const ctx = { db, bucket, oauth: CONFIG, vault: VAULT, now: () => new Date(time.value), fetcher };
  return { ctx, db, sqlite, objects, hooks, time, nonce, providerCalls, key: (purpose) => credentialObjectKey(VAULT, purpose) };
}
