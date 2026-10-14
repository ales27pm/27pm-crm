import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import {
  createExchangeAuthorization,
  exchangeAuthorizationCode,
  EXCHANGE_OAUTH_CALLBACK_PATH,
  EXCHANGE_OAUTH_SCOPES,
  parseExchangeOAuthConfig,
  refreshExchangeCredentials,
  verifyExchangeIdToken,
} from "../lib/exchange-oauth.ts";

const CONFIG = {
  tenantId: "a1234567-1234-1234-1234-123456789abc",
  mailboxId: "b1234567-1234-1234-1234-123456789abc",
  clientId: "c1234567-1234-1234-1234-123456789abc",
  clientSecret: "fixture-client-secret+&=",
  publicOrigin: "https://crm.example.com",
  callbackOrigin: "https://api.example.com",
};
const NOW = new Date("2026-10-14T04:00:00Z");
const NOW_SECONDS = NOW.valueOf() / 1000;
const NONCE = "n".repeat(43);
const INPUT = { code: "fixture-code", codeVerifier: "v".repeat(43), nonce: NONCE };
const KEY = await generateKeyPair("RS256", { modulusLength: 2048, extractable: true });
const JWK = { ...await exportJWK(KEY.publicKey), kid: "fixture-key", use: "sig", alg: "RS256" };
const ISSUER = `https://login.microsoftonline.com/${CONFIG.tenantId}/v2.0`;

function baseClaims(changes = {}) {
  return {
    iss: ISSUER, aud: CONFIG.clientId, tid: CONFIG.tenantId, oid: CONFIG.mailboxId,
    sub: "fixed-subject", nonce: NONCE, iat: NOW_SECONDS, nbf: NOW_SECONDS,
    exp: NOW_SECONDS + 3600, ...changes,
  };
}

async function idToken(changes = {}, header = {}) {
  return new SignJWT(baseClaims(changes))
    .setProtectedHeader({ alg: "RS256", kid: JWK.kid, typ: "JWT", ...header })
    .sign(KEY.privateKey);
}

function tokenResponse(id_token, changes = {}) {
  return {
    access_token: "fixture-access-token", refresh_token: "fixture-refresh-token",
    expires_in: 3600, token_type: "Bearer", scope: "Mail.ReadWrite Mail.Send openid profile",
    ...(id_token === undefined ? {} : { id_token }), ...changes,
  };
}

function provider(payload, { keys = [JWK], status = 200 } = {}) {
  const calls = [];
  const fetcher = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).endsWith("/discovery/v2.0/keys")) return Response.json({ keys });
    return Response.json(payload, { status });
  };
  return { calls, fetcher, now: NOW };
}

test("validates immutable IDs and HTTPS origins without accepting configurable token endpoints", () => {
  assert.deepEqual(parseExchangeOAuthConfig(CONFIG), CONFIG);
  for (const changed of [
    { tenantId: "common" }, { tenantId: "consumers" }, { tenantId: `${CONFIG.tenantId}/other` },
    { mailboxId: "alexis@example.com" }, { clientId: "00000000-0000-0000-0000-000000000000" },
    { publicOrigin: "http://crm.example.com" }, { callbackOrigin: "https://api.example.com/path" },
    { callbackOrigin: "https://user:pass@api.example.com" }, { callbackOrigin: "https://api.example.com?x=1" },
    { callbackOrigin: " https://api.example.com" }, { clientSecret: "" }, { clientSecret: "secret\n" },
  ]) assert.equal(parseExchangeOAuthConfig({ ...CONFIG, ...changed }), null);
});

test("builds code + PKCE S256 + form_post with random one-use inputs and only approved scopes", async () => {
  const one = await createExchangeAuthorization(CONFIG, NOW);
  const two = await createExchangeAuthorization(CONFIG, NOW);
  assert.notEqual(one.state, two.state);
  assert.notEqual(one.nonce, two.nonce);
  assert.notEqual(one.codeVerifier, two.codeVerifier);
  for (const value of [one.state, one.nonce, one.codeVerifier]) assert.match(value, /^[\w-]{43}$/u);
  const url = new URL(one.authorizationUrl);
  assert.equal(url.origin, "https://login.microsoftonline.com");
  assert.equal(url.pathname, `/${CONFIG.tenantId}/oauth2/v2.0/authorize`);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("response_mode"), "form_post");
  assert.equal(url.searchParams.get("redirect_uri"), `${CONFIG.callbackOrigin}${EXCHANGE_OAUTH_CALLBACK_PATH}`);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("code_challenge"), createHash("sha256").update(one.codeVerifier).digest("base64url"));
  assert.deepEqual(url.searchParams.get("scope").split(" "), [...EXCHANGE_OAUTH_SCOPES]);
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.equal(url.searchParams.has("code_verifier"), false);
  assert.equal(one.expiresAt, "2026-10-14T04:05:00.000Z");
});

