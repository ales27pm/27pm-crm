import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import * as operatorAuth from "../lib/auth.ts";
import * as http from "../lib/http.ts";
import { readExchangeAction, readExchangeCallback } from "../lib/exchange-request.ts";
import { prepareInternalApiRequest } from "../lib/internal-api-edge.ts";
import { prepareVercelApiRequest } from "../lib/vercel-api-proxy.ts";

const PUBLIC_ORIGIN = "https://crm.example.test";
const BACKEND_ORIGIN = "https://worker.example.test";
const CALLBACK_PATH = "/api/integrations/exchange/callback";
const ACTION_PATH = "/api/integrations/exchange";
const STATE = Buffer.alloc(32, 41).toString("base64url");
const BINDER = Buffer.alloc(32, 42).toString("base64url");
const FLOW_ID = "11111111-2222-3333-4444-555555555555";
const OWNER = "owner@example.test";
const PROXY_CONFIG = {
  apiOrigin: BACKEND_ORIGIN, operatorAllowlist: OWNER,
  audience: "27pm-sites-worker", signingKey: Buffer.alloc(32, 15).toString("base64url"),
};
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function callbackRequest(body = new URLSearchParams({ state: STATE, code: "opaque-provider-code" }).toString(), options = {}) {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded", ...options.headers });
  return new Request(options.url ?? `${BACKEND_ORIGIN}${CALLBACK_PATH}`, {
    method: options.method ?? "POST", headers, ...(body === undefined ? {} : { body }),
  });
}

function actionRequest(payload, options = {}) {
  return new Request(`${BACKEND_ORIGIN}${ACTION_PATH}`, {
    method: "POST", body: options.raw ?? JSON.stringify(payload),
    headers: { "content-type": "application/json", ...options.headers },
  });
}

test("callback accepts only bounded form_post code/state or a provider denial", async () => {
  for (const contentType of ["application/x-www-form-urlencoded", "APPLICATION/X-WWW-FORM-URLENCODED; charset=UTF-8"]) {
    const request = callbackRequest(new URLSearchParams({ state: STATE, code: "opaque.+_/-code", session_state: "optional-provider-session" }).toString(), { headers: { "content-type": contentType } });
    assert.deepEqual(await readExchangeCallback(request, BACKEND_ORIGIN), { state: STATE, code: "opaque.+_/-code" });
  }
  const denial = new URLSearchParams({ state: STATE, error: "access_denied", error_description: "private provider detail", error_uri: "https://provider.example/help" });
  assert.deepEqual(await readExchangeCallback(callbackRequest(denial.toString()), BACKEND_ORIGIN), { state: STATE, denied: true });
});

test("callback rejects method, origin, URL query, and MIME before body consumption", async () => {
  for (const request of [
    new Request(`${BACKEND_ORIGIN}${CALLBACK_PATH}`, { method: "GET" }),
    callbackRequest(undefined, { method: "PUT" }),
    callbackRequest(undefined, { url: `${PUBLIC_ORIGIN}${CALLBACK_PATH}` }),
    callbackRequest(undefined, { url: `${BACKEND_ORIGIN}${CALLBACK_PATH}?code=secret` }),
    callbackRequest(undefined, { url: `${BACKEND_ORIGIN}${CALLBACK_PATH}?ignored=1` }),
    callbackRequest(undefined, { headers: { "content-type": "application/json" } }),
    callbackRequest(undefined, { headers: { "content-type": "multipart/form-data; boundary=bound" } }),
    callbackRequest(undefined, { headers: { "content-type": "" } }),
  ]) {
    assert.equal(await readExchangeCallback(request, BACKEND_ORIGIN), null);
    assert.equal(request.bodyUsed, false);
  }
});

test("callback rejects duplicate/unknown form fields, missing values, and invalid codes/state", async () => {
  const valid = new URLSearchParams({ state: STATE, code: "valid-code" }).toString();
  const bodies = [
    `${valid}&state=${STATE}`, `${valid}&code=again`, `${valid}&session_state=a&session_state=b`,
    `${valid}&unknown=x`, `${valid}&error=access_denied`, `${valid}&error_description=a&error_description=b`,
    `state=${STATE}`, "code=valid-code", `state=${STATE}&code=`, `state=${STATE}&error=x&error=x`,
  ];
  for (const state of ["short", `${STATE}=`, "!".repeat(43), ""]) {
    bodies.push(new URLSearchParams({ state, code: "code" }).toString());
  }
  for (const code of ["x".repeat(12_001), "contains space", "contains\nnewline", "contains\u0000nul", "contains\u007fdel"]) {
    bodies.push(new URLSearchParams({ state: STATE, code }).toString());
  }
  for (const body of bodies) assert.equal(await readExchangeCallback(callbackRequest(body), BACKEND_ORIGIN), null, body.slice(0, 70));
});

