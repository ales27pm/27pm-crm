import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { operatorAuditDetails } from "../lib/auth.ts";
import {
  createMobileAccessToken,
  hasMobileScope,
  mobileAppleAppSiteAssociation,
  MOBILE_AUTHORIZATION_CODE_TTL_SECONDS,
  MOBILE_CLIENT_ID,
  MOBILE_SCOPE_VALUE,
  MOBILE_SESSION_TTL_SECONDS,
  mobileBearerToken,
  mobilePkceChallenge,
  parseMobileAuthorizationRequest,
  parseMobileRefreshToken,
  readMobileAuthJson,
  validMobileRedirectUri,
  validMobileIosAppId,
  verifyMobileAccessToken,
} from "../lib/mobile-auth.ts";
import {
  activeMobileSession,
  createMobileAuthorizationGrant,
  exchangeMobileAuthorizationCode,
  listActiveMobileSessions,
  revokeMobileSession,
  revokeMobileSessionByOperator,
  rotateMobileRefreshToken,
} from "../lib/mobile-auth-store.ts";

const SIGNING_SECRET = Buffer.alloc(32, 27).toString("base64url");
const ISSUER = "https://crm.27pm.org";
const REDIRECT_URI = "https://crm.27pm.org/mobile/oauth/callback";
const VERIFIER = "v".repeat(64);
const NOW = new Date("2026-10-01T12:00:00.000Z");