test("exchanges a code only at the pinned tenant, verifies the signed identity, and never requests User.Read", async () => {
  const remote = provider(tokenResponse(await idToken()));
  const result = await exchangeAuthorizationCode(CONFIG, INPUT, remote);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value.identity, { tenantId: CONFIG.tenantId, mailboxId: CONFIG.mailboxId, subject: "fixed-subject" });
  assert.equal(result.value.accessTokenExpiresAt, "2026-10-14T05:00:00.000Z");
  assert.equal(remote.calls.length, 2);
  const request = remote.calls[0];
  assert.equal(request.url, `https://login.microsoftonline.com/${CONFIG.tenantId}/oauth2/v2.0/token`);
  assert.equal(request.init.method, "POST");
  assert.equal(request.init.redirect, "manual");
  assert.equal(request.init.cache, "no-store");
  const body = new URLSearchParams(request.init.body);
  assert.equal(body.get("client_secret"), CONFIG.clientSecret);
  assert.equal(body.get("code_verifier"), INPUT.codeVerifier);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("scope").includes("User.Read"), false);
  assert.equal(remote.calls[1].url, `https://login.microsoftonline.com/${CONFIG.tenantId}/discovery/v2.0/keys`);
});

test("rejects invalid input before making any provider request", async () => {
  const fetcher = async () => assert.fail("No network call should occur");
  for (const invalid of [{ code: "" }, { code: "x".repeat(32769) }, { codeVerifier: "plain" }, { nonce: "wrong" }]) {
    assert.deepEqual(await exchangeAuthorizationCode(CONFIG, { ...INPUT, ...invalid }, { fetcher }), {
      ok: false, error: "exchange_authorization_invalid",
    });
  }
});

test("rejects wrong tenant, mailbox, issuer, audience, nonce, signature timing, and missing stable claims", async () => {
  for (const changed of [
    { tid: CONFIG.clientId }, { oid: CONFIG.clientId }, { iss: "https://attacker.example" },
    { aud: CONFIG.mailboxId }, { aud: [CONFIG.clientId, "other"] }, { nonce: "wrong" },
    { exp: NOW_SECONDS - 10 }, { nbf: NOW_SECONDS + 100 }, { iat: NOW_SECONDS + 100 },
    { exp: undefined }, { nbf: undefined }, { iat: undefined }, { sub: "" }, { sub: undefined },
  ]) {
    const result = await verifyExchangeIdToken(CONFIG, await idToken(changed), NONCE, provider({}));
    assert.deepEqual(result, { ok: false, error: "exchange_identity_invalid" });
  }
  const wrongKey = await generateKeyPair("RS256");
  const wrongSignature = await new SignJWT(baseClaims()).setProtectedHeader({ alg: "RS256", kid: JWK.kid }).sign(wrongKey.privateKey);
  assert.deepEqual(await verifyExchangeIdToken(CONFIG, wrongSignature, NONCE, provider({})), {
    ok: false, error: "exchange_identity_invalid",
  });
});

test("rejects substituted JWKS, duplicate kid, issuer mismatch, and attacker-controlled key endpoints", async () => {
  const token = await idToken();
  for (const keys of [[], [JWK, JWK], [{ ...JWK, kid: "other" }], [{ ...JWK, issuer: "https://attacker.example" }]]) {
    assert.deepEqual(await verifyExchangeIdToken(CONFIG, token, NONCE, provider({}, { keys })), {
      ok: false, error: "exchange_identity_invalid",
    });
  }
  for (const header of [{ jku: "https://attacker.example/keys" }, { x5u: "https://attacker.example/cert" }]) {
    assert.deepEqual(await verifyExchangeIdToken(CONFIG, await idToken({}, header), NONCE, {
      now: NOW, fetcher: async () => assert.fail("Header-supplied URLs are forbidden"),
    }), { ok: false, error: "exchange_identity_invalid" });
  }
  assert.equal((await verifyExchangeIdToken(CONFIG, token, NONCE, provider({}, {
    keys: [{ ...JWK, issuer: "https://login.microsoftonline.com/{tenantid}/v2.0" }],
  }))).ok, true);
});

