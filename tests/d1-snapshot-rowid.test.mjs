import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildLogicalD1Snapshot } from "../lib/d1-snapshot.ts";

test("v3 preserves implicit rowids paired with their rows and restores rowid 42", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT);
    INSERT INTO sample (rowid, id, value) VALUES (42, 'later', 'forty-two'), (7, 'earlier', 'seven');`);
  const { db, queries } = adapter(database);
  const snapshot = await buildLogicalD1Snapshot(db);
  const table = snapshot.tables.find((entry) => entry.name === "sample");
  assert.equal(snapshot.format, "27pm-d1-logical-v3");
  assert.equal(table.rowIdAlias, "rowid");
  assert.deepEqual(table.rowIds.map((id, index) => [id, table.rows[index][0]]), [
    ["7", "earlier"], ["42", "later"],
  ]);
  const restored = new DatabaseSync(":memory:");
  t.after(() => restored.close());
  restored.exec("CREATE TABLE sample (id TEXT PRIMARY KEY, value TEXT)");
  for (const [index, row] of table.rows.entries()) {
    restored.prepare("INSERT INTO sample (rowid, id, value) VALUES (?, ?, ?)")
      .run(BigInt(table.rowIds[index]), ...row);
  }
  assert.equal(restored.prepare("SELECT rowid FROM sample WHERE id='later'").get().rowid, 42);
  assert.ok(queries.includes("PRAGMA table_list"));
  assert.ok(queries.every((query) => /^\s*(?:SELECT|PRAGMA)\b/iu.test(query)));
});

test("rowid shadowing and a colliding output column use unshadowed aliases", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (
    RoWiD TEXT, __27pm_backup_rowid TEXT, id TEXT PRIMARY KEY
  );
  INSERT INTO sample (_rowid_, RoWiD, __27pm_backup_rowid, id)
    VALUES (42, 'declared-rowid', 'declared-collision', 'one');
  CREATE TABLE second (rowid TEXT, _ROWID_ TEXT, id TEXT PRIMARY KEY);
  INSERT INTO second (oid, rowid, _ROWID_, id) VALUES (91, 'a', 'b', 'two');`);
  const snapshot = await buildLogicalD1Snapshot(adapter(database).db);
  const table = snapshot.tables.find((entry) => entry.name === "sample");
  assert.equal(table.rowIdAlias, "_rowid_");
  assert.deepEqual(table.rowIds, ["42"]);
  assert.deepEqual(table.rows, [["declared-rowid", "declared-collision", "one"]]);
  const second = snapshot.tables.find((entry) => entry.name === "second");
  assert.equal(second.rowIdAlias, "oid");
  assert.deepEqual(second.rowIds, ["91"]);
});

test("WITHOUT ROWID uses actual table metadata and exports null rowid fields", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (
    rowid TEXT, _rowid_ TEXT, oid TEXT, id TEXT PRIMARY KEY
  ) WITHOUT ROWID;
  INSERT INTO sample VALUES ('a', 'b', 'c', 'one');
  CREATE TABLE ordinary (id TEXT PRIMARY KEY, note TEXT DEFAULT 'WITHOUT ROWID');
  INSERT INTO ordinary (rowid, id) VALUES (42, 'two');`);
  const snapshot = await buildLogicalD1Snapshot(adapter(database).db);
  const table = snapshot.tables.find((entry) => entry.name === "sample");
  assert.equal(table.rowIdAlias, null);
  assert.equal(table.rowIds, null);
  assert.deepEqual(table.rows, [["a", "b", "c", "one"]]);
  assert.deepEqual(snapshot.tables.find((entry) => entry.name === "ordinary").rowIds, ["42"]);
});

test("INTEGER PRIMARY KEY and sqlite_sequence retain their existing stored values", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
    INSERT INTO sample (id, value) VALUES (42, 'keep');
    INSERT INTO sample (id, value) VALUES (80, 'removed');
    DELETE FROM sample WHERE id=80;`);
  const snapshot = await buildLogicalD1Snapshot(adapter(database).db);
  const table = snapshot.tables.find((entry) => entry.name === "sample");
  assert.deepEqual(table.rowIds, ["42"]);
  assert.deepEqual(table.rows, [[42, "keep"]]);
  const sequence = snapshot.tables.find((entry) => entry.name === "sqlite_sequence");
  assert.deepEqual(sequence.rows, [["sample", 80]]);
  assert.deepEqual(sequence.rowIds, ["1"]);
});

test("all three shadowed rowid aliases fail closed even for an empty table", async (t) => {
  const database = fixture(t, "CREATE TABLE sample (ROWID TEXT, _rowid_ TEXT, oid TEXT)");
  await assert.rejects(buildLogicalD1Snapshot(adapter(database).db), /rowid.*shadow|shadow.*rowid/iu);
});

test("virtual and shadow tables are not silently backed up as ordinary tables", async (t) => {
  const database = fixture(t, "CREATE VIRTUAL TABLE sample USING fts5(content)");
  await assert.rejects(buildLogicalD1Snapshot(adapter(database).db), /unsupported.*table|virtual|shadow/iu);
});

test("schema changes between discovery and the transaction fail closed", async (t) => {
  const database = fixture(t, "CREATE TABLE sample (id TEXT PRIMARY KEY)");
  const { db } = adapter(database, {
    beforeBatch: () => database.exec("ALTER TABLE sample ADD COLUMN extra TEXT"),
  });
  await assert.rejects(buildLogicalD1Snapshot(db), /schema changed|metadata changed/iu);
});

