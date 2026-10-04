import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_ATTACHMENT_BYTES, MOBILE_ATTACHMENT_SCAN_POLICY, attachmentsConfigured,
  mobileAttachmentSchemaReady, attachmentFormParts, readAttachmentForm,
  uploadMobileAttachment, downloadMobileAttachment, deleteMobileAttachment, listMobileAttachments,
} from "../lib/mobile-attachments.ts";
import { fixture, file, errorCode } from "./helpers/mobile-attachment-fixture.mjs";

const upload = f => uploadMobileAttachment(f.db, f.bucket, "account", "org-test", file(), "device-fixture");
const withFixture = async (t) => {
  const f = await fixture();
  t.after(() => f.sqlite.close());
  return f;
};
const activeRow = f => f.sqlite.prepare("SELECT * FROM mobile_attachments WHERE deleted_at IS NULL").get();

test("activation additionally requires the explicit scanner contract; Vercel stays disabled", () => {
  for (const policy of [null, "", "true", "unknown"]) {
    assert.equal(attachmentsConfigured("1", "cloudflare-r2", null, policy), false);
  }
  assert.equal(attachmentsConfigured("1", "cloudflare-r2", null, MOBILE_ATTACHMENT_SCAN_POLICY), true);
  assert.equal(attachmentsConfigured("0", "cloudflare-r2", null, MOBILE_ATTACHMENT_SCAN_POLICY), false);
  assert.equal(attachmentsConfigured("1", "cloudflare-r2", "1", MOBILE_ATTACHMENT_SCAN_POLICY), false);
});

test("schema probe reads no customer rows and does not modify SQLite", async t => {
  const f = await withFixture(t);
  const before = f.sqlite.prepare("SELECT total_changes() AS n").get().n;
  assert.equal(await mobileAttachmentSchemaReady(f.db), true);
  assert.equal(f.sqlite.prepare("SELECT total_changes() AS n").get().n, before);
  assert.equal(f.queries.length, 5);
  assert.ok(f.queries.every(sql => /WHERE 0/u.test(sql) || /sqlite_master/u.test(sql)));
});

for (const [name, sql] of [
  ["0018 table", "DROP TABLE internal_api_nonces"],
  ["address field", "ALTER TABLE organizations DROP COLUMN address"],
  ["dedup index", "DROP INDEX mobile_attachments_active_dedup_unique"],
  ["dedup uniqueness", `DROP INDEX mobile_attachments_active_dedup_unique;
    CREATE INDEX mobile_attachments_active_dedup_unique ON mobile_attachments(owner_kind,owner_id,sha256) WHERE deleted_at IS NULL`],
  ["dedup predicate", `DROP INDEX mobile_attachments_active_dedup_unique;
    CREATE UNIQUE INDEX mobile_attachments_active_dedup_unique ON mobile_attachments(owner_kind,owner_id,sha256) WHERE deleted_at IS NOT NULL`],
]) {
  test(`schema probe fails closed on missing or incompatible ${name}`, async t => {
    const f = await withFixture(t);
    f.sqlite.exec(sql);
    assert.equal(await mobileAttachmentSchemaReady(f.db), false);
  });
}

test("upload supplies native R2 SHA-256 and always starts quarantined", async t => {
  const f = await withFixture(t);
  const id = await upload(f), row = activeRow(f), object = f.objects.get(row.storage_key);
  assert.equal(Buffer.from(object.checksums.sha256).toString("hex"), row.sha256);
  assert.equal(row.byte_size, await file().arrayBuffer().then(b => b.byteLength));
  assert.deepEqual(object.customMetadata, { scanStatus: "unscanned", scanPolicy: MOBILE_ATTACHMENT_SCAN_POLICY });
  await assert.rejects(downloadMobileAttachment(f.db, f.bucket, id), errorCode(423, "attachment_quarantined"));
  assert.equal(f.io.cancellations, 1);
  f.markClean(id);
  const response = await downloadMobileAttachment(f.db, f.bucket, id);
  assert.equal(await response.text(), await file().text());
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(response.headers.get("etag"), null);
});