test("requires both mail scopes and recoverable refresh credentials before returning a connection", async () => {
  for (const changed of [
    { scope: "Mail.Read Mail.Send" }, { scope: "Mail.ReadWrite" }, { scope: undefined },
  ]) {
    const result = await exchangeAuthorizationCode(CONFIG, INPUT, provider(tokenResponse(await idToken(), changed)));
    assert.deepEqual(result, { ok: false, error: "exchange_scopes_missing" });
  }
  for (const changed of [
    { refresh_token: undefined }, { refresh_token: "" }, { access_token: "" },
    { token_type: "Other" }, { expires_in: 0 }, { expires_in: 999999 }, { expires_in: "3600" },
  ]) {
    const result = await exchangeAuthorizationCode(CONFIG, INPUT, provider(tokenResponse(await idToken(), changed)));
    assert.deepEqual(result, { ok: false, error: "exchange_provider_response_invalid" });
  }
  assert.equal((await exchangeAuthorizationCode(CONFIG, INPUT, provider(tokenResponse(await idToken(), {
    scope: "https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/Mail.ReadWrite",
  })))).ok, true);
});

test("refreshes without requiring an ID token and validates any new ID token when present", async () => {
  const remote = provider(tokenResponse(undefined, { refresh_token: "new-fixture-refresh" }));
  const result = await refreshExchangeCredentials(CONFIG, "old-fixture-refresh", remote);
  assert.equal(result.ok, true);
  assert.equal(result.value.refreshToken, "new-fixture-refresh");
  assert.equal(result.value.identity, undefined);
  assert.equal(remote.calls.length, 1);
  assert.equal(new URLSearchParams(remote.calls[0].init.body).get("refresh_token"), "old-fixture-refresh");
  assert.equal(new URLSearchParams(remote.calls[0].init.body).get("grant_type"), "refresh_token");
  assert.equal((await refreshExchangeCredentials(CONFIG, "old", provider(tokenResponse(await idToken({ nonce: undefined }))))).ok, true);
  assert.deepEqual(await refreshExchangeCredentials(CONFIG, "old", provider(tokenResponse(await idToken({ oid: CONFIG.clientId })))), {
    ok: false, error: "exchange_identity_invalid",
  });
});

test("returns only generic errors for invalid grants, provider bodies, transport errors, and oversized responses", async () => {
  const invalidGrant = provider({ error: "invalid_grant", error_description: "secret-detail", access_token: "secret" }, { status: 400 });
  assert.deepEqual(await refreshExchangeCredentials(CONFIG, "fixture", invalidGrant), {
    ok: false, error: "exchange_reauthentication_required",
  });
  const networkError = await refreshExchangeCredentials(CONFIG, "fixture", {
    fetcher: async () => { throw new Error("secret-token-in-provider-error"); },
  });
  assert.deepEqual(networkError, { ok: false, error: "exchange_provider_unavailable" });
  for (const response of [
    new Response("not json"), Response.json(["not-object"]),
    new Response("x".repeat(131073)),
    new Response("short", { headers: { "content-length": "999999" } }),
  ]) {
    assert.deepEqual(await refreshExchangeCredentials(CONFIG, "fixture", { fetcher: async () => response }), {
      ok: false, error: "exchange_provider_response_invalid",
    });
  }
});

test("provider diagnostics distinguish HTTP failures without exposing provider details or changing public errors", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const secret = "fixture-sensitive-provider-detail";
  for (const [status, error, kind, aadsts] of [
    [401, "invalid_client", "invalid_client", 7000215],
    [401, "invalid_client", "invalid_client", 7000222],
    [400, "invalid_request", "invalid_request", 7000218],
    [400, "invalid_scope", "invalid_scope", undefined],
    [400, "unauthorized_client", "unauthorized_client", 700025],
    [403, secret, "forbidden", undefined],
    [429, secret, "rate_limited", undefined],
    [503, secret, "server_error", undefined],
    [400, secret, "http_error", undefined],
    [400, { message: secret }, "http_error", undefined],
    [400, ["invalid_client", secret], "http_error", undefined],
  ]) {
    warn.mock.resetCalls();
    const result = await refreshExchangeCredentials(CONFIG, secret, provider({
      error, error_description: secret, trace_id: secret, correlation_id: secret,
      error_codes: [secret, { message: secret }, 99999999, ...(aadsts ? [aadsts] : [])],
      access_token: secret,
    }, { status }));
    assert.deepEqual(result, { ok: false, error: "exchange_provider_unavailable" });
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [["exchange_provider_failed", {
      endpoint: "token", phase: "http", kind, status, ...(aadsts ? { aadsts } : {}),
    }]]);
    assert.equal(JSON.stringify(warn.mock.calls.map((call) => call.arguments)).includes(secret), false);
  }
});

