import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { register } from "node:module";
import test from "node:test";

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, url: "data:text/javascript,export {};" };
      }
      if (specifier === "cloudflare:workers") {
        return {
          shortCircuit: true,
          url: "data:text/javascript,export const env = new Proxy({}, { get: (_, key) => globalThis.__nativeAttachmentRouteEnv?.[key] ?? process.env[key] });",
        };
      }
      return nextResolve(specifier, context);
    }
  `)}`,
  import.meta.url,
);

const { POST } = await import("../app/api/mobile/attachments/route.ts");
const { createMobileAccessToken, MOBILE_CLIENT_ID, MOBILE_SCOPE_VALUE, verifyMobileAccessToken } = await import(
  "../lib/mobile-auth.ts"
);
const { nativeGateway } = await import("../worker/native-gateway.ts");
const { fixture } = await import("./helpers/mobile-attachment-fixture.mjs");

const ORIGIN = "https://crm.27pm.org";
const SESSION_ID = "7793cc19-fd7c-48be-857c-f6aa361e8178";
const SIGNING_SECRET = Buffer.alloc(32, 27).toString("base64url");
const MANAGED_ENV = [
  "ATTACHMENTS_ENABLED",
  "CRM_ADMIN_EMAILS",
  "CRM_ANTIMALWARE_TOKEN",
  "CRM_MOBILE_TOKEN_SIGNING_KEY",
  "CRM_PUBLIC_ORIGIN",
  "MOBILE_ATTACHMENTS_RUNTIME",
  "MOBILE_ATTACHMENTS_SCAN_POLICY",
  "VERCEL",
];

function signedMobileAccessToken(scopes, sessionId = SESSION_ID) {
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    v: 1,
    iss: ORIGIN,
    aud: "27pm-crm-mobile",
    sub: "alexis@27pm.org",
    sid: sessionId,
    scp: scopes,
    iat: now,
    nbf: now - 5,
    exp: now + 15 * 60,
    jti: crypto.randomUUID(),
  })).toString("base64url");
  const signingInput = `ma1.${payload}`;
  const signature = createHmac("sha256", Buffer.from(SIGNING_SECRET, "base64url"))
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}

function uploadForm() {
  const form = new FormData();
  form.set("ownerKind", "account");
  form.set("ownerId", "org-test");
  form.set("file", new File(["gateway multipart body"], "route-proof.txt", { type: "text/plain" }));
  return form;
}

