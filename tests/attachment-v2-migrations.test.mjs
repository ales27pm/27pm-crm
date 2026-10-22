import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/d1";
import { migrate } from "drizzle-orm/d1/migrator";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const DIRECTORY = new URL("../drizzle/", import.meta.url);
const FOLDER = fileURLToPath(DIRECTORY);
const TABLES = ["attachment_v2_objects", "attachment_v2_uploads", "attachment_v2_chunks",
  "attachment_scan_jobs", "attachment_scanner_heartbeats", "attachment_scanner_request_nonces"].sort();

test("the actual Drizzle reader registers both custom migrations as five statements each", async () => {
  const journal = JSON.parse(await readFile(new URL("meta/_journal.json", DIRECTORY), "utf8"));
  const migrations = readMigrationFiles({ migrationsFolder: FOLDER });
  assert.equal(journal.entries.length, 25);
  assert.equal(migrations.length, 25, "SQL files alone do not register a Drizzle migration");
  assert.deepEqual(journal.entries.map(e => e.idx), Array.from({ length: 25 }, (_, i) => i));
  assert.deepEqual(journal.entries.slice(22, 24).map(e => e.tag), ["0022_attachment_v2_uploads", "0023_attachment_scan_jobs"]);
  assert.equal(journal.entries[24].tag, "0024_service_integration");
  for (let i = 1; i < journal.entries.length; i++) assert.ok(journal.entries[i].when > journal.entries[i - 1].when);
  for (const index of [22, 23]) {
    assert.equal(journal.entries[index].version, "6");
    assert.equal(journal.entries[index].breakpoints, true);
    assert.equal(migrations[index].folderMillis, journal.entries[index].when);
    assert.equal(migrations[index].sql.filter(statement => statement.trim()).length, 5);
    assert.match(migrations[index].hash, /^[0-9a-f]{64}$/u);
  }
});

test("custom snapshots extend the ID chain without changing the previous schema", async () => {
  const snapshots = await Promise.all([21, 22, 23].map(async n =>
    JSON.parse(await readFile(new URL(`meta/00${n}_snapshot.json`, DIRECTORY), "utf8"))));
  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1], current = snapshots[i];
    assert.equal(current.prevId, previous.id);
    assert.notEqual(current.id, previous.id);
    assert.match(current.id, /^[0-9a-f-]{36}$/u);
    const { id: previousId, prevId: previousParent, ...previousSchema } = previous;
    const { id: currentId, prevId: currentParent, ...currentSchema } = current;
    assert.ok(previousId && previousParent && currentId && currentParent);
    // Property order may be normalized by Kit; actual schema content may not.
    assert.deepEqual(currentSchema, previousSchema);
  }
  for (const table of TABLES) assert.equal(Object.hasOwn(snapshots.at(-1).tables, table), false,
    "these explicit custom DDL tables remain SQL-authoritative, not half-modeled ORM additions");
});

test("service snapshot extends the current chain with only its two additive tables", async () => {
  const [previous, current] = await Promise.all([23, 24].map(async n =>
    JSON.parse(await readFile(new URL(`meta/00${n}_snapshot.json`, DIRECTORY), "utf8"))));
  assert.equal(current.prevId, previous.id);
  for (const [name, table] of Object.entries(previous.tables)) {
    assert.deepEqual(current.tables[name], table, name);
  }
  assert.deepEqual(Object.keys(current.tables).filter(name => !Object.hasOwn(previous.tables, name)).sort(),
    ["integration_documents", "integration_operations"]);
});

