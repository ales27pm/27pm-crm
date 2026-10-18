import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { handleAttachmentV2Request } from "../lib/attachment-v2-worker.ts";
import { createScannerAuthorization } from "../lib/attachment-scanner-auth.ts";
import { createMobileAccessToken, MOBILE_SCOPE_VALUE } from "../lib/mobile-auth.ts";

const ORIGIN = "https://crm.27pm.org";
const MOBILE_SECRET = Buffer.alloc(32, 17).toString("base64url");
const credentials = { keyId: "fixture-key", scannerId: "fixture-scanner", signingKey: "q".repeat(43) };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("narrow dispatcher does not claim unrelated routes and default flags leave storage untouched", async () => {
  const env = { DB: { prepare() { throw new Error("storage must not be read"); } }, BUCKET: {} };
  assert.equal(await handleAttachmentV2Request(new Request(ORIGIN + "/api/dashboard"), env), null);
  assert.equal((await handleAttachmentV2Request(new Request(ORIGIN + "/api/mobile/attachment-uploads", { method: "POST" }), env)).status, 503);
  assert.equal((await handleAttachmentV2Request(new Request(ORIGIN + "/api/internal/attachment-scanner/claim", { method: "POST" }), env)).status, 503);
});

test("forwarded identity, cookies, malformed token and machine credentials cannot impersonate a mobile operator", async t => {
  const f = await fixture(t);
  for (const headers of [
    { "oai-authenticated-user-email": f.email },
    { cookie: "session=fixture" },
    { authorization: "Bearer bad" },
    { authorization: "Scanner sc1:fixture" },
  ]) {
    const response = await handleAttachmentV2Request(new Request(ORIGIN + "/api/mobile/attachments?ownerKind=account&ownerId=owner", { headers }), f.env, f.now);
    assert.equal(response.status, 401);
  }
  assert.equal(f.io.gets, 0);
  assert.equal(f.io.puts, 0);
});

test("real mobile token still requires a live allowlisted session and exact browser-origin semantics", async t => {
  const f = await fixture(t);
  const target = "/api/mobile/attachment-uploads";
  let response = await f.mobile(target, { method: "POST", headers: { origin: "https://evil.example" }, body: "{}" });
  assert.equal(response.status, 403);
  response = await f.mobile(target, { method: "POST", headers: { "sec-fetch-site": "cross-site" }, body: "{}" });
  assert.equal(response.status, 403);
  f.env.CRM_ADMIN_EMAILS = "another@example.test";
  assert.equal((await f.mobile(target, { method: "POST", body: "{}" })).status, 401);
  f.env.CRM_ADMIN_EMAILS = f.email;
  f.sqlite.prepare("UPDATE mobile_sessions SET revoked_at=?").run(f.now.toISOString());
  assert.equal((await f.mobile(target, { method: "POST", body: "{}" })).status, 401);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM attachment_v2_uploads").get().n, 0);
  assert.equal(f.io.puts, 0);
});

test("collection metadata is not released after session revocation or owner deletion during the database read", async t => {
  for (const reason of ["session", "owner", "allowlist"]) {
    const f = await fixture(t), { attachmentId } = await f.upload();
    const path = "/api/mobile/attachments?ownerKind=account&ownerId=owner";
    const baseline = await f.mobile(path);
    assert.equal(baseline.status, 200);
    const visible = (await baseline.json()).attachments;
    assert.equal(visible.length, 1);
    assert.equal(visible[0].id, attachmentId);
    assert.doesNotMatch(JSON.stringify(visible), /storageKey|storage_key|receipt|scanner/);
    const prepare = f.db.prepare;
    let changed = false;
    f.db.prepare = function (query) {
      const statement = prepare.call(this, query);
      if (!query.startsWith("SELECT * FROM attachment_v2_objects WHERE owner_kind = ?")) return statement;
      const all = statement.all;
      statement.all = async function (...args) {
        const result = await all.apply(this, args);
        changed = true;
        if (reason === "session") f.sqlite.prepare("UPDATE mobile_sessions SET revoked_at=?").run(f.now.toISOString());
        if (reason === "owner") f.sqlite.prepare("UPDATE organizations SET deleted_at=?").run(f.now.toISOString());
        if (reason === "allowlist") f.env.CRM_ADMIN_EMAILS = "another@example.test";
        return result;
      };
      return statement;
    };
    const response = await f.mobile(path);
    assert.equal(changed, true, "revocation occurs after the real list query has fetched its rows");
    assert.equal(response.status, reason === "owner" ? 404 : 401);
    const denied = await response.json();
    assert.equal(Object.hasOwn(denied, "attachments"), false);
    assert.equal(JSON.stringify(denied).includes(attachmentId), false);
  }
});