test("gateway bearer validation reaches the actual POST route with an intact multipart upload", async (t) => {
  const previous = Object.fromEntries(MANAGED_ENV.map(name => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    delete globalThis.__nativeAttachmentRouteEnv;
  });

  Object.assign(process.env, {
    ATTACHMENTS_ENABLED: "1",
    CRM_ADMIN_EMAILS: "alexis@27pm.org",
    CRM_ANTIMALWARE_TOKEN: "a".repeat(43),
    CRM_MOBILE_TOKEN_SIGNING_KEY: SIGNING_SECRET,
    CRM_PUBLIC_ORIGIN: ORIGIN,
    MOBILE_ATTACHMENTS_RUNTIME: "cloudflare-r2",
    MOBILE_ATTACHMENTS_SCAN_POLICY: "sha256-bound-r2-v1",
  });
  delete process.env.VERCEL;

  const { sqlite, db, bucket, objects } = await fixture();
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE mobile_sessions (
    id TEXT PRIMARY KEY NOT NULL,
    authorization_grant_id TEXT NOT NULL UNIQUE,
    operator_email TEXT NOT NULL,
    client_id TEXT NOT NULL,
    device_name TEXT,
    scopes TEXT NOT NULL,
    refresh_token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    last_refreshed_at TEXT NOT NULL,
    revoked_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  sqlite.prepare(`INSERT INTO mobile_sessions
    (id, authorization_grant_id, operator_email, client_id, device_name, scopes,
      refresh_token_hash, expires_at, last_refreshed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      SESSION_ID,
      "grant-native-route-test",
      "alexis@27pm.org",
      MOBILE_CLIENT_ID,
      "iPhone route test",
      MOBILE_SCOPE_VALUE,
      "refresh-hash-native-route-test",
      new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      new Date().toISOString(),
    );
  globalThis.__nativeAttachmentRouteEnv = {
    DB: db,
    BUCKET: bucket,
    ANTIMALWARE: {
      async fetch() {
        return Response.json({ error: "scanner_test_outage" }, { status: 503 });
      },
    },
  };

  const backend = {
    fetch(request) {
      return POST(request);
    },
  };
  const gatewayEnv = { NATIVE_GATEWAY_ENABLED: "1", CRM_BACKEND: backend };

  const rejected = await nativeGateway(new Request(`${ORIGIN}/api/mobile/attachments`, {
    method: "POST",
    headers: {
      authorization: "Bearer device.token",
      "content-type": "multipart/form-data; boundary=invalid",
    },
    body: "--invalid--",
  }), gatewayEnv);
  assert.equal(rejected.status, 401);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM mobile_attachments").get().total, 0);

  const readOnlyToken = signedMobileAccessToken("crm:dashboard:read");
  assert.equal((await verifyMobileAccessToken(SIGNING_SECRET, readOnlyToken, ORIGIN))?.scopes, "crm:dashboard:read");
  const forbidden = await nativeGateway(new Request(`${ORIGIN}/api/mobile/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${readOnlyToken}` },
    body: uploadForm(),
  }), gatewayEnv);
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: "mobile_scope_forbidden" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM mobile_attachments").get().total, 0);

  const unknownSessionToken = signedMobileAccessToken(
    "crm:dashboard:read",
    "a7e83f2a-69ca-4ff5-9096-b117ac77c020",
  );
  const unknownSession = await nativeGateway(new Request(`${ORIGIN}/api/mobile/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${unknownSessionToken}` },
    body: uploadForm(),
  }), gatewayEnv);
  assert.equal(unknownSession.status, 401);
  assert.deepEqual(await unknownSession.json(), { error: "authentication_required" });

  sqlite.prepare("UPDATE mobile_sessions SET revoked_at = ? WHERE id = ?")
    .run(new Date().toISOString(), SESSION_ID);
  const revokedSession = await nativeGateway(new Request(`${ORIGIN}/api/mobile/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${readOnlyToken}` },
    body: uploadForm(),
  }), gatewayEnv);
  assert.equal(revokedSession.status, 401);
  assert.deepEqual(await revokedSession.json(), { error: "authentication_required" });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM mobile_attachments").get().total, 0);
  assert.equal(objects.size, 0);
  sqlite.prepare("UPDATE mobile_sessions SET revoked_at = NULL WHERE id = ?").run(SESSION_ID);

  for (const scopes of [
    "crm:work crm:dashboard:read",
    "crm:dashboard:read crm:dashboard:read",
    "crm:dashboard:read crm:work crm:work",
    "crm:admin",
    "",
  ]) {
    assert.equal(await verifyMobileAccessToken(SIGNING_SECRET, signedMobileAccessToken(scopes), ORIGIN), null);
  }

  const { token } = await createMobileAccessToken(SIGNING_SECRET, {
    issuer: ORIGIN,
    operatorEmail: "alexis@27pm.org",
    sessionId: SESSION_ID,
  });
  const response = await nativeGateway(new Request(`${ORIGIN}/api/mobile/attachments`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
    },
    body: uploadForm(),
  }), gatewayEnv);

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.match(payload.id, /^[0-9a-f-]{36}$/u);
  const row = sqlite.prepare("SELECT * FROM mobile_attachments WHERE id = ?").get(payload.id);
  assert.equal(row.owner_kind, "account");
  assert.equal(row.owner_id, "org-test");
  assert.equal(row.file_name, "route-proof.txt");
  assert.equal(row.byte_size, 22);
  assert.equal(row.created_by, SESSION_ID);
  assert.equal(objects.size, 1);
  assert.equal(Buffer.from(objects.get(row.storage_key).bytes).toString(), "gateway multipart body");
});
