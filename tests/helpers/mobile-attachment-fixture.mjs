import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";

// SQLite executes the actual migration SQL. The bucket models native R2 SHA-256
// metadata; it is not a live R2 integration or an antivirus implementation.
export async function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE organizations (id TEXT PRIMARY KEY, deleted_at TEXT);
    CREATE TABLE contacts (id TEXT PRIMARY KEY, phone TEXT);
    CREATE TABLE deals (id TEXT PRIMARY KEY);
    CREATE TABLE conversations (id TEXT PRIMARY KEY);
    CREATE TABLE attachments (id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
    INSERT INTO organizations VALUES ('org-test', NULL);
    INSERT INTO deals VALUES ('deal-test'); INSERT INTO conversations VALUES ('conversation-test');`);
  for (const name of ["0018_married_praxagora", "0019_milky_maestro"]) {
    sqlite.exec(await readFile(new URL(`../../drizzle/${name}.sql`, import.meta.url), "utf8"));
  }
  const queries = [];
  const db = { prepare(sql) {
    queries.push(sql);
    let values = [];
    return {
      bind(...args) { values = args; return this; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { success: true, results: sqlite.prepare(sql).all(...values) }; },
      async run() { return { success: true, meta: { changes: sqlite.prepare(sql).run(...values).changes } }; },
    };
  } };
  const objects = new Map();
  const io = { gets: 0, cancellations: 0, deletes: 0 };
  const digest = bytes => Uint8Array.from(createHash("sha256").update(new Uint8Array(bytes)).digest()).buffer;
  const metadata = object => ({ key: object.key, size: object.size, etag: object.etag,
    version: object.version, checksums: object.checksums,
    customMetadata: object.customMetadata, httpMetadata: object.httpMetadata });
  const bucket = {
    async put(key, bytes, options = {}) {
      const checksum = digest(bytes);
      if (options.sha256) {
        assert.equal(typeof options.sha256 === "string" ? options.sha256 : Buffer.from(options.sha256).toString("hex"),
          Buffer.from(checksum).toString("hex"));
      }
      const version = crypto.randomUUID();
      objects.set(key, { key, bytes, size: bytes.byteLength, etag: version, version,
        checksums: options.sha256 ? { sha256: checksum } : {},
        customMetadata: { ...options.customMetadata }, httpMetadata: { ...options.httpMetadata } });
    },
    async head(key) { return objects.has(key) ? metadata(objects.get(key)) : null; },
    async get(key) {
      io.gets++;
      const object = objects.get(key);
      if (!object) return null;
      return { ...metadata(object), body: new ReadableStream({
        start(controller) { controller.enqueue(new Uint8Array(object.bytes)); },
        pull(controller) { controller.close(); },
        cancel() { io.cancellations++; },
      }) };
    },
    async delete(key) { io.deletes++; objects.delete(key); },
  };
  function markClean(id) {
    // Test-only trusted scanner simulation. Production has no marking endpoint.
    const row = sqlite.prepare("SELECT storage_key FROM mobile_attachments WHERE id = ?").get(id);
    const object = objects.get(row.storage_key);
    object.customMetadata = { scanStatus: "clean", scanPolicy: "sha256-bound-r2-v1",
      scanSha256: Buffer.from(digest(object.bytes)).toString("hex") };
  }
  return { sqlite, db, bucket, objects, queries, markClean, io };
}
export const file = () => new File(["native attachment"], 'résumé "notes".txt', { type: "text/plain" });
export const errorCode = (status, code) => error => error.status === status && error.code === code;
