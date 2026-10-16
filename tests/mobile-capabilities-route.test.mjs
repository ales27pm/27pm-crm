import assert from "node:assert/strict";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

register(`data:text/javascript,${encodeURIComponent(`
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript,export {};" };
    if (specifier === "cloudflare:workers") return { shortCircuit: true,
      url: "data:text/javascript,export const env=new Proxy({}, {get:(_,key)=>globalThis.__mobileCapabilityTestEnv?.[key]});" };
    return nextResolve(specifier, context);
  }
`)}`, import.meta.url);

const { createMobileAccessToken, MOBILE_CLIENT_ID, MOBILE_SCOPE_VALUE } = await import("../lib/mobile-auth.ts");
const ORIGIN = "https://crm.27pm.org";
const SIGNING_SECRET = Buffer.alloc(32, 62).toString("base64url");
const SESSION = "7793cc19-fd7c-48be-857c-f6aa361e8178";

test("the mobile capability endpoint is authenticated, read-only, and cannot enable an unavailable transport", async t => {
  const { GET } = await import("../app/api/mobile/capabilities/route.ts");
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => { sqlite.close(); delete globalThis.__mobileCapabilityTestEnv; });
  sqlite.exec(`CREATE TABLE mobile_sessions (
    id TEXT PRIMARY KEY, authorization_grant_id TEXT, operator_email TEXT,
    client_id TEXT, device_name TEXT, scopes TEXT, refresh_token_hash TEXT,
    expires_at TEXT, revoked_at TEXT);
  `);
  sqlite.prepare("INSERT INTO mobile_sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)")
    .run(SESSION, "fixture-grant", "operator@example.com", MOBILE_CLIENT_ID, "Fixture device", MOBILE_SCOPE_VALUE,
      "fixture-only-refresh-hash", new Date(Date.now() + 3_600_000).toISOString());
  let databaseReads = 0;
  const db = { prepare(sql) {
    assert.match(sql, /^SELECT /u, "capability probe must never write to D1");
    let values = [];
    return { bind(...args) { values = args; return this; }, async first() { databaseReads++; return sqlite.prepare(sql).get(...values) ?? null; } };
  } };
  const environment = { DB: db, CRM_ADMIN_EMAILS: "operator@example.com",
    CRM_MOBILE_TOKEN_SIGNING_KEY: SIGNING_SECRET, CRM_PUBLIC_ORIGIN: ORIGIN };
  globalThis.__mobileCapabilityTestEnv = environment;
  const request = (headers = {}) => new Request(`${ORIGIN}/api/mobile/capabilities`, { headers });

  for (const headers of [{}, { "oai-authenticated-user-email": "operator@example.com" }, { authorization: "Bearer invalid" }]) {
    assert.equal((await GET(request(headers))).status, 401);
  }
  assert.equal(databaseReads, 0);
  const issued = await createMobileAccessToken(SIGNING_SECRET, { issuer: ORIGIN, operatorEmail: "operator@example.com", sessionId: SESSION });
  const headers = { authorization: `Bearer ${issued.token}` };
  const response = await GET(request(headers));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { attachments: false });
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("vary"), "Authorization");
  assert.equal(databaseReads, 1);

  Object.assign(environment, { ATTACHMENTS_ENABLED: "1", MOBILE_ATTACHMENTS_RUNTIME: "cloudflare-r2", MOBILE_ATTACHMENTS_SCAN_POLICY: "sha256-bound-r2-v1" });
  assert.deepEqual(await (await GET(request(headers))).json(), { attachments: false }, "flags alone cannot enable missing scanner/routes");
  sqlite.prepare("UPDATE mobile_sessions SET revoked_at = ? WHERE id = ?").run(new Date().toISOString(), SESSION);
  assert.equal((await GET(request(headers))).status, 401);
  sqlite.prepare("UPDATE mobile_sessions SET revoked_at = NULL WHERE id = ?").run(SESSION);
  environment.CRM_ADMIN_EMAILS = "different@example.com";
  assert.equal((await GET(request(headers))).status, 401);
});
