import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildLogicalD1Snapshot } from "../lib/d1-snapshot.ts";

test("captures a transactionally consistent, lossless, read-only logical snapshot", async (t) => {
  const database = fixtureDatabase();
  t.after(() => database.close());
  const queries = [];
  let batches = 0;
  const snapshot = await buildLogicalD1Snapshot(
    d1Adapter(database, queries, () => { batches += 1; }),
    sequenceClock("2026-09-12T02:00:00.000Z", "2026-09-12T02:00:01.000Z"),
  );

  assert.equal(snapshot.format, "27pm-d1-logical-v2");
  assert.equal(batches, 1);
  assert.deepEqual(snapshot.quickCheck, ["ok"]);
  assert.deepEqual(snapshot.foreignKeyViolations, []);
  assert.ok(!snapshot.schemaObjects.some((entry) => entry.name.startsWith("_cf_")));
  assert.ok(!snapshot.tables.some((table) => table.name.startsWith("_cf_")));
  assert.ok(snapshot.schemaObjects.some((entry) => entry.type === "trigger" && entry.name === "child_touch"));
  assert.ok(snapshot.schemaObjects.some((entry) => entry.type === "view" && entry.name === "child_view"));
  const child = snapshot.tables.find((table) => table.name === "child");
  assert.ok(child);
  assert.equal(child.rowCount, 1);
  assert.equal(child.rows[0][2], "x".repeat(8_192));
  assert.ok(queries.every((query) => /^\s*(?:SELECT|PRAGMA)\b/iu.test(query)));
  assert.ok(queries.length < 50);
});

test("rejects a source database with foreign-key violations", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`PRAGMA foreign_keys=OFF;
    CREATE TABLE parent (id INTEGER PRIMARY KEY);
    CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
    INSERT INTO child (id, parent_id) VALUES (1, 999);`);
  await assert.rejects(
    buildLogicalD1Snapshot(d1Adapter(database, [], () => {})),
    /foreign-key violations/u,
  );
});

test("generated restore SQL recreates byte-equivalent rows and schema", async (t) => {
  const database = fixtureDatabase();
  t.after(() => database.close());
  const snapshot = await buildLogicalD1Snapshot(
    d1Adapter(database, [], () => {}),
    sequenceClock("2026-09-12T02:00:00.000Z", "2026-09-12T02:00:01.000Z"),
  );
  const temporary = await mkdtemp(join(tmpdir(), "27pm-d1-snapshot-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const snapshotPath = join(temporary, "snapshot.json");
  const outputDirectory = join(temporary, "validated");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const result = spawnSync(
    process.execPath,
    ["--experimental-sqlite", "scripts/validate-d1-export.mjs", snapshotPath, outputDirectory],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(await readFile(join(outputDirectory, "manifest.json"), "utf8"));
  assert.equal(manifest.validation.restoredIntegrityCheck, "ok");
  assert.equal(manifest.validation.restoredForeignKeyViolations, 0);
  assert.equal(manifest.validation.schemaObjectsMatch, true);
  assert.equal(manifest.validation.tableRowsMatch, true);
  const restoreSql = await readFile(join(outputDirectory, "restore.sql"), "utf8");
  assert.match(restoreSql, /PRAGMA defer_foreign_keys = TRUE;/u);
  assert.doesNotMatch(restoreSql, /PRAGMA user_version/u);
  assert.doesNotMatch(
    restoreSql,
    /^(?:BEGIN(?: IMMEDIATE| TRANSACTION)?|COMMIT);$/imu,
  );
});

test("rejects a restore artifact that exceeds D1's SQL statement limit", async (t) => {
  const database = fixtureDatabase();
  t.after(() => database.close());
  const snapshot = await buildLogicalD1Snapshot(
    d1Adapter(database, [], () => {}),
    sequenceClock("2026-09-12T02:00:00.000Z", "2026-09-12T02:00:01.000Z"),
  );
  const child = snapshot.tables.find((table) => table.name === "child");
  assert.ok(child);
  child.rows[0][2] = "é".repeat(50_001);

  const temporary = await mkdtemp(join(tmpdir(), "27pm-d1-oversize-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const snapshotPath = join(temporary, "snapshot.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "scripts/validate-d1-export.mjs",
      snapshotPath,
      join(temporary, "validated"),
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exceeds D1's 100000-byte statement limit/u);
});

test("the temporary export route is secret-gated, expiring, private, and POST-only", async () => {
  const source = await readFile(
    new URL("../app/api/admin/d1-export/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /export async function POST/u);
  assert.doesNotMatch(source, /export async function GET/u);
  assert.match(source, /CRM_BACKUP_TOKEN/u);
  assert.match(source, /CRM_BACKUP_EXPIRES_AT/u);
  assert.match(source, /x-27pm-backup-token/u);
  assert.match(source, /constantTimeEqual/u);
  assert.match(source, /private, no-store/u);
});

function fixtureDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent(id),
      body TEXT NOT NULL,
      payload BLOB
    );
    CREATE INDEX child_parent_idx ON child(parent_id);
    CREATE VIEW child_view AS SELECT id, parent_id FROM child;
    CREATE TRIGGER child_touch AFTER UPDATE ON child BEGIN SELECT NEW.id; END;
    CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
    INSERT INTO parent (label) VALUES ('owner''s row');`);
  database
    .prepare("INSERT INTO child (id, parent_id, body, payload) VALUES (?, ?, ?, ?)")
    .run(1, 1, "x".repeat(8_192), Uint8Array.from([0, 1, 127, 255]));
  return database;
}

function d1Adapter(database, queries, onBatch) {
  return {
    prepare(query) {
      queries.push(query);
      return prepared(database, query, []);
    },
    async batch(statements) {
      onBatch();
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function prepared(database, query, values) {
  return {
    bind(...nextValues) {
      return prepared(database, query, nextValues);
    },
    async all() {
      const statement = database.prepare(query);
      return {
        results: statement.all(...values).map((row) => ({ ...row })),
        success: true,
        meta: { changes: 0 },
      };
    },
  };
}

function sequenceClock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}