test("mobile audit details bind mutations to the verified device session", async () => {
  const sessionId = "ab8c07d3-9c64-4f55-a55d-28ba4a955a5a";
  assert.deepEqual(
    operatorAuditDetails(
      { email: "alexis@27pm.org", mobileSessionId: sessionId },
      { status: "done" },
    ),
    {
      status: "done",
      authentication: { source: "mobile", sessionId },
    },
  );
  assert.deepEqual(
    operatorAuditDetails({ email: "alexis@27pm.org" }, { status: "done" }),
    { status: "done" },
  );

  const auditedMutationSources = await Promise.all([
    "../app/api/conversations/[id]/route.ts",
    "../app/api/deals/[id]/route.ts",
    "../app/api/intake/[id]/route.ts",
    "../app/api/strategies/[strategyId]/route.ts",
    "../app/api/strategies/[strategyId]/steps/[stepId]/route.ts",
    "../app/api/tasks/route.ts",
    "../app/api/tasks/[id]/route.ts",
    "../lib/crm-prospects.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of auditedMutationSources) {
    assert.match(source, /operatorAuditDetails/u);
  }
});

test("mobile authorization requests require a fixed client, redirect, state, and PKCE S256", async () => {
  const challenge = await mobilePkceChallenge(VERIFIER);
  assert.ok(challenge);
  const input = {
    response_type: "code",
    client_id: MOBILE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "s".repeat(32),
    device_name: "  Alexis iPhone  ",
  };
  assert.deepEqual(parseMobileAuthorizationRequest(input, REDIRECT_URI), {
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    state: "s".repeat(32),
    deviceName: "Alexis iPhone",
  });
  for (const invalid of [
    { ...input, client_id: "other-client" },
    { ...input, redirect_uri: "https://attacker.example/callback" },
    { ...input, code_challenge_method: "plain" },
    { ...input, responseType: "token" },
    { ...input, clientId: "other-client" },
    { ...input, state: "short" },
    { ...input, response_type: "token" },
  ]) {
    assert.equal(parseMobileAuthorizationRequest(invalid, REDIRECT_URI), null);
  }
  assert.equal(validMobileRedirectUri("javascript:alert(1)"), null);
  assert.equal(validMobileRedirectUri("http://crm.27pm.org/callback"), null);
  assert.equal(validMobileRedirectUri("org.27pm.crm://oauth/callback"), null);
  assert.equal(validMobileRedirectUri(REDIRECT_URI, ISSUER), REDIRECT_URI);
  assert.equal(
    validMobileRedirectUri(
      "https://attacker.example/mobile/oauth/callback",
      ISSUER,
    ),
    null,
  );
  assert.equal(validMobileIosAppId("ABCDE12345.org.27pm.crm.mobile"), true);
  assert.equal(validMobileIosAppId("org.27pm.crm.mobile"), false);
  assert.deepEqual(
    mobileAppleAppSiteAssociation("ABCDE12345.org.27pm.crm.mobile"),
    {
      applinks: {
        details: [
          {
            appIDs: ["ABCDE12345.org.27pm.crm.mobile"],
            components: [
              {
                "/": "/mobile/oauth/callback",
                comment: "27PM CRM mobile authorization callback",
              },
            ],
          },
        ],
      },
      webcredentials: {
        apps: ["ABCDE12345.org.27pm.crm.mobile"],
      },
    },
  );
});

test("the Apple association route fails closed without the configured iOS app identity", async () => {
  const source = await readFile(
    new URL("../app/.well-known/apple-app-site-association/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /runtimeString\("CRM_IOS_APP_ID"\)/u);
  assert.match(source, /validMobileIosAppId\(appId\)/u);
  assert.match(source, /ios_universal_link_unavailable/u);
  assert.match(source, /status: 503/u);
  assert.match(source, /mobileAppleAppSiteAssociation\(appId\)/u);
});

test("fixed-format access tokens reject tampering, wrong boundaries, and expiry", async () => {
  const sessionId = "ab8c07d3-9c64-4f55-a55d-28ba4a955a5a";
  const issued = await createMobileAccessToken(SIGNING_SECRET, {
    issuer: ISSUER,
    operatorEmail: "Alexis@27PM.org",
    sessionId,
  }, NOW);
  const verified = await verifyMobileAccessToken(
    SIGNING_SECRET,
    issued.token,
    ISSUER,
    NOW,
  );
  assert.equal(verified?.subject, "alexis@27pm.org");
  assert.equal(verified?.sessionId, sessionId);
  assert.equal(verified?.scopes, MOBILE_SCOPE_VALUE);
  assert.equal(hasMobileScope(verified, "crm:dashboard:read"), true);
  assert.equal(hasMobileScope(verified, "crm:work"), true);

  const last = issued.token.at(-1);
  const tampered = `${issued.token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  assert.equal(await verifyMobileAccessToken(SIGNING_SECRET, tampered, ISSUER, NOW), null);
  assert.equal(await verifyMobileAccessToken(Buffer.alloc(32, 9).toString("base64url"), issued.token, ISSUER, NOW), null);
  assert.equal(await verifyMobileAccessToken(SIGNING_SECRET, issued.token, "https://other.example", NOW), null);
  assert.equal(await verifyMobileAccessToken(SIGNING_SECRET, issued.token, ISSUER, new Date("2026-10-01T12:15:00.000Z")), null);
  assert.equal(await verifyMobileAccessToken("too-short", issued.token, ISSUER, NOW), null);
  assert.equal(await verifyMobileAccessToken(SIGNING_SECRET, `ma1.bad.${"a".repeat(43)}`, ISSUER, NOW), null);
  assert.equal(await verifyMobileAccessToken(SIGNING_SECRET, `${issued.token}..junk`, ISSUER, NOW), null);
});

test("bearer parsing is strict and mobile auth bodies are bounded", async () => {
  assert.equal(
    mobileBearerToken(new Request(ISSUER, { headers: { authorization: "Bearer ma1.payload.signature" } })),
    "ma1.payload.signature",
  );
  assert.equal(mobileBearerToken(new Request(ISSUER)), undefined);
  for (const value of ["bearer token", "Bearer", "Bearer token extra", "Basic token"]) {
    assert.equal(mobileBearerToken(new Request(ISSUER, { headers: { authorization: value } })), null);
  }
  assert.deepEqual(
    await readMobileAuthJson(new Request(ISSUER, { method: "POST", headers: { "content-type": "application/json; charset=utf-8" }, body: '{"ok":true}' })),
    { ok: true },
  );
  assert.equal(
    await readMobileAuthJson(new Request(ISSUER, { method: "POST", body: '{"ok":true}' })),
    null,
  );
  assert.equal(
    await readMobileAuthJson(new Request(ISSUER, { method: "POST", headers: { "content-type": "application/json" }, body: `{"v":"${"x".repeat(9000)}"}` })),
    null,
  );
  let cancelled = false;
  const oversizedStream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`{"v":"${"x".repeat(9000)}`));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(
    await readMobileAuthJson(new Request(ISSUER, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: oversizedStream,
      duplex: "half",
    })),
    null,
  );
  assert.equal(cancelled, true);
});

test("authorization-code exchange is atomic when session creation fails", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  createMobileTables(sqlite);
  const db = d1Adapter(sqlite);
  const challenge = await mobilePkceChallenge(VERIFIER);
  const request = parseMobileAuthorizationRequest({
    responseType: "code",
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: "a".repeat(32),
  }, REDIRECT_URI);
  assert.ok(request);
  const grant = await createMobileAuthorizationGrant(db, {
    operator: { email: "alexis@27pm.org" },
    request,
  }, NOW);

  db.failNextBatchAt(1);
  await assert.rejects(exchangeMobileAuthorizationCode(db, {
    code: grant.code,
    codeVerifier: VERIFIER,
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    operatorAllowlist: "alexis@27pm.org",
  }, NOW), /injected_batch_failure/u);
  const unconsumed = sqlite
    .prepare("SELECT consumed_at, consumed_session_id FROM mobile_authorization_grants WHERE code_hash IS NOT NULL")
    .get();
  assert.equal(unconsumed.consumed_at, null);
  assert.equal(unconsumed.consumed_session_id, null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM mobile_sessions").get().total, 0);

  const retry = await exchangeMobileAuthorizationCode(db, {
    code: grant.code,
    codeVerifier: VERIFIER,
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    operatorAllowlist: "alexis@27pm.org",
  }, NOW);
  assert.ok(retry);
});

test("authorization grants and mobile sessions reject their exact expiry boundary", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  createMobileTables(sqlite);
  const db = d1Adapter(sqlite);
  const challenge = await mobilePkceChallenge(VERIFIER);
  const request = parseMobileAuthorizationRequest({
    responseType: "code",
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: "e".repeat(32),
    deviceName: "iPhone expiry",
  }, REDIRECT_URI);
  assert.ok(request);
  const expiringGrant = await createMobileAuthorizationGrant(db, {
    operator: { email: "alexis@27pm.org" },
    request,
  }, NOW);
  assert.equal(await exchangeMobileAuthorizationCode(db, {
    code: expiringGrant.code,
    codeVerifier: VERIFIER,
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    operatorAllowlist: "alexis@27pm.org",
  }, new Date(NOW.valueOf() + MOBILE_AUTHORIZATION_CODE_TTL_SECONDS * 1000)), null);

  const session = await issueMobileSession(db, "x", "iPhone session expiry");
  assert.ok(session);
  const access = await createMobileAccessToken(SIGNING_SECRET, {
    issuer: ISSUER,
    operatorEmail: session.operator.email,
    sessionId: session.sessionId,
  }, NOW);
  const claims = await verifyMobileAccessToken(
    SIGNING_SECRET,
    access.token,
    ISSUER,
    NOW,
  );
  assert.ok(claims);
  const sessionExpiry = new Date(
    NOW.valueOf() + MOBILE_SESSION_TTL_SECONDS * 1000,
  );
  assert.equal(
    await activeMobileSession(db, claims, "alexis@27pm.org", sessionExpiry),
    null,
  );
  assert.equal(await rotateMobileRefreshToken(db, {
    refreshToken: session.refreshToken,
    clientId: MOBILE_CLIENT_ID,
    operatorAllowlist: "alexis@27pm.org",
  }, sessionExpiry), null);
});

test("authorization codes are hashed, single-use, PKCE-bound, refresh-rotated, and revocable", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  createMobileTables(sqlite);
  const db = d1Adapter(sqlite);
  const challenge = await mobilePkceChallenge(VERIFIER);
  assert.ok(challenge);
  const request = parseMobileAuthorizationRequest({
    responseType: "code",
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: "z".repeat(32),
    deviceName: "iPhone de test",
  }, REDIRECT_URI);
  assert.ok(request);
  const grant = await createMobileAuthorizationGrant(db, {
    operator: { email: "alexis@27pm.org" },
    request,
  }, NOW);
  assert.equal(sqlite.prepare("SELECT code_hash FROM mobile_authorization_grants").get().code_hash.includes(grant.code), false);
  assert.equal(await exchangeMobileAuthorizationCode(db, {
    code: grant.code,
    codeVerifier: "w".repeat(64),
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    operatorAllowlist: "alexis@27pm.org",
  }, NOW), null);

  const attempts = await Promise.all(Array.from({ length: 5 }, () =>
    exchangeMobileAuthorizationCode(db, {
      code: grant.code,
      codeVerifier: VERIFIER,
      clientId: MOBILE_CLIENT_ID,
      redirectUri: REDIRECT_URI,
      operatorAllowlist: "alexis@27pm.org",
    }, NOW)));
  assert.equal(attempts.filter(Boolean).length, 1);
  const session = attempts.find(Boolean);
  assert.ok(session);
  assert.equal(sqlite.prepare("SELECT refresh_token_hash FROM mobile_sessions").get().refresh_token_hash.includes(session.refreshToken), false);

  const access = await createMobileAccessToken(SIGNING_SECRET, {
    issuer: ISSUER,
    operatorEmail: session.operator.email,
    sessionId: session.sessionId,
  }, NOW);
  const claims = await verifyMobileAccessToken(SIGNING_SECRET, access.token, ISSUER, NOW);
  assert.ok(claims);
  assert.deepEqual(await activeMobileSession(db, claims, "alexis@27pm.org", NOW), {
    email: "alexis@27pm.org",
    mobileSessionId: session.sessionId,
  });
  assert.equal(await activeMobileSession(db, claims, "other@27pm.org", NOW), null);

  const rotated = await rotateMobileRefreshToken(db, {
    refreshToken: session.refreshToken,
    clientId: MOBILE_CLIENT_ID,
    operatorAllowlist: "alexis@27pm.org",
  }, new Date("2026-10-01T12:10:00.000Z"));
  assert.ok(rotated);
  assert.notEqual(rotated.refreshToken, session.refreshToken);
  assert.equal(parseMobileRefreshToken(`${rotated.refreshToken}..junk`), null);
  assert.equal(await rotateMobileRefreshToken(db, {
    refreshToken: session.refreshToken,
    clientId: MOBILE_CLIENT_ID,
    operatorAllowlist: "alexis@27pm.org",
  }, new Date("2026-10-01T12:11:00.000Z")), null);
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM mobile_sessions WHERE id=?").get(session.sessionId).revoked_at,
    "2026-10-01T12:11:00.000Z",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS total FROM audit_entries WHERE action='mobile.refresh_token_reuse_detected'").get().total,
    1,
  );
  await revokeMobileSession(db, { refreshToken: rotated.refreshToken }, new Date("2026-10-01T12:12:00.000Z"));
  assert.equal(await activeMobileSession(db, claims, "alexis@27pm.org", new Date("2026-10-01T12:12:00.000Z")), null);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM audit_entries WHERE details_json LIKE '%mc1.%' OR details_json LIKE '%mr1.%'").get().total, 0);
});