test("signed machine body/path/nonce cannot be replayed or replaced and mobile bearer cannot claim", async t => {
  const f = await fixture(t);
  const path = "/api/internal/attachment-scanner/heartbeat";
  const signed = await f.signedRequest(path, f.heartbeat);
  assert.equal((await handleAttachmentV2Request(signed.clone(), f.env, f.now)).status, 200);
  assert.equal((await handleAttachmentV2Request(signed.clone(), f.env, f.now)).status, 401);
  const changed = new Request(signed.url, { method: "POST", headers: signed.headers, body: "{}" });
  assert.equal((await handleAttachmentV2Request(changed, f.env, f.now)).status, 401);
  assert.equal((await f.mobile("/api/internal/attachment-scanner/claim", { method: "POST", body: "{}" })).status, 401);
  assert.equal((await f.machine("/api/internal/attachment-scanner/claim?unexpected=1", {})).status, 405);
  assert.equal(f.io.gets, 0);
});

test("real token→resumable upload→quarantine→machine scan report→versioned download keeps trust boundaries", async t => {
  const f = await fixture(t);
  const { attachmentId, bytes } = await f.upload();
  const manifestPath = `/api/mobile/attachments/${attachmentId}/manifest`;
  assert.equal((await f.mobile(manifestPath)).status, 423, "stored bytes are not yet downloadable");
  assert.equal((await f.machine("/api/internal/attachment-scanner/heartbeat", f.heartbeat)).status, 200);
  const claimedResponse = await f.machine("/api/internal/attachment-scanner/claim", {});
  assert.equal(claimedResponse.status, 200);
  const lease = await claimedResponse.json();
  assert.doesNotMatch(JSON.stringify(lease), /storageKey|storage_key|attachments-v2\/objects|fileName/);
  const root = `/api/internal/attachment-scanner/jobs/${lease.jobId}`;
  const raw = await f.machine(root + "/chunks/0", lease);
  assert.equal(raw.status, 200, "quarantine bytes are readable only by their leased scanner");
  assert.equal(hash(new Uint8Array(await raw.arrayBuffer())), hash(bytes));
  assert.equal((await f.mobile(manifestPath)).status, 423, "a machine read is not a clean verdict");
  const verdict = { protocol: "crm-clamav-v1", status: "clean", sha256: hash(bytes), byteSize: bytes.length,
    ...f.heartbeat, scannedAt: f.now.toISOString() };
  const completed = await f.machine(root + "/complete", { ...lease, verdict });
  assert.equal(completed.status, 200);
  assert.equal((await completed.json()).status, "completed");
  const retry = await f.machine(root + "/complete", { ...lease, verdict });
  assert.equal((await retry.json()).status, "duplicate");
  const manifestResponse = await f.mobile(manifestPath);
  assert.equal(manifestResponse.status, 200);
  const manifest = await manifestResponse.json();
  assert.equal(manifest.sha256, hash(bytes));
  const downloaded = await f.mobile(`/api/mobile/attachments/${attachmentId}/chunks/0?version=${encodeURIComponent(manifest.objectVersion)}`);
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get("cache-control"), "private, no-store");
  assert.equal(hash(new Uint8Array(await downloaded.arrayBuffer())), hash(bytes));
  assert.equal((await f.mobile(`/api/mobile/attachments/${attachmentId}/chunks/0?version=old-version`)).status, 409);
  assert.equal((await f.mobile(`/api/mobile/attachments/${attachmentId}/chunks/0?version=${manifest.objectVersion}`, { headers: { range: "bytes=0-1" } })).status, 400);
  assert.equal((await f.mobile(`/api/mobile/attachments/${attachmentId}/file`)).status, 503);
});

