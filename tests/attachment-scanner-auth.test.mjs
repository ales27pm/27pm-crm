import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createScannerAuthorization, verifyScannerRequest } from "../lib/attachment-scanner-auth.ts";

// Public, synthetic protocol key; never used by an installed runtime.
const credentials = { keyId: "fixture", scannerId: "test-scanner", signingKey: "x".repeat(43) };
const now = new Date("2026-10-16T16:00:00Z");
const url = "https://crm.27pm.org/api/internal/attachment-scanner/claim";
const bytes = new TextEncoder().encode("{}");

function database(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("CREATE TABLE attachment_scanner_request_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL)");
  return { prepare(sql) { let values = []; return { bind(...v) { values = v; return this; },
    async run() { const r = sqlite.prepare(sql).run(...values); return { success: true, meta: { changes: Number(r.changes) } }; } }; } };
}
async function signed(body = bytes, overrides = {}) {
  const request = new Request(url, { method: "POST", body });
  const authorization = await createScannerAuthorization(credentials, request, body, now, "a".repeat(22));
  return new Request(url, { method: "POST", body, headers: { authorization }, ...overrides });
}

test("machine MAC matches independent canonical vector and consumes its nonce once", async t => {
  const db = database(t);
  const req = await signed();
  const parts = req.headers.get("authorization").slice(8).split(":");
  const canonical = JSON.stringify(["sc1", "fixture", "test-scanner", "POST", "/api/internal/attachment-scanner/claim", "", parts[3], parts[4], parts[5]]);
  assert.equal(parts[6], createHmac("sha256", credentials.signingKey).update(canonical).digest("base64url"));
  assert.equal((await verifyScannerRequest(req, credentials, db, now)).scannerId, "test-scanner");
  await assert.rejects(verifyScannerRequest(await signed(), credentials, db, now), { code: "scanner_request_replayed" });
});
test("MAC binds path, method, query and exact bytes before touching storage", async () => {
  const db = { prepare() { throw new Error("must not touch storage"); } };
  const original = await signed();
  const headers = original.headers;
  for (const request of [
    new Request(url + "/other", { method: "POST", body: bytes, headers }),
    new Request(url + "?extra=yes", { method: "POST", body: bytes, headers }),
    new Request(url, { method: "GET", headers }),
    new Request(url, { method: "POST", body: '{"changed":true}', headers }),
  ]) await assert.rejects(verifyScannerRequest(request, credentials, db, now), e => e.status === 401);
});
test("wrong key/scanner, old/future timestamp and operator/mobile bearers cannot claim", async () => {
  const db = { prepare() { throw new Error("must not touch storage"); } };
  for (const change of [{ keyId: "other" }, { scannerId: "other" }, { signingKey: "z".repeat(43) }]) {
    await assert.rejects(verifyScannerRequest(await signed(), { ...credentials, ...change }, db, now), e => e.status === 401);
  }
  for (const delta of [-31_000, 31_000]) await assert.rejects(
    verifyScannerRequest(await signed(), credentials, db, new Date(now.valueOf() + delta)), e => e.status === 401);
  for (const authorization of ["", "Bearer mobile-test", "Scanner sc1:bad", (await signed()).headers.get("authorization") + ",duplicate"]) {
    await assert.rejects(verifyScannerRequest(new Request(url, { headers: { authorization } }), credentials, db, now), e => e.status === 401);
  }
});
test("bounded body and encodings fail closed; unconfigured auth cannot fall back", async t => {
  const db = database(t);
  await assert.rejects(verifyScannerRequest(await signed(), { ...credentials, signingKey: "" }, db, now), e => e.status === 503);
  const large = new Uint8Array(16 * 1024 + 1);
  await assert.rejects(verifyScannerRequest(await signed(large), credentials, db, now), e => e.status === 413);
  const request = await signed();
  request.headers.set("content-encoding", "gzip");
  await assert.rejects(verifyScannerRequest(request, credentials, db, now), e => e.status === 400);
});