test("an authenticated operator can list and revoke a lost mobile device", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  createMobileTables(sqlite);
  const db = d1Adapter(sqlite);
  const challenge = await mobilePkceChallenge(VERIFIER);
  const request = parseMobileAuthorizationRequest({
    responseType: "code",
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: "l".repeat(32),
    deviceName: "iPhone perdu",
  }, REDIRECT_URI);
  assert.ok(request);
  const grant = await createMobileAuthorizationGrant(db, {
    operator: { email: "alexis@27pm.org" },
    request,
  }, NOW);
  const session = await exchangeMobileAuthorizationCode(db, {
    code: grant.code,
    codeVerifier: VERIFIER,
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    operatorAllowlist: "alexis@27pm.org",
  }, NOW);
  assert.ok(session);
  const listed = await listActiveMobileSessions(db, "Alexis@27PM.org", NOW);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, session.sessionId);
  assert.equal(listed[0].deviceName, "iPhone perdu");
  assert.equal(await revokeMobileSessionByOperator(db, {
    sessionId: session.sessionId,
    operator: { email: "other@27pm.org" },
  }, NOW), false);
  assert.equal(await revokeMobileSessionByOperator(db, {
    sessionId: session.sessionId,
    operator: { email: "alexis@27pm.org" },
  }, NOW), true);
  assert.equal((await listActiveMobileSessions(db, "alexis@27pm.org", NOW)).length, 0);
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS total FROM audit_entries WHERE action='mobile.session_revoked_by_operator'").get().total,
    1,
  );
});