test("real local D1 Drizzle migrator adds 0022 onward, preserves history/data and is idempotent", { timeout: 60_000 }, async t => {
  const mf = new Miniflare(convertV4MiniflareOptions({
    name: "attachment-migration-proof", modules: true, compatibilityDate: "2026-09-18",
    d1Databases: { DB: randomUUID() }, host: "127.0.0.1", port: 0,
    script: "export default {fetch(){return new Response('local migration test only')}}",
  }));
  t.after(() => mf.dispose());
  const native = await mf.getD1Database("DB");
  const migrations = readMigrationFiles({ migrationsFolder: FOLDER });
  // Reproduce an already migrated legacy database using each historical SQL
  // statement, never sqlite.exec() or a replacement fake D1 implementation.
  for (const migration of migrations.slice(0, 22)) {
    for (const statement of migration.sql) {
      if (statement.trim()) assert.equal((await native.prepare(statement).run()).success, true);
    }
  }
  await native.prepare(`CREATE TABLE __drizzle_migrations (
    id SERIAL PRIMARY KEY,hash text NOT NULL,created_at numeric)`).run();
  for (const [index, migration] of migrations.slice(0, 22).entries()) {
    // Distinct explicit historical IDs act as sentinels: the new migrator must
    // neither rebuild this history table nor replace/normalize its old records.
    await native.prepare("INSERT INTO __drizzle_migrations(id,hash,created_at) VALUES (?,?,?)")
      .bind(1000 + index, migration.hash, migration.folderMillis).run();
  }
  await native.prepare("INSERT INTO organizations(id,external_key,name,source_label,notes) VALUES (?,?,?,?,?)")
    .bind("migration-preservation-fixture", "migration-preservation-fixture", "Synthetic migration fixture",
      "fixture", "Preserve these exact pre-existing bytes.").run();
  const beforeHistory = (await native.prepare("SELECT * FROM __drizzle_migrations ORDER BY created_at").all()).results;
  const beforeData = await native.prepare("SELECT * FROM organizations WHERE id=?").bind("migration-preservation-fixture").first();
  assert.equal(beforeHistory.length, 22);
  assert.equal((await native.prepare("SELECT name FROM sqlite_master WHERE name='attachment_v2_objects'").all()).results.length, 0);

  const orm = drizzle(native);
  await migrate(orm, { migrationsFolder: FOLDER });
  const history = (await native.prepare("SELECT * FROM __drizzle_migrations ORDER BY created_at").all()).results;
  assert.equal(history.length, 25);
  assert.deepEqual(history.slice(0, 22), beforeHistory);
  assert.deepEqual(history.slice(22).map(({ hash, created_at }) => ({ hash, created_at })),
    migrations.slice(22).map(m => ({ hash: m.hash, created_at: m.folderMillis })));
  assert.deepEqual(await native.prepare("SELECT * FROM organizations WHERE id=?").bind("migration-preservation-fixture").first(), beforeData);
  const tableRows = (await native.prepare(`SELECT name FROM sqlite_master WHERE type='table'
    AND (name LIKE 'attachment_v2_%' OR name LIKE 'attachment_scan%') ORDER BY name`).all()).results;
  assert.deepEqual(tableRows.map(row => row.name), TABLES);
  assert.deepEqual((await native.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'integration_%' ORDER BY name").all()).results.map(row => row.name),
    ["integration_documents", "integration_operations"]);
  assert.deepEqual((await native.prepare("PRAGMA foreign_key_check").all()).results, []);
  const indexes = (await native.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'attachment_%' ORDER BY name").all()).results;
  assert.ok(indexes.some(row => row.name === "attachment_v2_active_dedup"));
  assert.ok(indexes.some(row => row.name === "attachment_scan_jobs_claim_idx"));
  assert.ok(indexes.some(row => row.name === "attachment_scanner_request_nonces_expiry_idx"));

  const beforeSecondSchema = (await native.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).results;
  await migrate(orm, { migrationsFolder: FOLDER });
  assert.deepEqual((await native.prepare("SELECT * FROM __drizzle_migrations ORDER BY created_at").all()).results, history);
  assert.deepEqual((await native.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name").all()).results, beforeSecondSchema);
  assert.deepEqual(await native.prepare("SELECT * FROM organizations WHERE id=?").bind("migration-preservation-fixture").first(), beforeData);
});
