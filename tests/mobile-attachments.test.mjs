import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  attachmentsConfigured, validAttachmentOwner, uploadMobileAttachment, readAttachmentForm,
  listMobileAttachments, downloadMobileAttachment, deleteMobileAttachment,
} from "../lib/mobile-attachments.ts";

async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, phone TEXT);
    CREATE TABLE deals (id TEXT PRIMARY KEY);
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
    INSERT INTO organizations VALUES ('org-test', NULL);
    INSERT INTO deals VALUES ('deal-test'); INSERT INTO conversations VALUES ('conversation-test');`);
  sqlite.exec(await readFile(new URL("../drizzle/0018_woozy_ted_forrester.sql", import.meta.url), "utf8"));
  const db = { prepare(sql) {
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
    };
  } };
  const objects = new Map();
  const bucket = {
    async put(key, bytes) { objects.set(key, bytes); },
    async get(key) { return objects.has(key) ? { body: new Blob([objects.get(key)]).stream() } : null; },
    async delete(key) { objects.delete(key); },
  };
  return { sqlite, db, bucket, objects };
}
const file = () => new File(["native attachment"], 'résumé "notes".txt', { type: "text/plain" });
const errorCode = (status, code) => e => e.status === status && e.code === code;

test("capability requires explicit compatible runtime, and is always false on Vercel", () => {
  assert.equal(attachmentsConfigured(null, null, null), false);
  assert.equal(attachmentsConfigured("1", null, null), false);
  assert.equal(attachmentsConfigured("1", "cloudflare-r2", "1"), false);
  assert.equal(attachmentsConfigured("1", "cloudflare-r2", null), true);
  assert.equal(validAttachmentOwner("__proto__", "org-test"), false);
  assert.equal(validAttachmentOwner("banana", "org-test"), false);
  assert.equal(validAttachmentOwner("account", "  "), false);
});

test("migration preserves mail attachments and existing contact phone; adds nullable address and city", async () => {
  const { sqlite } = await fixture();
  assert.deepEqual(Object.keys(sqlite.prepare("SELECT * FROM organizations").get()), ["id", "deleted_at", "address", "city"]);
  assert.equal(sqlite.prepare("SELECT address FROM organizations").get().address, null);
  assert.deepEqual(sqlite.prepare("PRAGMA table_info(attachments)").all().map(r => r.name), ["id", "message_id"]);
  assert.deepEqual(sqlite.prepare("PRAGMA table_info(contacts)").all().map(r => r.name), ["id", "phone"]);
  sqlite.close();
});

test("upload, dedup, list, private byte-identical download, delete and reupload", async () => {
  const { sqlite, db, bucket, objects } = await fixture();
  const id = await uploadMobileAttachment(db, bucket, "account", "org-test", file(), "session-test");
  assert.equal(await uploadMobileAttachment(db, bucket, "account", "org-test", file(), "session-test"), id);
  assert.equal(objects.size, 1);
  const list = await listMobileAttachments(db, "account", "org-test");
  assert.equal(list.length, 1);
  assert.equal(list[0].id, id);
  const row = sqlite.prepare("SELECT * FROM mobile_attachments").get();
  assert.equal(row.created_by, "session-test");
  assert.match(row.sha256, /^[0-9a-f]{64}$/);
  assert.match(row.storage_key, /^mobile\/\d{4}\/\d{2}\/[0-9a-f-]+$/);
  const response = await downloadMobileAttachment(db, bucket, id);
  assert.equal(await response.text(), "native attachment");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.match(response.headers.get("content-disposition"), /^attachment;/);
  await deleteMobileAttachment(db, bucket, id);
  await deleteMobileAttachment(db, bucket, id);
  await deleteMobileAttachment(db, bucket, "missing");
  assert.equal(objects.size, 0);
  assert.ok(sqlite.prepare("SELECT deleted_at FROM mobile_attachments").get().deleted_at);
  assert.deepEqual(await listMobileAttachments(db, "account", "org-test"), []);
  await assert.rejects(downloadMobileAttachment(db, bucket, id), errorCode(404, "not_found"));
  assert.notEqual(await uploadMobileAttachment(db, bucket, "account", "org-test", file(), "session-test"), id);
  sqlite.close();
});

test("concurrent uploads return same id and clean losing object", async () => {
  const { sqlite, db, bucket, objects } = await fixture();
  // Hold both PUTs until both requests have passed their initial dedup lookup.
  const originalPut = bucket.put;
  let count = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  bucket.put = async (...args) => { await originalPut(...args); if (++count === 2) release(); await both; };
  const ids = await Promise.all([1, 2].map(() => uploadMobileAttachment(db, bucket, "account", "org-test", file(), "session")));
  assert.equal(ids[0], ids[1]);
  assert.equal(objects.size, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_attachments").get().n, 1);
  sqlite.close();
});

test("all three owner kinds resolve their own table and dedup is owner-scoped", async () => {
  const { sqlite, db, bucket } = await fixture();
  const ids = [];
  for (const [kind, owner] of [["account", "org-test"], ["deal", "deal-test"], ["conversation", "conversation-test"]]) {
    ids.push(await uploadMobileAttachment(db, bucket, kind, owner, file(), "session"));
  }
  assert.equal(new Set(ids).size, 3);
  await assert.rejects(uploadMobileAttachment(db, bucket, "deal", "org-test", file(), "session"), errorCode(404, "owner_not_found"));
  sqlite.exec("UPDATE organizations SET deleted_at = CURRENT_TIMESTAMP");
  await assert.rejects(uploadMobileAttachment(db, bucket, "account", "org-test", file(), "session"), errorCode(404, "owner_not_found"));
  sqlite.close();
});

test("invalid size, MIME and missing owner fail without stored objects", async () => {
  const { sqlite, db, bucket, objects } = await fixture();
  await assert.rejects(uploadMobileAttachment(db, bucket, "account", "org-test", new File([], "empty"), "s"), errorCode(400, "validation_failed"));
  await assert.rejects(uploadMobileAttachment(db, bucket, "account", "org-test", { size: 20971521 }, "s"), errorCode(413, "file_too_large"));
  await assert.rejects(uploadMobileAttachment(db, bucket, "account", "org-test", new File(["exe"], "x.exe", { type: "application/x-msdownload" }), "s"), errorCode(415, "unsupported_media_type"));
  await assert.rejects(uploadMobileAttachment(db, bucket, "account", "unknown", file(), "s"), errorCode(404, "owner_not_found"));
  assert.equal(objects.size, 0);
  sqlite.close();
});

test("object failures cannot publish rows; tombstone deletion can be retried", async () => {
  const { sqlite, db, bucket, objects } = await fixture();
  const put = bucket.put;
  bucket.put = async () => { throw new Error("storage-down"); };
  await assert.rejects(uploadMobileAttachment(db, bucket, "account", "org-test", file(), "s"));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_attachments").get().n, 0);
  bucket.put = put;
  const id = await uploadMobileAttachment(db, bucket, "account", "org-test", file(), "s");
  const remove = bucket.delete;
  bucket.delete = async () => { throw new Error("storage-down"); };
  await assert.rejects(deleteMobileAttachment(db, bucket, id));
  assert.equal(objects.size, 1);
  await assert.rejects(downloadMobileAttachment(db, bucket, id), errorCode(404, "not_found"));
  bucket.delete = remove;
  await deleteMobileAttachment(db, bucket, id);
  assert.equal(objects.size, 0);
  sqlite.close();
});

test("every route applies mobile auth; mutation guard uses work scope", async () => {
  for (const route of ["capabilities", "attachments", "attachments/[id]", "attachments/[id]/file"]) {
    const source = await readFile(new URL(`../app/api/mobile/${route}/route.ts`, import.meta.url), "utf8");
    assert.match(source, /await authorizeMobileAttachments\(request/);
    assert.match(source, /if \(auth.response\) return auth.response/);
    assert.match(source, /force-dynamic/);
  }
  const auth = await readFile(new URL("../lib/mobile-attachments-api.ts", import.meta.url), "utf8");
  assert.match(auth, /mobileBearerToken/);
  assert.match(auth, /authentication_required/);
  assert.match(auth, /write \? "crm:work" : "crm:dashboard:read"/);
});


test("multipart parser bounds declared and streaming envelopes, and reports malformed input", async () => {
  const form = new FormData();
  form.set("ownerKind", "account"); form.set("ownerId", "org-test"); form.set("file", file());
  const parsed = await readAttachmentForm(new Request("https://crm.27pm.org/api/mobile/attachments", { method: "POST", body: form }));
  assert.equal(parsed.get("ownerKind"), "account");
  assert.equal(await parsed.get("file").text(), "native attachment");
  await assert.rejects(readAttachmentForm(new Request("https://crm.27pm.org", {
    method: "POST", headers: { "content-length": "99999999" }, body: "x",
  })), errorCode(413, "file_too_large"));
  await assert.rejects(readAttachmentForm(new Request("https://crm.27pm.org", {
    method: "POST", body: "not multipart",
  })), errorCode(400, "validation_failed"));
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new Uint8Array(22 * 1024 * 1024)); controller.close();
  } });
  await assert.rejects(readAttachmentForm(new Request("https://crm.27pm.org", {
    method: "POST", body, duplex: "half", headers: { "content-type": "multipart/form-data; boundary=test" },
  })), errorCode(413, "file_too_large"));
});