test("refresh rotation rolls back every failed batch step and stale logout revokes the family", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  createMobileTables(sqlite);
  const db = d1Adapter(sqlite);
  const initial = await issueMobileSession(db, "r", "iPhone rotation");
  assert.ok(initial);
  let current = initial;

  for (let failureIndex = 0; failureIndex < 6; failureIndex += 1) {
    db.failNextBatchAt(failureIndex);
    await assert.rejects(rotateMobileRefreshToken(db, {
      refreshToken: current.refreshToken,
      clientId: MOBILE_CLIENT_ID,
      operatorAllowlist: "alexis@27pm.org",
    }, new Date(NOW.valueOf() + (failureIndex + 1) * 60_000)), /injected_batch_failure/u);
    const retry = await rotateMobileRefreshToken(db, {
      refreshToken: current.refreshToken,
      clientId: MOBILE_CLIENT_ID,
      operatorAllowlist: "alexis@27pm.org",
    }, new Date(NOW.valueOf() + (failureIndex + 1) * 60_000));
    assert.ok(retry);
    current = retry;
  }

  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS total FROM mobile_refresh_tokens WHERE session_id=?").get(initial.sessionId).total,
    7,
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS total FROM mobile_refresh_tokens WHERE session_id=? AND rotated_at IS NULL").get(initial.sessionId).total,
    1,
  );
  await revokeMobileSession(db, { refreshToken: initial.refreshToken }, new Date("2026-10-01T12:10:00.000Z"));
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM mobile_sessions WHERE id=?").get(initial.sessionId).revoked_at,
    "2026-10-01T12:10:00.000Z",
  );
});