test("callback body limits enforce actual streamed bytes, not just Content-Length", async () => {
  const oversized = `state=${STATE}&code=code&error_description=${"x".repeat(16 * 1024)}`;
  for (const headers of [{}, { "content-length": "1" }]) {
    assert.equal(await readExchangeCallback(callbackRequest(oversized, { headers }), BACKEND_ORIGIN), null);
  }
  const declared = callbackRequest(undefined, { headers: { "content-length": String(16 * 1024 + 1) } });
  assert.equal(await readExchangeCallback(declared, BACKEND_ORIGIN), null);
  assert.equal(declared.bodyUsed, false);
  const utf8Oversized = new URLSearchParams({ state: STATE, code: "code", error_description: "é".repeat(3000) }).toString();
  assert.ok(Buffer.byteLength(utf8Oversized) > 16 * 1024);
  assert.equal(await readExchangeCallback(callbackRequest(utf8Oversized), BACKEND_ORIGIN), null);
});

test("JSON actions accept only the four exact typed action shapes", async () => {
  for (const payload of [
    { action: "connect", binder: BINDER },
    { action: "finalize", binder: BINDER, flowId: FLOW_ID },
    { action: "check" }, { action: "disconnect" },
  ]) assert.deepEqual(await readExchangeAction(actionRequest(payload)), payload);
  for (const payload of [
    null, [], "check", {}, { action: true }, { action: 1 }, { action: null },
    { action: ["check"] }, { action: ["disconnect"] }, { action: { action: "check" } },
    { action: "send" }, { action: "Check" }, { action: "check", extra: true },
    { action: "disconnect", binder: BINDER }, { action: "connect" },
    { action: "connect", binder: [BINDER] }, { action: "connect", binder: "short" },
    { action: "connect", binder: BINDER, flowId: FLOW_ID },
    { action: "finalize", binder: BINDER },
    { action: "finalize", binder: BINDER, flowId: "../flow" },
    { action: "finalize", binder: BINDER, flowId: 123 },
    JSON.parse('{"action":"check","__proto__":{"admin":true}}'),
  ]) assert.equal(await readExchangeAction(actionRequest(payload)), null, JSON.stringify(payload));
});

test("JSON parser rejects malformed, non-JSON, and oversized actions", async () => {
  for (const raw of ["{", "", "{\"action\":}", "[1,2]", JSON.stringify({ action: "check", large: "x".repeat(2048) })]) {
    assert.equal(await readExchangeAction(actionRequest(null, { raw })), null);
  }
  for (const contentType of ["", "text/plain", "application/x-www-form-urlencoded"]) {
    const request = actionRequest({ action: "check" }, { headers: { "content-type": contentType } });
    assert.equal(await readExchangeAction(request), null);
    assert.equal(request.bodyUsed, false);
  }
  const request = actionRequest({ action: "check" }, { headers: { "content-length": "2049" } });
  assert.equal(await readExchangeAction(request), null);
  assert.equal(request.bodyUsed, false);
});

test("public Vercel callback URLs are rejected before body access or forwarding", async () => {
  for (const pathname of [CALLBACK_PATH, `${CALLBACK_PATH}/`]) {
    for (const operator of [null, OWNER]) {
      const request = callbackRequest(undefined, { url: `${PUBLIC_ORIGIN}${pathname}`, headers: { origin: "https://login.microsoftonline.com", "sec-fetch-site": "cross-site" } });
      const prepared = await prepareVercelApiRequest(request, operator, PROXY_CONFIG);
      assert.ok(prepared instanceof Response);
      assert.equal(prepared.status, 403);
      assert.deepEqual(await prepared.json(), { error: "exchange_callback_requires_direct_worker" });
      assert.equal(request.bodyUsed, false);
    }
  }
});

test("direct backend callbacks survive identity stripping without requiring a Web session", async () => {
  const request = callbackRequest(undefined, { headers: { origin: "https://login.microsoftonline.com", "sec-fetch-site": "cross-site", "oai-authenticated-user-email": OWNER } });
  const prepared = await prepareInternalApiRequest(request, edgeEnvironment());
  assert.ok(prepared instanceof Request);
  assert.equal(prepared.headers.get("oai-authenticated-user-email"), null);
  assert.deepEqual(await readExchangeCallback(prepared, BACKEND_ORIGIN), { state: STATE, code: "opaque-provider-code" });
});

