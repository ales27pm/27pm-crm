import assert from "node:assert/strict";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { createMobileAccessToken, MOBILE_SCOPE_VALUE } from "../lib/mobile-auth.ts";

const ORIGIN = "https://crm.27pm.org";
const NOW = new Date("2026-10-16T20:00:00.000Z");
const CHUNK = 2_097_152;
const MOBILE_KEY = Buffer.alloc(32, 17).toString("base64url");
const SCANNER_KEY = Buffer.alloc(32, 23).toString("base64url");
const EMAIL = "runtime-operator@example.test";
const SCANNER = "/api/internal/attachment-scanner/";
const sha = bytes => createHash("sha256").update(bytes).digest("hex");

// Neutral wrapper: all authentication, nonce consumption, leases, quarantine,
// receipt validation and HTTP dispatch remain inside the production handler.
// Fixture time and credentials are public synthetic values, never live secrets.
const ENTRY = `
import { handleAttachmentV2Request } from './lib/attachment-v2-worker';
export default { async fetch(request, env) {
  return await handleAttachmentV2Request(request, env, () => new Date(env.FIXTURE_NOW))
    ?? new Response(null, {status:404});
}};
`;

async function runtime(t) {
  const bundled = await build({
    stdin: { contents: ENTRY, resolveDir: process.cwd(), sourcefile: "attachment-auth-runtime-entry.ts", loader: "ts" },
    bundle: true, format: "esm", platform: "browser", target: "es2022", write: false,
  });
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "attachment-auth-runtime", modules: true, script: bundled.outputFiles[0].text,
    compatibilityDate: "2026-09-18", d1Databases: ["DB"], r2Buckets: ["BUCKET"], host: "127.0.0.1", port: 0,
    bindings: {
      FIXTURE_NOW: NOW.toISOString(), ATTACHMENTS_V2_ENABLED: "1", CRM_ATTACHMENT_SCANNER_ENABLED: "1",
      CRM_SCANNER_KEY_ID: "runtime-key", CRM_SCANNER_ID: "runtime-scanner", CRM_SCANNER_SIGNING_KEY: SCANNER_KEY,
      CRM_MOBILE_TOKEN_SIGNING_KEY: MOBILE_KEY, CRM_PUBLIC_ORIGIN: ORIGIN, CRM_ADMIN_EMAILS: EMAIL,
    },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB"), bucket = await mf.getR2Bucket("BUCKET");
  // Only owner lookups need these minimal fixture tables. Authentication and
  // attachment schemas below are the unmodified repository migrations.
  for (const query of [
    "CREATE TABLE organizations(id text PRIMARY KEY,deleted_at text)",
    "CREATE TABLE deals(id text PRIMARY KEY)", "CREATE TABLE conversations(id text PRIMARY KEY)",
    "INSERT INTO organizations VALUES ('runtime-owner',NULL)",
  ]) await db.prepare(query).run();
  for (const name of ["0015_chief_wilson_fisk.sql", "0022_attachment_v2_uploads.sql", "0023_attachment_scan_jobs.sql"]) {
    const migration = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint").map(value => value.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }
  }
  const sessionId = randomUUID(), grantId = randomUUID(), expires = new Date(NOW.valueOf() + 3_600_000).toISOString();
  await db.prepare(`INSERT INTO mobile_authorization_grants
    (id,code_hash,operator_email,client_id,redirect_uri,code_challenge,scopes,expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(
    grantId, "a".repeat(64), EMAIL, "org.27pm.crm.mobile", ORIGIN + "/mobile/oauth/callback",
    "a".repeat(43), MOBILE_SCOPE_VALUE, expires,
  ).run();
  await db.prepare(`INSERT INTO mobile_sessions
    (id,authorization_grant_id,operator_email,client_id,scopes,refresh_token_hash,expires_at,last_refreshed_at)
    VALUES (?,?,?,?,?,?,?,?)`).bind(
    sessionId, grantId, EMAIL, "org.27pm.crm.mobile", MOBILE_SCOPE_VALUE, "b".repeat(64), expires, NOW.toISOString(),
  ).run();
  const token = (await createMobileAccessToken(MOBILE_KEY, { issuer: ORIGIN, operatorEmail: EMAIL, sessionId }, NOW)).token;
  function mobile(path, options = {}) {
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers };
    // dispatchFetch otherwise serializes a body as Transfer-Encoding: chunked,
    // which the real handler rejects. Known Data bodies, like URLSession/BFF
    // uploads, declare their exact size; the wrapper never strips this guard.
    if (options.body !== undefined) headers["content-length"] = String(Buffer.byteLength(options.body));
    else if (["POST", "PUT"].includes(options.method)) headers["content-length"] = "0";
    return mf.dispatchFetch(ORIGIN + path, {
      ...options, headers,
    });
  }
  // Independent Node signer, not the verifier/helper used by the Worker.
  function signed(path, value) {
    const body = JSON.stringify(value), timestamp = String(Math.floor(NOW.valueOf() / 1_000));
    const nonce = randomBytes(16).toString("base64url"), digest = sha(body);
    const canonical = JSON.stringify(["sc1", "runtime-key", "runtime-scanner", "POST", path, "", timestamp, nonce, digest]);
    const mac = createHmac("sha256", SCANNER_KEY).update(canonical).digest("base64url");
    return { path, init: { method: "POST", body, headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)),
      authorization: `Scanner sc1:runtime-key:runtime-scanner:${timestamp}:${nonce}:${digest}:${mac}` } } };
  }
  const dispatchSigned = value => mf.dispatchFetch(ORIGIN + value.path, value.init);
  const machine = (path, value) => dispatchSigned(signed(path, value));
  return { mf, db, bucket, mobile, signed, dispatchSigned, machine, sessionId };
}

async function expectStatus(response, expected) {
  assert.equal(response.status, expected, await response.clone().text());
  return response;
}

test("real workerd mobile token, MAC nonce, D1/R2 quarantine and synthetic scan receipt cooperate end-to-end", { timeout: 60_000 }, async t => {
  const f = await runtime(t);
  const bytes = Buffer.alloc(CHUNK + 17, 0x61);
  const input = {
    ownerKind: "account", ownerId: "runtime-owner", fileName: "runtime.bin", contentType: "application/octet-stream",
    byteSize: bytes.length, sha256: sha(bytes),
    chunks: [bytes.subarray(0, CHUNK), bytes.subarray(CHUNK)].map(part => ({ byteSize: part.length, sha256: sha(part) })),
  };
  const create = () => f.mobile("/api/mobile/attachment-uploads", { method: "POST", body: JSON.stringify(input),
    headers: { "idempotency-key": "runtime-auth-resume-key" } });
  const created = await (await expectStatus(await create(), 201)).json();
  assert.equal(created.chunkCount, 2);
  assert.deepEqual(created.receivedChunks, []);
  assert.equal((await (await create()).json()).id, created.id, "stable key recovers the existing authenticated upload");
  const uploadRoot = `/api/mobile/attachment-uploads/${created.id}`;
  const oversized = await f.mobile(`${uploadRoot}/chunks/0`, { method: "PUT", body: Buffer.alloc(CHUNK + 1),
    headers: { "content-type": "application/octet-stream" } });
  await expectStatus(oversized, 413);
  assert.equal(await f.bucket.head(`attachments-v2/staging/${created.id}/0`), null);
  for (let index = 0; index < 2; index += 1) {
    const stored = await f.mobile(`${uploadRoot}/chunks/${index}`, { method: "PUT",
      body: bytes.subarray(index * CHUNK, (index + 1) * CHUNK), headers: { "content-type": "application/octet-stream" } });
    const status = await (await expectStatus(stored, 200)).json();
    assert.deepEqual(status.receivedChunks, Array.from({ length: index + 1 }, (_, i) => i));
  }
  const completed = await (await expectStatus(await f.mobile(uploadRoot + "/complete", { method: "POST" }), 200)).json();
  assert.equal(completed.state, "committed");
  const attachmentId = completed.attachmentId, manifestPath = `/api/mobile/attachments/${attachmentId}/manifest`;
  await expectStatus(await f.mobile(manifestPath), 423);
  const heartbeat = { engineVersion: "1.4.6", signatureVersion: "28155", signatureUpdatedAt: NOW.toISOString() };
  const signedHeartbeat = f.signed(SCANNER + "heartbeat", heartbeat);
  await expectStatus(await f.dispatchSigned(signedHeartbeat), 200);
  await expectStatus(await f.dispatchSigned(signedHeartbeat), 401);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM attachment_scanner_request_nonces").first()).n, 1);
  await expectStatus(await f.mobile(SCANNER + "claim", { method: "POST", body: "{}" }), 401);
  const capabilities = await (await f.mobile("/api/mobile/capabilities", {
    headers: { "x-27pm-attachment-transport": "chunked-v2" },
  })).json();
  assert.deepEqual(capabilities, { attachments: true, transport: "chunked-v2", maxFileBytes: 20_971_520, chunkBytes: CHUNK });
  assert.equal((await (await f.mobile("/api/mobile/capabilities")).json()).attachments, false);

  const lease = await (await expectStatus(await f.machine(SCANNER + "claim", {}), 200)).json();
  assert.equal(lease.chunkCount, 2);
  assert.equal(lease.sha256, input.sha256);
  assert.doesNotMatch(JSON.stringify(lease), /storageKey|storage_key|scan-receipts|attachments-v2\/objects/);
  const jobRoot = `${SCANNER}jobs/${lease.jobId}`, scannerHash = createHash("sha256");
  for (let index = 0; index < 2; index += 1) {
    const chunk = await expectStatus(await f.machine(`${jobRoot}/chunks/${index}`, lease), 200);
    assert.equal(chunk.headers.get("x-attachment-object-version"), lease.objectVersion);
    scannerHash.update(Buffer.from(await chunk.arrayBuffer()));
  }
  assert.equal(scannerHash.digest("hex"), input.sha256);
  await expectStatus(await f.mobile(manifestPath), 423, "machine byte access is not a clean verdict");

  // Deliberately synthetic verdict: this tests authenticated publication and
  // immutable receipts, NOT ClamAV detection or production scanner readiness.
  const verdict = { protocol: "crm-clamav-v1", status: "clean", sha256: input.sha256,
    byteSize: bytes.length, ...heartbeat, scannedAt: NOW.toISOString() };
  await expectStatus(await f.machine(jobRoot + "/complete", { ...lease, verdict: { ...verdict, sha256: "0".repeat(64) } }), 409);
  const published = await (await expectStatus(await f.machine(jobRoot + "/complete", { ...lease, verdict }), 200)).json();
  assert.equal(published.status, "completed");
  assert.equal((await (await f.machine(jobRoot + "/complete", { ...lease, verdict })).json()).status, "duplicate");
  const job = await f.db.prepare("SELECT state,receipt_key,result_digest,result_status FROM attachment_scan_jobs WHERE id=?").bind(lease.jobId).first();
  assert.equal(job.state, "completed");
  assert.equal(job.result_status, "clean");
  const receipt = await f.bucket.get(job.receipt_key), receiptBytes = Buffer.from(await receipt.arrayBuffer());
  assert.equal(sha(receiptBytes), job.result_digest);
  assert.equal(Buffer.from(receipt.checksums.sha256).toString("hex"), job.result_digest);
  assert.equal(JSON.parse(receiptBytes.toString("utf8")).objectVersion, lease.objectVersion);

  const manifest = await (await expectStatus(await f.mobile(manifestPath), 200)).json();
  assert.equal(manifest.sha256, input.sha256);
  assert.equal(manifest.byteSize, bytes.length);
  const downloaded = createHash("sha256");
  for (let index = 0; index < manifest.chunkCount; index += 1) {
    const response = await expectStatus(await f.mobile(`/api/mobile/attachments/${attachmentId}/chunks/${index}?version=${encodeURIComponent(manifest.objectVersion)}`), 200);
    assert.equal(response.headers.get("x-attachment-object-version"), manifest.objectVersion);
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    downloaded.update(Buffer.from(await response.arrayBuffer()));
  }
  assert.equal(downloaded.digest("hex"), input.sha256);
  await expectStatus(await f.mobile(`/api/mobile/attachments/${attachmentId}/chunks/0?version=stale-version`), 409);
  await f.bucket.put(job.receipt_key, "{corrupt", { sha256: sha("{corrupt") });
  await expectStatus(await f.mobile(manifestPath), 423, "corrupt private R2 receipt revokes clean access");
  await f.db.prepare("UPDATE mobile_sessions SET revoked_at=? WHERE id=?").bind(NOW.toISOString(), f.sessionId).run();
  await expectStatus(await f.mobile(manifestPath), 401);
});

test("real workerd authentication rejects spoofed identity and altered MAC body before durable writes", { timeout: 60_000 }, async t => {
  const f = await runtime(t), path = "/api/mobile/attachments?ownerKind=account&ownerId=runtime-owner";
  for (const headers of [
    { "oai-authenticated-user-email": EMAIL, cookie: "session=synthetic-fixture" },
    { authorization: "Bearer malformed-synthetic-token" },
    { authorization: "Scanner sc1:malformed-synthetic-token" },
  ]) await expectStatus(await f.mf.dispatchFetch(ORIGIN + path, { headers }), 401);
  const heartbeat = f.signed(SCANNER + "heartbeat", { engineVersion: "1.4.6", signatureVersion: "28155", signatureUpdatedAt: NOW.toISOString() });
  await expectStatus(await f.mf.dispatchFetch(ORIGIN + heartbeat.path, {
    ...heartbeat.init, body: "{}", headers: { ...heartbeat.init.headers, "content-length": "2" },
  }), 401);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM attachment_scanner_request_nonces").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM attachment_scanner_heartbeats").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT COUNT(*) AS n FROM attachment_v2_objects").first()).n, 0);
  assert.equal((await f.bucket.list()).objects.length, 0);
});