test("concurrent refresh reuse revokes the family while an unknown family token does not", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  createMobileTables(sqlite);
  const db = d1Adapter(sqlite);

  const unknownSession = await issueMobileSession(
    db,
    "u",
    "iPhone unknown token",
  );
  assert.ok(unknownSession);
  const tokenParts = unknownSession.refreshToken.split(".");
  assert.equal(tokenParts.length, 3);
  const finalCharacter = tokenParts[2].at(-1);
  tokenParts[2] = `${tokenParts[2].slice(0, -1)}${finalCharacter === "A" ? "B" : "A"}`;
  assert.equal(await rotateMobileRefreshToken(db, {
    refreshToken: tokenParts.join("."),
    clientId: MOBILE_CLIENT_ID,
    operatorAllowlist: "alexis@27pm.org",
  }, new Date("2026-10-01T12:01:00.000Z")), null);
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM mobile_sessions WHERE id=?")
      .get(unknownSession.sessionId).revoked_at,
    null,
  );

  const concurrentSession = await issueMobileSession(
    db,
    "c",
    "iPhone concurrent refresh",
  );
  assert.ok(concurrentSession);
  const rotations = await Promise.all(Array.from({ length: 2 }, () =>
    rotateMobileRefreshToken(db, {
      refreshToken: concurrentSession.refreshToken,
      clientId: MOBILE_CLIENT_ID,
      operatorAllowlist: "alexis@27pm.org",
    }, new Date("2026-10-01T12:02:00.000Z"))));
  assert.equal(rotations.filter(Boolean).length, 1);
  assert.equal(
    sqlite.prepare("SELECT revoked_at FROM mobile_sessions WHERE id=?")
      .get(concurrentSession.sessionId).revoked_at,
    "2026-10-01T12:02:00.000Z",
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS total FROM audit_entries WHERE action='mobile.refresh_token_reuse_detected' AND entity_id=?")
      .get(concurrentSession.sessionId).total,
    1,
  );
});