for (const [name, mutate, status, code] of [
  ["missing checksum", o => { o.checksums = {}; }, 503, "attachment_storage_unavailable"],
  ["changed checksum", o => { o.checksums.sha256 = new ArrayBuffer(32); }, 503, "attachment_storage_unavailable"],
  ["wrong length", o => { o.size++; }, 503, "attachment_storage_unavailable"],
  ["wrong key", o => { o.key = "other-object"; }, 503, "attachment_storage_unavailable"],
  ["malware verdict", o => { o.customMetadata.scanStatus = "infected"; }, 423, "attachment_quarantined"],
  ["verdict hash mismatch", o => { o.customMetadata.scanSha256 = "0".repeat(64); }, 423, "attachment_quarantined"],
  ["missing scan policy", o => { delete o.customMetadata.scanPolicy; }, 423, "attachment_quarantined"],
]) {
  test(`download refuses ${name} before returning bytes`, async t => {
    const f = await withFixture(t), id = await upload(f);
    f.markClean(id);
    mutate(f.objects.get(activeRow(f).storage_key));
    await assert.rejects(downloadMobileAttachment(f.db, f.bucket, id), errorCode(status, code));
    assert.equal(f.io.cancellations, 1);
  });
}

test("dedup never acknowledges an active row whose object vanished", async t => {
  const f = await withFixture(t);
  await upload(f);
  f.objects.clear();
  await assert.rejects(upload(f), errorCode(503, "attachment_storage_unavailable"));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_attachments").get().n, 1);
});

test("dedup checks native checksum, not arbitrary custom checksum metadata", async t => {
  const f = await withFixture(t);
  await upload(f);
  const row = activeRow(f), object = f.objects.get(row.storage_key);
  object.customMetadata.sha256 = row.sha256;
  object.checksums = {};
  await assert.rejects(upload(f), errorCode(503, "attachment_storage_unavailable"));
});

test("uncertain committed INSERT preserves bytes and retry returns original id", async t => {
  const f = await withFixture(t);
  const prepare = f.db.prepare;
  f.db.prepare = sql => {
    const stmt = prepare(sql);
    if (sql.startsWith("INSERT INTO mobile_attachments")) {
      const run = stmt.run;
      stmt.run = async () => { await run(); throw new Error("lost confirmation after commit"); };
    }
    return stmt;
  };
  await assert.rejects(upload(f), /lost confirmation/u);
  const row = activeRow(f);
  assert.equal(f.objects.size, 1);
  assert.equal(f.io.deletes, 0);
  f.db.prepare = prepare;
  assert.equal(await upload(f), row.id);
});