test("provider diagnostics separate transport timeouts and JWKS failures without logging exception text", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const secret = "fixture-secret-in-error-message";
  for (const [error, kind] of [
    [new DOMException(secret, "TimeoutError"), "timeout"],
    [new DOMException(secret, "AbortError"), "abort"],
    [new TypeError(secret), "transport"],
    [{ name: "TimeoutError", message: secret }, "transport"],
    [secret, "transport"],
  ]) {
    warn.mock.resetCalls();
    assert.deepEqual(await refreshExchangeCredentials(CONFIG, "fixture", {
      fetcher: async () => { throw error; },
    }), { ok: false, error: "exchange_provider_unavailable" });
    assert.deepEqual(warn.mock.calls.map((call) => call.arguments), [["exchange_provider_failed", {
      endpoint: "token", phase: "request", kind,
    }]]);
  }
  warn.mock.resetCalls();
  const token = await idToken();
  assert.deepEqual(await verifyExchangeIdToken(CONFIG, token, NONCE, {
    now: NOW, fetcher: async () => Response.json({ error_description: secret }, { status: 503 }),
  }), { ok: false, error: "exchange_provider_unavailable" });
  assert.deepEqual(warn.mock.calls[0].arguments, ["exchange_provider_failed", {
    endpoint: "jwks", phase: "http", kind: "server_error", status: 503,
  }]);
  assert.equal(JSON.stringify(warn.mock.calls.map((call) => call.arguments)).includes(secret), false);
});

test("provider diagnostics distinguish a response body stream failure from request transport", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  const secret = "fixture-secret-in-stream";
  const body = new ReadableStream({ start(controller) { controller.error(new Error(secret)); } });
  assert.deepEqual(await refreshExchangeCredentials(CONFIG, "fixture", {
    fetcher: async () => new Response(body),
  }), { ok: false, error: "exchange_provider_unavailable" });
  assert.deepEqual(warn.mock.calls[0].arguments, ["exchange_provider_failed", {
    endpoint: "token", phase: "response_body", kind: "transport", status: 200,
  }]);
});

test("rejects every provider redirect before touching its body and never follows its location", async (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  for (const status of [300, 301, 302, 303, 304, 305, 307, 308, 399]) {
    warn.mock.resetCalls();
    let calls = 0;
    let bodyAccess = 0;
    const response = new Response(null, { status, headers: { location: "https://attacker.example/fixture-secret" } });
    Object.defineProperty(response, "body", { get() { bodyAccess++; throw new Error("redirect body must not be read"); } });
    assert.deepEqual(await refreshExchangeCredentials(CONFIG, "fixture", {
      fetcher: async (_url, init) => { calls++; assert.equal(init.redirect, "manual"); return response; },
    }), { ok: false, error: "exchange_provider_response_invalid" });
    assert.equal(calls, 1);
    assert.equal(bodyAccess, 0);
    assert.deepEqual(warn.mock.calls[0].arguments, ["exchange_provider_failed", {
      endpoint: "token", phase: "http", kind: "redirect", status,
    }]);
    assert.equal(JSON.stringify(warn.mock.calls.map((call) => call.arguments)).includes("attacker.example"), false);
  }
});

test("actual Worker Request accepts the OAuth fetch options at the deployed compatibility date", async (t) => {
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const remote = provider(tokenResponse(await idToken()));
  assert.equal((await exchangeAuthorizationCode(CONFIG, INPUT, remote)).ok, true);
  const init = remote.calls[0].init;
  const serialized = JSON.stringify({ ...init, body: init.body.toString(), signal: undefined });
  // Local workerd only: no provider request, credentials, persistent bindings or external mutations.
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-09-11", compatibilityFlags: ["nodejs_compat"],
    script: `export default { fetch() {
      const init = ${serialized};
      init.signal = AbortSignal.timeout(10000);
      const request = new Request("https://fixture.example/token", init);
      return Response.json({ method: request.method, redirect: request.redirect });
    } };`,
  }));
  t.after(() => mf.dispose());
  const response = await mf.dispatchFetch("http://local.invalid");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { method: "POST", redirect: "manual" });
});