async function issueMobileSession(db, stateCharacter, deviceName) {
  const challenge = await mobilePkceChallenge(VERIFIER);
  const request = parseMobileAuthorizationRequest({
    responseType: "code",
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    codeChallenge: challenge,
    codeChallengeMethod: "S256",
    state: stateCharacter.repeat(32),
    deviceName,
  }, REDIRECT_URI);
  assert.ok(request);
  const grant = await createMobileAuthorizationGrant(db, {
    operator: { email: "alexis@27pm.org" },
    request,
  }, NOW);
  return exchangeMobileAuthorizationCode(db, {
    code: grant.code,
    codeVerifier: VERIFIER,
    clientId: MOBILE_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    operatorAllowlist: "alexis@27pm.org",
  }, NOW);
}

function createMobileTables(database) {
  database.exec(`CREATE TABLE audit_entries (
    id TEXT PRIMARY KEY NOT NULL, actor_email TEXT NOT NULL, action TEXT NOT NULL,
    entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
    details_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE mobile_authorization_grants (
    id TEXT PRIMARY KEY NOT NULL, code_hash TEXT NOT NULL UNIQUE,
    operator_email TEXT NOT NULL, client_id TEXT NOT NULL, redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL, scopes TEXT NOT NULL, device_name TEXT,
    expires_at TEXT NOT NULL, consumed_at TEXT, consumed_session_id TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE mobile_sessions (
    id TEXT PRIMARY KEY NOT NULL, authorization_grant_id TEXT NOT NULL UNIQUE,
    operator_email TEXT NOT NULL, client_id TEXT NOT NULL, device_name TEXT,
    scopes TEXT NOT NULL, refresh_token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL, last_refreshed_at TEXT NOT NULL, revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (authorization_grant_id) REFERENCES mobile_authorization_grants(id)
  );
  CREATE TABLE mobile_refresh_tokens (
    token_hash TEXT PRIMARY KEY NOT NULL, session_id TEXT NOT NULL,
    issued_at TEXT NOT NULL, rotated_at TEXT,
    FOREIGN KEY (session_id) REFERENCES mobile_sessions(id)
  );
  CREATE UNIQUE INDEX mobile_refresh_tokens_one_current
    ON mobile_refresh_tokens(session_id) WHERE rotated_at IS NULL`);
}

function d1Adapter(database) {
  let failureIndex = null;
  const prepare = (sql) => {
    const state = { values: [] };
    return {
      bind(...values) {
        state.values = values;
        return this;
      },
      async first() {
        return database.prepare(sql).get(...state.values) ?? null;
      },
      async all() {
        return { results: database.prepare(sql).all(...state.values), success: true };
      },
      async run() {
        const result = database.prepare(sql).run(...state.values);
        return { success: true, meta: { changes: result.changes } };
      },
    };
  };
  return {
    prepare,
    failNextBatchAt(index) {
      failureIndex = index;
    },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        const injectedFailureIndex = failureIndex;
        failureIndex = null;
        for (const [index, statement] of statements.entries()) {
          if (index === injectedFailureIndex) {
            throw new Error("injected_batch_failure");
          }
          results.push(await statement.run());
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