test("terminal archive policy refusal cannot release a file and owner removal revokes scanner reads", async t => {
  const f = await fixture(t), { attachmentId } = await f.upload();
  await f.machine("/api/internal/attachment-scanner/heartbeat", f.heartbeat);
  const lease = await (await f.machine("/api/internal/attachment-scanner/claim", {})).json();
  const root = `/api/internal/attachment-scanner/jobs/${lease.jobId}`;
  assert.equal((await f.machine(root + "/chunks/0", { ...lease, scannerId: "wrong-scanner" })).status, 403);
  assert.equal((await f.machine(root + "/fail", { ...lease, code: "archive_policy_blocked" })).status, 200);
  assert.equal((await f.machine(root + "/claim", {})).status, 404);
  assert.equal((await f.machine("/api/internal/attachment-scanner/claim", {})).status, 204);
  const blocked = await f.mobile(`/api/mobile/attachments/${attachmentId}/manifest`);
  assert.equal(blocked.status, 423);
  assert.deepEqual(await blocked.json(), { error: "attachment_blocked" });
  assert.equal(blocked.headers.has("retry-after"), false, "a definitive refusal must not instruct another polling attempt");
  f.sqlite.prepare("UPDATE organizations SET deleted_at=? WHERE id='owner'").run(f.now.toISOString());
  assert.equal((await f.machine(root + "/chunks/0", lease)).status, 409);
  assert.equal((await f.mobile(`/api/mobile/attachments/${attachmentId}/manifest`)).status, 404);
});

test("infected receipts expose only a terminal refusal while pending jobs remain retryable", async t => {
  const f = await fixture(t), { attachmentId, bytes } = await f.upload();
  const path = `/api/mobile/attachments/${attachmentId}`;
  const pending = await f.mobile(path + "/manifest");
  assert.equal(pending.status, 423);
  assert.deepEqual(await pending.json(), { error: "attachment_quarantined" });
  assert.equal(pending.headers.get("retry-after"), "30");
  await f.machine("/api/internal/attachment-scanner/heartbeat", f.heartbeat);
  const lease = await (await f.machine("/api/internal/attachment-scanner/claim", {})).json();
  const verdict = { protocol: "crm-clamav-v1", status: "infected", sha256: hash(bytes), byteSize: bytes.length,
    ...f.heartbeat, scannedAt: f.now.toISOString(), diagnostics: "private scanner finding" };
  assert.equal((await f.machine(`/api/internal/attachment-scanner/jobs/${lease.jobId}/complete`, { ...lease, verdict })).status, 200);
  for (const suffix of ["/manifest", "/chunks/0?version=fixture-version"]) {
    const blocked = await f.mobile(path + suffix);
    assert.equal(blocked.status, 423);
    assert.deepEqual(await blocked.json(), { error: "attachment_blocked" });
    assert.equal(blocked.headers.has("retry-after"), false);
  }
});

test("terminal refusal rechecks the mobile session and owner after R2 metadata I/O", async t => {
  for (const reason of ["session", "owner"]) {
    const f = await fixture(t), { attachmentId } = await f.upload();
    await f.machine("/api/internal/attachment-scanner/heartbeat", f.heartbeat);
    const lease = await (await f.machine("/api/internal/attachment-scanner/claim", {})).json();
    assert.equal((await f.machine(`/api/internal/attachment-scanner/jobs/${lease.jobId}/fail`,
      { ...lease, code: "archive_policy_blocked" })).status, 200);
    const head = f.env.BUCKET.head;
    let changed = false;
    f.env.BUCKET.head = async (...args) => {
      const metadata = await head(...args);
      changed = true;
      if (reason === "session") f.sqlite.prepare("UPDATE mobile_sessions SET revoked_at=?").run(f.now.toISOString());
      else f.sqlite.prepare("UPDATE organizations SET deleted_at=?").run(f.now.toISOString());
      return metadata;
    };
    const response = await f.mobile(`/api/mobile/attachments/${attachmentId}/manifest`);
    assert.equal(changed, true, "terminal classification must inspect the actual stored object");
    assert.equal(response.status, reason === "session" ? 401 : 404);
  }
});

