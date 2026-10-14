import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { configFromEnvironment, runCapture } from "../scripts/capture-predeploy-backup.mjs";

const PROJECT_ID = "appgprj_6a8d706605548191a846e670fafdc72b";
const CHECKPOINT = {
  sourceCommitSha: "c".repeat(40),
  sitesVersionId: `${PROJECT_ID}~appgver_rowidtest`,
};
const QUOTED = (value) => `"${value.replaceAll('"', '""')}"`;

test("v3 restoration preserves rowid/value pairing, signed int64 extremes, aliases, WITHOUT ROWID and sequences", async (t) => {
  const directory = await temporaryDirectory(t);
  const snapshot = fixtureSnapshot();
  const result = await validateSnapshot(directory, snapshot);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const manifest = JSON.parse(await readFile(join(directory, "restored", "manifest.json"), "utf8"));
  assert.equal(manifest.validation.rowIdsMatch, true);
  assert.equal(manifest.validation.tableRowsMatch, true);
  assert.equal(manifest.validation.schemaObjectsMatch, true);
  const restored = new DatabaseSync(join(directory, "restored", "restored.sqlite3"));
  t.after(() => restored.close());
  assert.deepEqual(plainRows(restored, "SELECT CAST(rowid AS TEXT) AS id, label FROM explicit_rows ORDER BY rowid"), [
    { id: "-9223372036854775808", label: "minimum" },
    { id: "-7", label: "negative" },
    { id: "0", label: "zero" },
    { id: "42", label: "forty-two" },
    { id: "9007199254740993", label: "above-js-safe" },
    { id: "9223372036854775807", label: "maximum" },
  ]);
  assert.deepEqual(plainRows(restored, 'SELECT CAST(_rowid_ AS TEXT) AS id, "RoWiD" FROM shadowed'), [
    { id: "77", RoWiD: "declared value" },
  ]);
  assert.deepEqual(plainRows(restored, "SELECT CAST(rowid AS TEXT) AS id, name, seq FROM sqlite_sequence"), [
    { id: "42", name: "autonumbers", seq: 100 },
  ]);
  assert.equal(restored.prepare("SELECT wr FROM pragma_table_list WHERE name = 'keyed'").get().wr, 1);
  assert.deepEqual(plainRows(restored, "SELECT * FROM keyed"), [{ id: "a", value: "without" }]);
  restored.exec("INSERT INTO autonumbers(label) VALUES ('next')");
  assert.equal(restored.prepare("SELECT id FROM autonumbers WHERE label = 'next'").get().id, 101);
});

const malformedRowIds = [
  ["missing rowIds", (table) => { delete table.rowIds; }],
  ["missing alias", (table) => { delete table.rowIdAlias; }],
  ["numeric rowid", (table) => { table.rowIds[0] = 42; }],
  ["unsafe numeric rowid", (table) => { table.rowIds[0] = 9007199254740992; }],
  ["out of range positive", (table) => { table.rowIds[0] = "9223372036854775808"; }],
  ["out of range negative", (table) => { table.rowIds[0] = "-9223372036854775809"; }],
  ["duplicate", (table) => { table.rowIds[0] = table.rowIds[1]; }],
  ["missing rowid", (table) => { table.rowIds.pop(); }],
  ["leading zero", (table) => { table.rowIds[0] = "042"; }],
  ["negative zero", (table) => { table.rowIds[0] = "-0"; }],
  ["positive prefix", (table) => { table.rowIds[0] = "+42"; }],
  ["whitespace", (table) => { table.rowIds[0] = " 42"; }],
  ["exponent", (table) => { table.rowIds[0] = "1e3"; }],
  ["invalid alias", (table) => { table.rowIdAlias = "id"; }],
  ["null mismatch", (table) => { table.rowIds = null; }],
];
for (const [name, mutate] of malformedRowIds) {
  test(`validator fails closed on ${name}`, async (t) => {
    const directory = await temporaryDirectory(t);
    const snapshot = fixtureSnapshot();
    mutate(snapshot.tables.find((table) => table.name === "explicit_rows"));
    const result = await validateSnapshot(directory, snapshot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /rowid/iu);
    await assert.rejects(stat(join(directory, "restored", "manifest.json")), { code: "ENOENT" });
  });
}

test("SQLite metadata rejects falsely claiming a rowid table is WITHOUT ROWID", async (t) => {
  const directory = await temporaryDirectory(t);
  const snapshot = fixtureSnapshot();
  const table = snapshot.tables.find((entry) => entry.name === "explicit_rows");
  table.rowIds = null;
  table.rowIdAlias = null;
  const result = await validateSnapshot(directory, snapshot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rowid mode/iu);
});