test("operator route authenticates before parser, runtime, storage, or service calls", async () => {
  const { route, events } = await operatorRoute();
  for (const headers of [
    {},
    { origin: BACKEND_ORIGIN, authorization: "Bearer mobile-token" },
    { origin: BACKEND_ORIGIN, "oai-authenticated-user-email": "outsider@example.test" },
    { origin: "https://attacker.example", "oai-authenticated-user-email": OWNER },
  ]) {
    const request = actionRequest({ action: "disconnect" }, { headers });
    const response = await route.POST(request);
    assert.ok([401, 403].includes(response.status));
    assert.deepEqual(events, []);
    assert.equal(request.bodyUsed, false);
  }
  const deniedStatus = await route.GET(new Request(`${BACKEND_ORIGIN}${ACTION_PATH}`));
  assert.equal(deniedStatus.status, 401);
  assert.deepEqual(events, []);
});

test("mobile bearer plus spoofed identity cannot obtain Exchange privileges through the edge", async () => {
  const { route, events } = await operatorRoute();
  const request = actionRequest({ action: "disconnect" }, { headers: {
    origin: BACKEND_ORIGIN, authorization: "Bearer mobile-token", "oai-authenticated-user-email": OWNER,
  } });
  const prepared = await prepareInternalApiRequest(request, edgeEnvironment());
  assert.ok(prepared instanceof Request);
  const response = await route.POST(prepared);
  assert.equal(response.status, 401);
  assert.deepEqual(events, []);
  assert.equal(prepared.bodyUsed, false);
});

test("operator route dispatches exact actions; malformed check never disconnects", async () => {
  for (const [payload, expectedService] of [
    [{ action: "connect", binder: BINDER }, "start"],
    [{ action: "finalize", binder: BINDER, flowId: FLOW_ID }, "finalize"],
    [{ action: "check" }, "check"], [{ action: "disconnect" }, "disconnect"],
  ]) {
    const { route, events } = await operatorRoute();
    const response = await route.POST(actionRequest(payload, { headers: { origin: BACKEND_ORIGIN, "oai-authenticated-user-email": OWNER } }));
    assert.equal(response.status, 200);
    assert.deepEqual(events, ["parse", "runtime", expectedService]);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
  const { route, events } = await operatorRoute();
  const invalid = await route.POST(actionRequest({ action: ["check"] }, { headers: { origin: BACKEND_ORIGIN, "oai-authenticated-user-email": OWNER } }));
  assert.equal(invalid.status, 400);
  assert.deepEqual(events, ["parse"]);
});

test("callback redirects contain only completion markers, never submitted secrets or provider errors", async () => {
  for (const failure of [false, true]) {
    const events = [];
    const route = await loadModule("app/api/integrations/exchange/callback/route.ts", {
      "@/lib/exchange-connection-service": { async stageExchangeCallback(_ctx, input) { events.push(input); if (failure) throw new Error("PRIVATE-PROVIDER-TOKEN-ERROR"); } },
      "@/lib/exchange-request": { readExchangeCallback },
      "@/lib/exchange-runtime": { exchangeRuntimeContext() { return { oauth: { publicOrigin: PUBLIC_ORIGIN, callbackOrigin: BACKEND_ORIGIN } }; } },
      "@/lib/http": http,
      "@/lib/exchange-diagnostics": { reportExchangeFailure(action, code) {
        assert.equal(action, "callback");
        assert.equal(code, "exchange_authorization_invalid");
      } },
    });
    const response = await route.POST(callbackRequest());
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), `${PUBLIC_ORIGIN}/settings/exchange?${failure ? "denied" : "complete"}=1`);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    assert.equal(await response.text(), "");
    assert.deepEqual(events, [{ state: STATE, code: "opaque-provider-code" }]);
    const rejectedGet = route.GET();
    assert.equal(rejectedGet.status, 405);
  }
});

