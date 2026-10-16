import assert from "node:assert/strict";
import test from "node:test";
import { handleExchangeSyncTool } from "../lib/exchange-sync-tool.ts";
import { authorizeCrmRequest } from "../lib/auth.ts";

const request = (body, headers = {}) => new Request("https://site.example/mcp", {
  method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
});
const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sync_exchange_mail", arguments: {} } };
function fixture() {
  const calls = [];
  return { calls, deps: {
    authorize: req => {
      const auth = authorizeCrmRequest(req, "owner@example.com");
      return auth.ok ? undefined : Response.json({ error: auth.code }, { status: auth.status });
    },
    enabled: () => true,
    syncFolder: async folder => { calls.push(folder); return { folder, processed: 0, removed: 0, ambiguous: 0, externalSent: 0, more: false, deltaReset: false }; },
  } };
}
const owner = { "oai-authenticated-user-email": "owner@example.com" };

test("discovery exposes a single fixed read/import tool, no mail contents or send method", async () => {
  const f = fixture();
  for (const method of ["server/discover", "initialize", "tools/list"]) {
    const r = await handleExchangeSyncTool(request({ jsonrpc: "2.0", id: 1, method }), f.deps);
    assert.equal(r.status, 200); assert.equal(r.headers.get("cache-control"), "private, no-store");
    const body = await r.json(); assert.ok(body.result);
    if (method === "tools/list") assert.deepEqual(body.result.tools.map(t => t.name), ["sync_exchange_mail"]);
  }
  assert.deepEqual(f.calls, []);
});

test("missing/wrong identity and browser requests cannot run the writer", async () => {
  const f = fixture();
  for (const [headers, status] of [[{}, 401], [{ "oai-authenticated-user-email": "other@example.com" }, 403], [{ ...owner, origin: "https://evil.example" }, 403], [{ ...owner, "sec-fetch-site": "same-origin" }, 403]]) {
    assert.equal((await handleExchangeSyncTool(request(call, headers), f.deps)).status, status);
  }
  assert.deepEqual(f.calls, []);
});

test("authorized call imports one page per fixed folder, sequentially, and returns counts only", async () => {
  const f = fixture();
  const result = await (await handleExchangeSyncTool(request(call, owner), f.deps)).json();
  assert.equal(result.result.isError, false);
  assert.deepEqual(f.calls, ["inbox", "junkemail", "sentitems"]);
  const proof = JSON.parse(result.result.content[0].text);
  assert.ok(Date.parse(proof.completedAt)); assert.equal(proof.more, false);
  assert.equal(proof.folders.length, 3);
});

test("disabled switch, notifications, unknown tools and extra arguments cannot sync", async () => {
  const f = fixture();
  const disabled = await (await handleExchangeSyncTool(request(call, owner), { ...f.deps, enabled: () => false })).json();
  assert.equal(disabled.result.isError, true);
  const { id, ...notification } = call;
  assert.equal((await handleExchangeSyncTool(request(notification, owner), f.deps)).status, 204);
  for (const params of [{ name: "send_email", arguments: {} }, { name: "sync_exchange_mail", arguments: { folder: "drafts" } }]) {
    const r = await (await handleExchangeSyncTool(request({ ...call, params }, owner), f.deps)).json();
    assert.equal(r.error.code, -32602);
  }
  assert.deepEqual(f.calls, []);
});

test("failure is bounded, never retries the writer and never leaks provider details", async () => {
  const f = fixture();
  f.deps.syncFolder = async folder => { f.calls.push(folder); throw new Error("secret-provider-token"); };
  const r = await (await handleExchangeSyncTool(request(call, owner), f.deps)).json();
  assert.equal(r.result.isError, true); assert.deepEqual(f.calls, ["inbox"]);
  assert.doesNotMatch(JSON.stringify(r), /secret-provider-token/);
});
