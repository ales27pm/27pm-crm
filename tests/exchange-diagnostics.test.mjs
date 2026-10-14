import assert from "node:assert/strict";
import test from "node:test";

import { reportExchangeFailure, reportExchangeProviderFailure } from "../lib/exchange-diagnostics.ts";

const actions = ["connect", "finalize", "check", "disconnect", "callback", "sync"];
const knownCodes = [
  "exchange_configuration_mismatch", "exchange_already_connected", "exchange_flow_busy",
  "exchange_connection_unavailable", "exchange_authorization_invalid", "exchange_connection_busy",
  "exchange_connection_changed", "exchange_reauthentication_required", "exchange_storage_unavailable",
  "exchange_configuration_invalid", "exchange_provider_unavailable", "exchange_provider_response_invalid",
  "exchange_identity_invalid", "exchange_scopes_missing",
  "exchange_graph_configuration_invalid", "exchange_graph_request_invalid",
  "exchange_graph_connection_changed", "exchange_graph_response_invalid",
  "exchange_graph_unavailable", "exchange_graph_timeout",
  "exchange_graph_reauthentication_required", "exchange_graph_forbidden",
  "exchange_graph_not_found", "exchange_graph_delta_reset", "exchange_graph_throttled",
  "exchange_graph_request_rejected", "exchange_sync_unavailable",
];

test("Exchange diagnostics retain only known literal action and error labels", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const action of actions) {
    for (const code of knownCodes) {
      assert.equal(reportExchangeFailure(action, code), undefined);
      assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["exchange_connection_failed", { action, code }]);
    }
  }
  assert.equal(warn.mock.callCount(), actions.length * knownCodes.length);
});

test("unknown strings, secrets, provider details, identifiers and error objects reduce to the generic code", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const secret = "fixture-refresh-token-never-log-this";
  const inputs = [
    undefined, null, false, 42, Symbol(secret), secret,
    "exchange_identity_invalid " + secret, "exchange_" + secret,
    "exchange_identity_invalid\n" + secret, "EXCHANGE_IDENTITY_INVALID",
    "alexis@example.test", "11111111-2222-3333-4444-555555555555",
    "https://provider.example/callback?code=" + secret,
    new Error(secret), { code: "exchange_identity_invalid", message: secret, stack: secret },
    { refreshToken: secret, accessToken: secret, authorizationCode: secret, binder: secret, state: secret },
    ["exchange_identity_invalid"], Object("exchange_identity_invalid"),
    { toString() { throw new Error("must not coerce " + secret); } },
  ];
  for (const input of inputs) {
    assert.doesNotThrow(() => reportExchangeFailure("finalize", input));
    assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["exchange_connection_failed", {
      action: "finalize", code: "exchange_connection_unavailable",
    }]);
  }
  assert.equal(warn.mock.callCount(), inputs.length);
  const captured = JSON.stringify(warn.mock.calls.map((call) => call.arguments));
  assert.equal(captured.includes(secret), false);
  assert.equal(captured.includes("alexis@example.test"), false);
  assert.equal(captured.includes("11111111-2222-3333-4444-555555555555"), false);
  assert.equal(captured.includes("stack"), false);
});

test("unrecognized actions emit nothing and never inspect request or error objects", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const secret = "fixture-request-secret";
  const hostile = new Proxy({}, { get() { throw new Error("must not inspect " + secret); } });
  for (const action of [undefined, null, false, 42, "", "FINALIZE", "status", "finalize\n" + secret,
    "finalize " + secret, ["finalize"], Object("finalize"), hostile]) {
    assert.doesNotThrow(() => reportExchangeFailure(action, hostile));
  }
  assert.equal(warn.mock.callCount(), 0);
  assert.doesNotThrow(() => reportExchangeFailure("callback", hostile));
  assert.deepEqual(warn.mock.calls.at(-1)?.arguments, ["exchange_connection_failed", {
    action: "callback", code: "exchange_connection_unavailable",
  }]);
});

test("provider diagnostics admit only closed labels and bounded nonsecret numbers", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  reportExchangeProviderFailure("token", "http", "invalid_client", 401, 7000215);
  assert.deepEqual(warn.mock.calls[0].arguments, ["exchange_provider_failed", {
    endpoint: "token", phase: "http", kind: "invalid_client", status: 401, aadsts: 7000215,
  }]);
  const secret = "fixture-sensitive-provider-secret";
  const hostile = new Proxy({}, { get() { throw new Error("must not inspect " + secret); } });
  const badValues = [undefined, null, false, secret, Symbol(secret), hostile, [401], Object(401), NaN, Infinity, 99, 600, 401.5];
  for (const value of badValues) {
    warn.mock.resetCalls();
    assert.doesNotThrow(() => reportExchangeProviderFailure(value, "http", "http_error", 400));
    assert.doesNotThrow(() => reportExchangeProviderFailure("token", value, "http_error", 400));
    assert.doesNotThrow(() => reportExchangeProviderFailure("token", "http", value, 400));
    assert.equal(warn.mock.callCount(), 0);
    assert.doesNotThrow(() => reportExchangeProviderFailure("jwks", "request", "transport", value, value));
    assert.deepEqual(warn.mock.calls[0].arguments, ["exchange_provider_failed", {
      endpoint: "jwks", phase: "request", kind: "transport",
    }]);
  }
  warn.mock.resetCalls();
  reportExchangeProviderFailure("token", "http", "http_error", 400, 99999999);
  assert.deepEqual(warn.mock.calls[0].arguments, ["exchange_provider_failed", {
    endpoint: "token", phase: "http", kind: "http_error", status: 400,
  }]);
  assert.equal(JSON.stringify(warn.mock.calls.map((call) => call.arguments)).includes(secret), false);
});