test("machine timestamp is rechecked after a delayed body before any nonce or job write", async t => {
  const f = await fixture(t), path = "/api/internal/attachment-scanner/heartbeat";
  const signed = await f.signedRequest(path, f.heartbeat);
  const bytes = new TextEncoder().encode(JSON.stringify(f.heartbeat));
  let currentTime = f.now, pulled = false;
  const body = new ReadableStream({ pull(controller) {
    pulled = true;
    currentTime = new Date(f.now.valueOf() + 61_000);
    controller.enqueue(bytes); controller.close();
  } }, { highWaterMark: 0 });
  const delayed = new Request(signed.url, { method: "POST", headers: signed.headers, body, duplex: "half" });
  const response = await handleAttachmentV2Request(delayed, f.env, () => currentTime);
  assert.equal(pulled, true, "the timestamp was initially valid and the controlled body was actually read");
  assert.equal(response.status, 401);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM attachment_scanner_request_nonces").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM attachment_scanner_heartbeats").get().n, 0);
});

test("machine lease that expires during an R2 range read cannot release the buffered bytes", async t => {
  const f = await fixture(t), { attachmentId } = await f.upload();
  await f.machine("/api/internal/attachment-scanner/heartbeat", f.heartbeat);
  const lease = await (await f.machine("/api/internal/attachment-scanner/claim", {})).json();
  let currentTime = f.now, advanced = false;
  const get = f.env.BUCKET.get;
  f.env.BUCKET.get = async (...args) => {
    const original = await get(...args);
    if (args[0] !== `attachments-v2/objects/${attachmentId}` || !args[1]?.range) return original;
    return { ...original, body: new ReadableStream({ async pull(controller) {
      const bytes = new Uint8Array(await new Response(original.body).arrayBuffer());
      advanced = true; currentTime = new Date(f.now.valueOf() + 120_000);
      controller.enqueue(bytes); controller.close();
    } }, { highWaterMark: 0 }) };
  };
  const request = await f.signedRequest(`/api/internal/attachment-scanner/jobs/${lease.jobId}/chunks/0`, lease);
  const response = await handleAttachmentV2Request(request, f.env, () => currentTime);
  assert.equal(advanced, true);
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error, "scanner_lease_expired");
});

test("mobile download rechecks a verdict revoked while its R2 range is being buffered", async t => {
  const f = await fixture(t), { attachmentId, bytes } = await f.upload();
  await f.machine("/api/internal/attachment-scanner/heartbeat", f.heartbeat);
  const lease = await (await f.machine("/api/internal/attachment-scanner/claim", {})).json();
  const verdict = { protocol: "crm-clamav-v1", status: "clean", sha256: hash(bytes), byteSize: bytes.length,
    ...f.heartbeat, scannedAt: f.now.toISOString() };
  assert.equal((await f.machine(`/api/internal/attachment-scanner/jobs/${lease.jobId}/complete`, { ...lease, verdict })).status, 200);
  const manifest = await (await f.mobile(`/api/mobile/attachments/${attachmentId}/manifest`)).json();
  const get = f.env.BUCKET.get;
  let revoked = false;
  f.env.BUCKET.get = async (...args) => {
    const original = await get(...args);
    if (args[0] !== `attachments-v2/objects/${attachmentId}` || !args[1]?.range) return original;
    return { ...original, body: new ReadableStream({ async pull(controller) {
      const bytes = new Uint8Array(await new Response(original.body).arrayBuffer());
      revoked = true;
      f.sqlite.prepare("UPDATE attachment_scan_jobs SET generation=generation+1,state='pending',receipt_key=NULL,result_digest=NULL,result_status=NULL WHERE id=?").run(lease.jobId);
      controller.enqueue(bytes); controller.close();
    } }, { highWaterMark: 0 }) };
  };
  const response = await f.mobile(`/api/mobile/attachments/${attachmentId}/chunks/0?version=${encodeURIComponent(manifest.objectVersion)}`);
  assert.equal(revoked, true);
  assert.equal(response.status, 423);
  assert.equal((await response.json()).error, "attachment_quarantined");
});