test("validator rejects shadowed aliases with case-insensitive column names", async (t) => {
  const directory = await temporaryDirectory(t);
  const snapshot = fixtureSnapshot();
  snapshot.tables.find((entry) => entry.name === "shadowed").rowIdAlias = "rowid";
  const result = await validateSnapshot(directory, snapshot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /shadowed rowid/iu);
});

test("validator independently checks INTEGER PRIMARY KEY and rowid pairing, not just row values", async (t) => {
  const directory = await temporaryDirectory(t);
  const snapshot = fixtureSnapshot();
  const table = snapshot.tables.find((entry) => entry.name === "webhook_receipts");
  table.rowIds.reverse();
  const result = await validateSnapshot(directory, snapshot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /rowid pairing/iu);
});

test("validator rejects unsafe numeric cells even when rowids are exact strings", async (t) => {
  const directory = await temporaryDirectory(t);
  const snapshot = fixtureSnapshot();
  snapshot.tables.find((entry) => entry.name === "explicit_rows").rows[0][0] = 9007199254740992;
  const result = await validateSnapshot(directory, snapshot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unsafe integer number/u);
});

test("validator rejects legacy v2 for a fresh backup", async (t) => {
  const directory = await temporaryDirectory(t);
  const snapshot = fixtureSnapshot();
  snapshot.format = "27pm-d1-logical-v2";
  const result = await validateSnapshot(directory, snapshot);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unsupported D1 snapshot format/u);
});

test("capture refuses legacy v2 before requesting R2 or retaining incomplete artifacts", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputDirectory = join(directory, "capture");
  let requests = 0;
  await assert.rejects(runCapture({
    env: environment(outputDirectory),
    fetchImpl: async () => {
      requests++;
      return jsonResponse({ ...fixtureSnapshot(), format: "27pm-d1-logical-v2" });
    },
    validateImpl: () => assert.fail("legacy data must not be validated"),
  }), /unsupported format/u);
  assert.equal(requests, 1);
  await assert.rejects(stat(outputDirectory), { code: "ENOENT" });
});

test("capture restricts optional Sites authorization to pinned same-origin endpoints without redirects or secret logs", async (t) => {
  const directory = await temporaryDirectory(t);
  const outputDirectory = join(directory, "capture");
  const logs = [];
  const calls = [];
  const sitesToken = "fixture-sites-authorization-token";
  await runCapture({
    env: { ...environment(outputDirectory), CRM_BACKUP_SITES_AUTHORIZATION: sitesToken },
    fetchImpl: async (input, init) => {
      calls.push(input);
      assert.equal(new URL(input).origin, "https://crm.27pm.org");
      assert.equal(init.headers["OAI-Sites-Authorization"], `Bearer ${sitesToken}`);
      assert.equal(init.redirect, "error");
      return jsonResponse(input.endsWith("/d1-export") ? fixtureSnapshot() : {
        ...inventory(), complete: undefined, pageCount: undefined, truncated: false,
      });
    },
    validateImpl: async () => ({ rowIdsMatch: true }),
    log: (line) => logs.push(line),
  });
  assert.deepEqual(calls, [
    "https://crm.27pm.org/api/admin/d1-export", "https://crm.27pm.org/api/admin/r2-inventory",
  ]);
  for (const file of ["d1-snapshot.json", "r2-inventory.json"]) {
    assert.equal((await readFile(join(outputDirectory, file), "utf8")).includes(sitesToken), false);
  }
  assert.equal(logs.join("\n").includes(sitesToken), false);
  for (const badToken of ["", " padded", "token\r\nHeader:value", "Bearer token", "token\u0000"]) {
    assert.throws(() => configFromEnvironment({
      ...environment(outputDirectory), CRM_BACKUP_SITES_AUTHORIZATION: badToken,
    }), /CRM_BACKUP_SITES_AUTHORIZATION/u);
  }
});

test("capture rejects redirected response without retrying or logging authorization", async (t) => {
  const directory = await temporaryDirectory(t);
  const logs = [];
  let requests = 0;
  await assert.rejects(runCapture({
    env: { ...environment(join(directory, "capture")), CRM_BACKUP_SITES_AUTHORIZATION: "fixture-token" },
    fetchImpl: async () => {
      requests++;
      const response = jsonResponse(fixtureSnapshot());
      Object.defineProperty(response, "redirected", { value: true });
      Object.defineProperty(response, "url", { value: "https://other.example/api/admin/d1-export" });
      return response;
    },
    log: (line) => logs.push(line),
  }), /unexpected response URL/u);
  assert.equal(requests, 1);
  assert.deepEqual(logs, []);
});