test("uncertain uncommitted INSERT leaves an orphan rather than deleting unknown data", async t => {
  const f = await withFixture(t), prepare = f.db.prepare;
  f.db.prepare = sql => {
    const stmt = prepare(sql);
    if (sql.startsWith("INSERT INTO mobile_attachments")) stmt.run = async () => { throw new Error("unknown DB result"); };
    return stmt;
  };
  await assert.rejects(upload(f), /unknown DB result/u);
  assert.equal(f.objects.size, 1);
  assert.equal(f.io.deletes, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_attachments").get().n, 0);
});

test("loser cleanup failure does not reject an independently confirmed winner", async t => {
  const f = await withFixture(t), put = f.bucket.put;
  let count = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  f.bucket.put = async (...args) => { await put(...args); if (++count === 2) release(); await both; };
  f.bucket.delete = async () => { throw new Error("cleanup unavailable"); };
  const ids = await Promise.all([upload(f), upload(f)]);
  assert.equal(ids[0], ids[1]);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM mobile_attachments").get().n, 1);
  assert.equal(f.objects.size, 2); // one tracked object, one reconcilable orphan
});

test("unconfirmed tombstone update cannot delete the active object's bytes", async t => {
  const f = await withFixture(t), id = await upload(f), prepare = f.db.prepare;
  f.db.prepare = sql => {
    const stmt = prepare(sql);
    if (sql.startsWith("UPDATE mobile_attachments")) stmt.run = async () => ({ success: false });
    return stmt;
  };
  await assert.rejects(deleteMobileAttachment(f.db, f.bucket, id), /attachment_delete_unconfirmed/u);
  assert.equal(f.io.deletes, 0);
  assert.equal(activeRow(f).id, id);
});

test("invalid storage key cannot read or delete another attachment namespace", async t => {
  const f = await withFixture(t), id = await upload(f);
  f.sqlite.prepare("UPDATE mobile_attachments SET storage_key = 'email/private-document' WHERE id = ?").run(id);
  await assert.rejects(deleteMobileAttachment(f.db, f.bucket, id), errorCode(503, "attachment_storage_unavailable"));
  await assert.rejects(downloadMobileAttachment(f.db, f.bucket, id), errorCode(503, "attachment_storage_unavailable"));
  assert.equal(f.io.gets, 0);
  assert.equal(f.io.deletes, 0);
});

test("disguised executables and incorrect declared signatures are rejected before persistence", async t => {
  const f = await withFixture(t);
  for (const unsafe of [
    new File(["plain"], "invoice.EXE. ", { type: "application/octet-stream" }),
    new File(["MZpayload"], "photo.jpg", { type: "image/jpeg" }),
    new File([new Uint8Array([127, 69, 76, 70, 0])], "document", { type: "application/octet-stream" }),
    new File(["not a png"], "photo.png", { type: "image/png" }),
    new File(["not a PDF"], "doc.pdf", { type: "application/pdf" }),
    new File([new Uint8Array([0, 255])], "text.txt", { type: "text/plain" }),
  ]) {
    await assert.rejects(uploadMobileAttachment(f.db, f.bucket, "account", "org-test", unsafe, "device"),
      errorCode(415, "unsupported_media_type"));
  }
  assert.equal(f.objects.size, 0);
});

test("contract maximum is 20 MiB of file bytes, not the multipart envelope", async t => {
  const f = await withFixture(t);
  const max = new File([new Uint8Array(MAX_ATTACHMENT_BYTES)], "bounded.bin", { type: "application/octet-stream" });
  const id = await uploadMobileAttachment(f.db, f.bucket, "account", "org-test", max, "device");
  assert.equal(activeRow(f).byte_size, MAX_ATTACHMENT_BYTES);
  assert.ok(id);
  await assert.rejects(uploadMobileAttachment(f.db, f.bucket, "account", "org-test", { size: MAX_ATTACHMENT_BYTES + 1 }, "device"),
    errorCode(413, "file_too_large"));
});

test("multipart rejects duplicate fields, extra metadata, and non-file bodies", () => {
  const form = () => { const f = new FormData(); f.set("ownerKind", "account"); f.set("ownerId", "org-test"); f.set("file", file()); return f; };
  assert.equal(attachmentFormParts(form()).kind, "account");
  for (const key of ["ownerKind", "ownerId", "file", "scanStatus", "storage_key"]) {
    const input = form(); input.append(key, "clean");
    assert.throws(() => attachmentFormParts(input), errorCode(400, "validation_failed"));
  }
  const input = form(); input.set("file", "not a File");
  assert.throws(() => attachmentFormParts(input), errorCode(400, "validation_failed"));
});

test("multipart rejects encoded, invalid length, mismatched length and urlencoded bodies", async () => {
  const url = "https://crm.27pm.org/api/mobile/attachments";
  for (const headers of [
    { "content-length": "-1" }, { "content-length": "1e4" },
    { "content-type": "multipart/form-data; boundary=x", "content-encoding": "gzip" },
    { "content-type": "application/x-www-form-urlencoded" },
  ]) {
    await assert.rejects(readAttachmentForm(new Request(url, { method: "POST", headers, body: "x" })), errorCode(400, "validation_failed"));
  }
  const form = new FormData(); form.set("file", file());
  await assert.rejects(readAttachmentForm(new Request(url, { method: "POST", headers: { "content-length": "1" }, body: form })),
    errorCode(400, "validation_failed"));
});

test("database failure is not serialized as a successful empty list", async t => {
  const f = await withFixture(t), prepare = f.db.prepare;
  f.db.prepare = sql => {
    const stmt = prepare(sql);
    if (sql.includes("ORDER BY created_at")) stmt.all = async () => ({ success: false, results: [] });
    return stmt;
  };
  await assert.rejects(listMobileAttachments(f.db, "account", "org-test"), /attachment_list_unavailable/u);
});