test("a device session revoked while its PUT body is read cannot store a chunk", async t => {
  const f = await fixture(t), bytes = new TextEncoder().encode("private fixture");
  const manifest = { ownerKind: "account", ownerId: "owner", fileName: "fixture.txt", contentType: "text/plain",
    byteSize: bytes.length, sha256: hash(bytes), chunks: [{ byteSize: bytes.length, sha256: hash(bytes) }] };
  const created = await f.mobile("/api/mobile/attachment-uploads", { method: "POST", body: JSON.stringify(manifest),
    headers: { "idempotency-key": "revoked-body-key" } });
  assert.equal(created.status, 201);
  const upload = await created.json();
  let revoked = false;
  const body = new ReadableStream({ pull(controller) {
    revoked = true;
    f.sqlite.prepare("UPDATE mobile_sessions SET revoked_at=?").run(f.now.toISOString());
    controller.enqueue(bytes); controller.close();
  } }, { highWaterMark: 0 });
  const response = await f.mobile(`/api/mobile/attachment-uploads/${upload.id}/chunks/0`, {
    method: "PUT", headers: { "content-type": "application/octet-stream" }, body, duplex: "half",
  });
  assert.equal(revoked, true);
  assert.equal(response.status, 401);
  assert.equal(f.io.puts, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) n FROM attachment_v2_chunks").get().n, 0);
});

test("a device session revoked during R2 download cannot receive buffered attachment bytes", async t => {
  const f = await fixture(t), { attachmentId, bytes } = await f.upload();
  await f.machine("/api/internal/attachment-scanner/heartbeat", f.heartbeat);
  const lease = await (await f.machine("/api/internal/attachment-scanner/claim", {})).json();
  const verdict = { protocol: "crm-clamav-v1", status: "clean", sha256: hash(bytes), byteSize: bytes.length,
    ...f.heartbeat, scannedAt: f.now.toISOString() };
  assert.equal((await f.machine(`/api/internal/attachment-scanner/jobs/${lease.jobId}/complete`, { ...lease, verdict })).status, 200);
  const manifest = await (await f.mobile(`/api/mobile/attachments/${attachmentId}/manifest`)).json();
  const get = f.env.BUCKET.get;
  let revoked = false;
  f.env.BUCKET.get = async (...args) => {
    const original = await get(...args);
    if (args[0] !== `attachments-v2/objects/${attachmentId}` || !args[1]?.range) return original;
    return { ...original, body: new ReadableStream({ async pull(controller) {
      const bytes = new Uint8Array(await new Response(original.body).arrayBuffer());
      revoked = true;
      f.sqlite.prepare("UPDATE mobile_sessions SET revoked_at=?").run(f.now.toISOString());
      controller.enqueue(bytes); controller.close();
    } }, { highWaterMark: 0 }) };
  };
  const response = await f.mobile(`/api/mobile/attachments/${attachmentId}/chunks/0?version=${encodeURIComponent(manifest.objectVersion)}`);
  assert.equal(revoked, true);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error, "mobile_session_invalid");
});