function fixtureSnapshot() {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE attachments (id TEXT PRIMARY KEY, r2_key TEXT NOT NULL UNIQUE, size_bytes INTEGER NOT NULL, sha256 TEXT, scan_status TEXT NOT NULL);
      CREATE TABLE send_commands (id TEXT PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE webhook_receipts (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
      CREATE TABLE explicit_rows (label TEXT NOT NULL);
      CREATE TABLE shadowed ("RoWiD" TEXT);
      CREATE TABLE keyed (id TEXT PRIMARY KEY, value TEXT) WITHOUT ROWID;
      CREATE TABLE autonumbers (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT);
      INSERT INTO explicit_rows(rowid, label) VALUES
        (-9223372036854775808, 'minimum'), (-7, 'negative'), (0, 'zero'), (42, 'forty-two'),
        (9007199254740993, 'above-js-safe'), (9223372036854775807, 'maximum');
      INSERT INTO shadowed(_rowid_, "RoWiD") VALUES (77, 'declared value');
      INSERT INTO keyed VALUES ('a', 'without');
      INSERT INTO webhook_receipts VALUES (17, 'completed'), (41, 'completed');
      INSERT INTO autonumbers VALUES (7, 'initial');
      UPDATE sqlite_sequence SET rowid = 42, seq = 100;
    `);
    const schemaObjects = plainRows(database, `SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema WHERE sql IS NOT NULL AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')
      ORDER BY type, name`);
    const modes = new Map(plainRows(database, "PRAGMA main.table_list").map((row) => [row.name, row.wr]));
    const tables = schemaObjects.filter((object) => object.type === "table").map(({ name }) => {
      const columns = plainRows(database, `PRAGMA table_xinfo(${QUOTED(name)})`);
      const stored = columns.filter((column) => column.hidden === 0);
      const rowIdAlias = modes.get(name) === 1 ? null : ["rowid", "_rowid_", "oid"]
        .find((alias) => !columns.some((column) => column.name.toLowerCase() === alias));
      const projection = stored.map((column) => QUOTED(column.name));
      if (rowIdAlias) projection.push(`CAST(${QUOTED(rowIdAlias)} AS TEXT) AS __source_rowid`);
      const rows = plainRows(database, `SELECT ${projection.join(", ")} FROM ${QUOTED(name)}`);
      return {
        name, columns, rowCount: rows.length,
        rows: rows.map((row) => stored.map((column) => row[column.name])),
        rowIds: rowIdAlias ? rows.map((row) => row.__source_rowid) : null,
        rowIdAlias,
      };
    });
    return {
      format: "27pm-d1-logical-v3", source: { projectId: PROJECT_ID, binding: "DB" },
      checkpoint: CHECKPOINT, startedAt: "2026-10-14T00:00:00.000Z", completedAt: "2026-10-14T00:00:01.000Z",
      quickCheck: ["ok"], foreignKeyViolations: [],
      quiescence: { dispatchingSendCommands: 0, reservedWebhookReceipts: 0 }, schemaObjects, tables,
    };
  } finally { database.close(); }
}

function plainRows(database, sql) {
  return database.prepare(sql).all().map((row) => ({ ...row }));
}

function inventory() {
  return {
    format: "27pm-r2-inventory-v1", source: { projectId: PROJECT_ID, binding: "BUCKET" },
    checkpoint: CHECKPOINT, complete: true, pageCount: 1, objects: [],
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "27pm-backup-rowid-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function validateSnapshot(directory, snapshot) {
  const snapshotPath = join(directory, "snapshot.json");
  const inventoryPath = join(directory, "inventory.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await writeFile(inventoryPath, JSON.stringify(inventory()));
  return spawnSync(process.execPath, [
    "--experimental-sqlite", "scripts/validate-d1-export.mjs", snapshotPath, inventoryPath, join(directory, "restored"),
  ], { encoding: "utf8", cwd: process.cwd() });
}

function environment(outputDirectory) {
  return {
    CRM_BACKUP_D1_EXPORT_URL: "https://crm.27pm.org/api/admin/d1-export",
    CRM_BACKUP_R2_INVENTORY_URL: "https://crm.27pm.org/api/admin/r2-inventory",
    CRM_BACKUP_TOKEN: "t".repeat(64), CRM_BACKUP_OUTPUT_DIRECTORY: outputDirectory,
    CRM_BACKUP_SOURCE_COMMIT_SHA: CHECKPOINT.sourceCommitSha, CRM_BACKUP_SITES_VERSION_ID: CHECKPOINT.sitesVersionId,
  };
}

function jsonResponse(value) {
  const body = JSON.stringify(value);
  return new Response(body, { status: 200, headers: {
    "content-type": "application/json", "cache-control": "private, no-store",
    "x-27pm-backup-byte-count": String(Buffer.byteLength(body)),
  } });
}