test("runtime configuration is opt-in, backend-only, and rejects noncanonical vault keys", async () => {
  const base = {
    CRM_EXCHANGE_ENABLED: "true", CRM_EXCHANGE_TENANT_ID: FLOW_ID,
    CRM_EXCHANGE_MAILBOX_ID: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    CRM_EXCHANGE_CLIENT_ID: "01234567-89ab-cdef-0123-456789abcdef",
    CRM_EXCHANGE_CLIENT_SECRET: "test-only-client-secret", CRM_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
    CRM_EXCHANGE_CALLBACK_ORIGIN: BACKEND_ORIGIN,
    CRM_EXCHANGE_VAULT_KEY: Buffer.alloc(32, 7).toString("base64url"),
  };
  const { parseExchangeOAuthConfig } = await import("../lib/exchange-oauth.ts");
  for (const changes of [
    {}, { CRM_EXCHANGE_ENABLED: undefined }, { CRM_EXCHANGE_ENABLED: "false" },
    { CRM_EXCHANGE_ENABLED: "TRUE" }, { CRM_EXCHANGE_CALLBACK_ORIGIN: PUBLIC_ORIGIN },
    { CRM_EXCHANGE_VAULT_KEY: "short" }, { CRM_EXCHANGE_VAULT_KEY: `${base.CRM_EXCHANGE_VAULT_KEY}=` },
    { CRM_EXCHANGE_VAULT_KEY: `${base.CRM_EXCHANGE_VAULT_KEY.slice(0, -1)}B` },
    { CRM_EXCHANGE_TENANT_ID: "common" }, { CRM_EXCHANGE_CLIENT_SECRET: undefined },
  ]) {
    const env = { ...base, ...changes };
    let stores = 0;
    const runtime = await loadModule("lib/exchange-runtime.ts", {
      "server-only": {}, "./d1": { crmDatabase() { stores += 1; return {}; } },
      "./runtime": { runtimeString(name) { return env[name] ?? null; }, getPrivateObjectBucket() { stores += 1; return {}; } },
      "./exchange-oauth": { parseExchangeOAuthConfig },
    });
    const result = runtime.exchangeRuntimeContext();
    if (Object.keys(changes).length === 0) {
      assert.ok(result); assert.equal(stores, 2);
      assert.deepEqual(result.vault, { tenantId: base.CRM_EXCHANGE_TENANT_ID, mailboxId: base.CRM_EXCHANGE_MAILBOX_ID, clientId: base.CRM_EXCHANGE_CLIENT_ID, encryptionKey: base.CRM_EXCHANGE_VAULT_KEY });
    } else { assert.equal(result, null, JSON.stringify(changes)); assert.equal(stores, 0); }
  }
});

async function operatorRoute() {
  const events = [];
  const apiAuth = await loadModule("lib/api-auth.ts", {
    "server-only": {}, "./auth": operatorAuth, "./http": http,
    "./runtime": { runtimeString(name) { return name === "CRM_ADMIN_EMAILS" ? OWNER : null; } },
    "./d1": { crmDatabase() { throw new Error("unexpected mobile storage access"); } },
    "./mobile-auth": {}, "./mobile-auth-store": {},
  });
  class ExchangeConnectionError extends Error {}
  const service = {
    ExchangeConnectionError,
    async startExchangeConnection() { events.push("start"); return { ok: true }; },
    async finalizeExchangeConnection() { events.push("finalize"); return { ok: true }; },
    async checkExchangeConnection() { events.push("check"); return { ok: true }; },
    async disconnectExchangeConnection() { events.push("disconnect"); return { ok: true }; },
    async exchangeConnectionStatus() { events.push("status"); return { configured: true }; },
  };
  const route = await loadModule("app/api/integrations/exchange/route.ts", {
    "@/lib/api-auth": apiAuth, "@/lib/exchange-connection-service": service,
    "@/lib/exchange-runtime": { exchangeRuntimeContext() { events.push("runtime"); return {}; } },
    "@/lib/exchange-request": { async readExchangeAction(request) { events.push("parse"); return readExchangeAction(request); } },
    "@/lib/http": http,
    "@/lib/exchange-diagnostics": { reportExchangeFailure() { throw new Error("unexpected diagnostic on successful request"); } },
  });
  return { route, events };
}

async function loadModule(path, dependencies) {
  const source = await read(path);
  const transpiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  const require = (name) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name} in ${path}`);
    return dependencies[name];
  };
  new Function("require", "exports", transpiled)(require, exports);
  return exports;
}

function edgeEnvironment() {
  return {
    CRM_API_AUTH_MODE: "internal", CRM_INTERNAL_API_SIGNING_KEY: PROXY_CONFIG.signingKey,
    CRM_INTERNAL_API_AUDIENCE: PROXY_CONFIG.audience,
    DB: { prepare() { throw new Error("unexpected nonce storage access"); } },
  };
}
