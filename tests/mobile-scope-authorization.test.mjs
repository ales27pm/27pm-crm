import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {};" };
    if (specifier === "cloudflare:workers") return { shortCircuit: true,
      url: "data:text/javascript,export const env=new Proxy({}, {get:(_,key)=>globalThis.__mobileScopeEnv?.[key]});" };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { createMobileAccessToken, MOBILE_CLIENT_ID, MOBILE_SCOPE_VALUE, verifyMobileAccessToken } = await import("../lib/mobile-auth.ts");
const { requireOperatorOrMobileRequest } = await import("../lib/api-auth.ts");
const ORIGIN = "https://crm.27pm.org";
const SIGNING_SECRET = Buffer.alloc(32, 61).toString("base64url");
const SESSION = "7793cc19-fd7c-48be-857c-f6aa361e8178";

test("mobile API authorizes canonical scope subsets only against a current full-scope grant", async t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => { sqlite.close(); delete globalThis.__mobileScopeEnv; });
  sqlite.exec(`CREATE TABLE mobile_sessions (
    id TEXT PRIMARY KEY, authorization_grant_id TEXT, operator_email TEXT,
    client_id TEXT, device_name TEXT, scopes TEXT, refresh_token_hash TEXT,
    expires_at TEXT, revoked_at TEXT);
  `);
  sqlite.prepare("INSERT INTO mobile_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
    .run(SESSION, "fixture-grant", "operator@example.com", MOBILE_CLIENT_ID, "Fixture device", MOBILE_SCOPE_VALUE,
      "fixture-only-refresh-hash", new Date(Date.now() + 3_600_000).toISOString());
  const db = { prepare(sql) {
    let values = [];
    return { bind(...args) { values = args; return this; }, async first() { return sqlite.prepare(sql).get(...values) ?? null; } };
  } };
  globalThis.__mobileScopeEnv = { DB: db, CRM_ADMIN_EMAILS: "operator@example.com",
    CRM_MOBILE_TOKEN_SIGNING_KEY: SIGNING_SECRET, CRM_PUBLIC_ORIGIN: ORIGIN };
  const issued = await createMobileAccessToken(SIGNING_SECRET, { issuer: ORIGIN, operatorEmail: "operator@example.com", sessionId: SESSION });
  const [prefix, encoded] = issued.token.split(".");
  const claims = JSON.parse(Buffer.from(encoded, "base64url").toString());
  const sign = (scopes, sessionId = SESSION) => {
    const payload = Buffer.from(JSON.stringify({ ...claims, scp: scopes, sid: sessionId })).toString("base64url");
    const input = `${prefix}.${payload}`;
    return `${input}.${createHmac("sha256", Buffer.from(SIGNING_SECRET, "base64url")).update(input).digest("base64url")}`;
  };
  const authorize = (token, scope) => requireOperatorOrMobileRequest(new Request(`${ORIGIN}/api/tasks`, {
    headers: { authorization: `Bearer ${token}` },
  }), scope);
  for (const scopes of ["crm:work crm:dashboard:read", "crm:dashboard:read crm:dashboard:read", "crm:work crm:work", "crm:admin", ""]) {
    assert.equal(await verifyMobileAccessToken(SIGNING_SECRET, sign(scopes), ORIGIN), null);
  }
  for (const scope of ["crm:dashboard:read", "crm:work"]) {
    const auth = await authorize(sign(scope), scope);
    assert.deepEqual(auth.operator, { email: "operator@example.com", mobileSessionId: SESSION });
  }
  const readOnly = sign("crm:dashboard:read");
  const forbidden = await authorize(readOnly, "crm:work");
  assert.equal(forbidden.response.status, 403);
  assert.deepEqual(await forbidden.response.json(), { error: "mobile_scope_forbidden" });
  const unknown = await authorize(sign("crm:dashboard:read", "a7e83f2a-69ca-4ff5-9096-b117ac77c020"), "crm:work");
  assert.equal(unknown.response.status, 401);
  sqlite.prepare("UPDATE mobile_sessions SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), SESSION);
  assert.equal((await authorize(readOnly, "crm:work")).response.status, 401);
  sqlite.prepare("UPDATE mobile_sessions SET revoked_at=NULL, scopes='crm:dashboard:read' WHERE id=?").run(SESSION);
  assert.equal((await authorize(readOnly, "crm:dashboard:read")).response.status, 401);
});