test("table metadata is rechecked inside the transaction", async (t) => {
  const database = fixture(t, "CREATE TABLE sample (id TEXT PRIMARY KEY)");
  const { db } = adapter(database, {
    transform: (query, rows, inBatch) => query === "PRAGMA table_list" && inBatch
      ? rows.map((row) => row.name === "sample" ? { ...row, wr: 1 } : row) : rows,
  });
  await assert.rejects(buildLogicalD1Snapshot(db), /metadata changed/iu);
});

test("int64 rowids are cast to text before crossing the numeric D1 boundary", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (id TEXT PRIMARY KEY);
    INSERT INTO sample (rowid, id) VALUES (-9223372036854775808, 'minimum'),
      (0, 'zero'), (9223372036854775807, 'maximum');`);
  const snapshot = await buildLogicalD1Snapshot(adapter(database).db);
  assert.deepEqual(snapshot.tables.find((entry) => entry.name === "sample").rowIds,
    ["-9223372036854775808", "0", "9223372036854775807"]);
});

test("noncanonical, non-string, and out-of-range rowids fail closed", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (id TEXT PRIMARY KEY);
    INSERT INTO sample (rowid, id) VALUES (42, 'one');`);
  for (const invalid of [42, null, "", "01", "-0", "+42", "4.2", "1e2", " 42", "9223372036854775808", "-9223372036854775809"]) {
    const { db } = adapter(database, {
      transform: (query, rows) => {
        if (/CAST\(.+ AS TEXT\)/iu.test(query) && /FROM "sample"/u.test(query)) {
          return rows.map((row) => ({ ...row, [Object.keys(row).at(-1)]: invalid }));
        }
        return rows;
      },
    });
    await assert.rejects(buildLogicalD1Snapshot(db), /rowid/iu, String(invalid));
  }
});

test("unsafe integer payloads still fail rather than silently round", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (id TEXT PRIMARY KEY, value INTEGER);
    INSERT INTO sample (id, value) VALUES ('one', 1);`);
  const { db } = adapter(database, {
    transform: (query, rows) => /FROM "sample"/u.test(query)
      ? rows.map((row) => ({ ...row, value: 9007199254740992 })) : rows,
  });
  await assert.rejects(buildLogicalD1Snapshot(db), /unsafe integer/iu);
});

test("generated columns remain metadata, not additional stored cells", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (
    id TEXT PRIMARY KEY, value INTEGER,
    doubled INTEGER GENERATED ALWAYS AS (value * 2) STORED
  );
  INSERT INTO sample (rowid, id, value) VALUES (42, 'one', 3);`);
  const snapshot = await buildLogicalD1Snapshot(adapter(database).db);
  const table = snapshot.tables.find((entry) => entry.name === "sample");
  assert.deepEqual(table.rowIds, ["42"]);
  assert.deepEqual(table.rows, [["one", 3]]);
  assert.equal(table.columns.find((column) => column.name === "doubled").hidden, 3);
});

test("duplicate implicit rowids are rejected instead of producing an unrestorable snapshot", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (id TEXT PRIMARY KEY);
    INSERT INTO sample (rowid, id) VALUES (7, 'one'), (42, 'two');`);
  const { db } = adapter(database, {
    transform: (query, rows) => /CAST\(.+ AS TEXT\)/iu.test(query) && /FROM "sample"/u.test(query)
      ? rows.map((row) => ({ ...row, [Object.keys(row).at(-1)]: "7" })) : rows,
  });
  await assert.rejects(buildLogicalD1Snapshot(db), /duplicate implicit rowids/iu);
});

test("missing table results cannot silently become an empty table", async (t) => {
  const database = fixture(t, `CREATE TABLE sample (id TEXT PRIMARY KEY);
    INSERT INTO sample VALUES ('one');`);
  const { db } = adapter(database, {
    transform: (query, rows) => /FROM "sample"/u.test(query) ? undefined : rows,
  });
  await assert.rejects(buildLogicalD1Snapshot(db), /snapshot transaction failed/iu);
});

test("metadata after data capture is also checked, not only before it", async (t) => {
  const database = fixture(t, "CREATE TABLE sample (id TEXT PRIMARY KEY)");
  let metadataReadsInBatch = 0;
  const { db } = adapter(database, {
    transform: (query, rows, inBatch) => {
      if (query === "PRAGMA table_list" && inBatch && ++metadataReadsInBatch === 2) {
        return rows.map((row) => row.name === "sample" ? { ...row, strict: 1 } : row);
      }
      return rows;
    },
  });
  await assert.rejects(buildLogicalD1Snapshot(db), /metadata changed/iu);
});

function fixture(t, sql) {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE send_commands (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE webhook_receipts (id INTEGER PRIMARY KEY, status TEXT);`);
  database.exec(sql);
  return database;
}

function adapter(database, { beforeBatch, transform = (_query, rows) => rows } = {}) {
  const queries = [];
  let inBatch = false;
  const db = {
    prepare(query) {
      queries.push(query);
      return {
        async all() {
          const rows = database.prepare(query).all().map((row) => ({ ...row }));
          return { results: transform(query, rows, inBatch), success: true, meta: { changes: 0 } };
        },
      };
    },
    async batch(statements) {
      beforeBatch?.();
      database.exec("BEGIN");
      inBatch = true;
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      } finally {
        inBatch = false;
      }
    },
  };
  return { db, queries };
}