async function fixture(t) {
  const now = new Date(), sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec("PRAGMA foreign_keys=ON");
  const dir = new URL("../drizzle/", import.meta.url);
  for (const name of (await readdir(dir)).filter(n => /^\d+.*\.sql$/u.test(n)).sort()) sqlite.exec(await readFile(new URL(name, dir), "utf8"));
  sqlite.prepare("INSERT INTO organizations(id,external_key,name,source_label) VALUES (?,?,?,?)").run("owner", "fixture-owner", "Synthetic owner", "fixture");
  const email = "operator@example.test", sessionId = randomUUID(), grantId = randomUUID();
  const expires = new Date(now.valueOf() + 3600000).toISOString();
  sqlite.prepare(`INSERT INTO mobile_authorization_grants
    (id,code_hash,operator_email,client_id,redirect_uri,code_challenge,scopes,expires_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(grantId, "a".repeat(64), email, "org.27pm.crm.mobile", ORIGIN + "/mobile/oauth/callback", "a".repeat(43), MOBILE_SCOPE_VALUE, expires);
  sqlite.prepare(`INSERT INTO mobile_sessions
    (id,authorization_grant_id,operator_email,client_id,scopes,refresh_token_hash,expires_at,last_refreshed_at)
    VALUES (?,?,?,?,?,?,?,?)`).run(sessionId, grantId, email, "org.27pm.crm.mobile", MOBILE_SCOPE_VALUE, "b".repeat(64), expires, now.toISOString());
  const db = {
    prepare(query) {
      let args = [];
      const execute = () => {
        const statement = sqlite.prepare(query);
        const results = statement.columns().length ? statement.all(...args) : undefined;
        const changes = results ? sqlite.prepare("SELECT changes() n").get().n : statement.run(...args).changes;
        return { success: true, results, meta: { changes: Number(changes) } };
      };
      return {
        bind(...values) { args = values; return this; },
        async first() { return sqlite.prepare(query).get(...args) ?? null; },
        async all() { return { success: true, results: sqlite.prepare(query).all(...args) }; },
        async run() { return execute(); },
        execute,
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map(statement => statement.execute());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const objects = new Map(), io = { gets: 0, puts: 0 };
  function meta(key) { const o = objects.get(key); return o ? { key, version: o.version, etag: o.version,
    size: o.bytes.length, checksums: { sha256: Uint8Array.from(Buffer.from(hash(o.bytes), "hex")).buffer } } : null; }
  const bucket = {
    async head(key) { return meta(key); },
    async get(key, options) {
      io.gets++;
      const o = objects.get(key); if (!o) return null;
      if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== o.version) return meta(key);
      const bytes = options?.range ? o.bytes.subarray(options.range.offset, options.range.offset + options.range.length) : o.bytes;
      return { ...meta(key), body: new Response(bytes).body };
    },
    async put(key, input, options) {
      io.puts++;
      if (options?.onlyIf?.etagDoesNotMatch === "*" && objects.has(key)) return null;
      const bytes = input instanceof ReadableStream ? new Uint8Array(await new Response(input).arrayBuffer())
        : input instanceof Uint8Array ? input.slice() : new Uint8Array(input);
      const expected = typeof options?.sha256 === "string" ? options.sha256 : options?.sha256 ? Buffer.from(options.sha256).toString("hex") : null;
      assert.ok(!expected || hash(bytes) === expected, "synthetic R2 independently checks the requested checksum");
      objects.set(key, { bytes, version: randomUUID() });
      return meta(key);
    },
  };
  const token = (await createMobileAccessToken(MOBILE_SECRET, { issuer: ORIGIN, operatorEmail: email, sessionId }, now)).token;
  const env = { DB: db, BUCKET: bucket, ATTACHMENTS_V2_ENABLED: "1", CRM_ATTACHMENT_SCANNER_ENABLED: "1",
    CRM_SCANNER_KEY_ID: credentials.keyId, CRM_SCANNER_ID: credentials.scannerId, CRM_SCANNER_SIGNING_KEY: credentials.signingKey,
    CRM_MOBILE_TOKEN_SIGNING_KEY: MOBILE_SECRET, CRM_PUBLIC_ORIGIN: ORIGIN, CRM_ADMIN_EMAILS: email };
  const f = { env, db, sqlite, objects, io, email, now,
    heartbeat: { engineVersion: "1.4.6", signatureVersion: "28155", signatureUpdatedAt: now.toISOString() },
    mobile(path, options = {}) {
      return handleAttachmentV2Request(new Request(ORIGIN + path, { ...options, headers: {
        authorization: `Bearer ${token}`, "content-type": "application/json", ...options.headers } }), env, () => now);
    },
    async signedRequest(path, value) {
      const body = new TextEncoder().encode(JSON.stringify(value));
      const request = new Request(ORIGIN + path, { method: "POST", body, headers: { "content-type": "application/json" } });
      request.headers.set("authorization", await createScannerAuthorization(credentials, request, body, now));
      return request;
    },
    async machine(path, value) { return handleAttachmentV2Request(await this.signedRequest(path, value), env, () => now); },
    async upload() {
      const bytes = new TextEncoder().encode("This synthetic fixture contains no customer information.");
      const manifest = { ownerKind: "account", ownerId: "owner", fileName: "fixture.txt", contentType: "text/plain",
        byteSize: bytes.length, sha256: hash(bytes), chunks: [{ byteSize: bytes.length, sha256: hash(bytes) }] };
      const created = await this.mobile("/api/mobile/attachment-uploads", { method: "POST", body: JSON.stringify(manifest), headers: { "idempotency-key": "fixture-upload-key" } });
      assert.equal(created.status, 201);
      const status = await created.json();
      assert.equal((await this.mobile(`/api/mobile/attachment-uploads/${status.id}/chunks/0`, {
        method: "PUT", body: bytes, headers: { "content-type": "application/octet-stream" },
      })).status, 200);
      const completed = await this.mobile(`/api/mobile/attachment-uploads/${status.id}/complete`, { method: "POST" });
      assert.equal(completed.status, 200);
      return { attachmentId: (await completed.json()).attachmentId, bytes };
    },
  };
  return f;
}
