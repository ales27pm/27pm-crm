#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const D1_MAX_SQL_STATEMENT_BYTES = 100_000;

const [snapshotArgument, outputArgument] = process.argv.slice(2);
if (!snapshotArgument || !outputArgument) {
  throw new Error("Usage: validate-d1-export.mjs SNAPSHOT_JSON OUTPUT_DIRECTORY");
}

const snapshotPath = resolve(snapshotArgument);
const outputDirectory = resolve(outputArgument);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
validateSnapshotShape(snapshot);

let outputStats;
try {
  outputStats = await stat(outputDirectory);
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
  await mkdir(outputDirectory, { mode: 0o700 });
  outputStats = await stat(outputDirectory);
}
if (!outputStats.isDirectory()) throw new Error("Output path must be a directory.");
await chmod(outputDirectory, 0o700);

const restoreSqlPath = join(outputDirectory, "restore.sql");
const restoredDatabasePath = join(outputDirectory, "restored.sqlite3");
const manifestPath = join(outputDirectory, "manifest.json");
const validatorPath = join(outputDirectory, "validate-d1-export.mjs");
for (const target of [restoreSqlPath, restoredDatabasePath, manifestPath, validatorPath]) {
  try {
    await stat(target);
    throw new Error(`Refusing to overwrite ${target}.`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

const {
  sql: restoreSql,
  maximumStatementBytes,
} = renderRestoreSql(snapshot);
await writeFile(restoreSqlPath, restoreSql, { encoding: "utf8", mode: 0o600 });
await chmod(restoreSqlPath, 0o600);

const database = new DatabaseSync(restoredDatabasePath);
try {
  database.exec("PRAGMA foreign_keys = OFF; BEGIN IMMEDIATE;");
  try {
    database.exec(restoreSql);
    database.exec("COMMIT;");
  } catch (error) {
    try {
      database.exec("ROLLBACK;");
    } catch {
      // The original restore error is the actionable failure.
    }
    throw error;
  }
  database.exec("PRAGMA foreign_keys = ON;");
  const integrity = database.prepare("PRAGMA integrity_check").all();
  if (
    integrity.length === 0 ||
    integrity.some((row) => !Object.values(row).every((value) => value === "ok"))
  ) {
    throw new Error("Restored SQLite integrity_check failed.");
  }
  const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length !== 0) {
    throw new Error("Restored SQLite database has foreign-key violations.");
  }
  verifySchema(database, snapshot.schemaObjects);
  verifyTableRows(database, snapshot.tables);
} finally {
  database.close();
}
await chmod(restoredDatabasePath, 0o600);

const currentScript = fileURLToPath(import.meta.url);
await copyFile(currentScript, validatorPath, 0);
await chmod(validatorPath, 0o600);
await chmod(snapshotPath, 0o600);

const tableCounts = Object.fromEntries(
  snapshot.tables.map((table) => [table.name, table.rowCount]),
);
const totalRows = Object.values(tableCounts).reduce((sum, count) => sum + count, 0);
const manifest = {
  format: "27pm-d1-backup-manifest-v1",
  source: snapshot.source,
  snapshotWindow: {
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
  },
  files: {
    snapshot: basename(snapshotPath),
    restoreSql: basename(restoreSqlPath),
    restoredDatabase: basename(restoredDatabasePath),
    validator: basename(validatorPath),
  },
  counts: {
    schemaObjects: snapshot.schemaObjects.length,
    tables: snapshot.tables.length,
    totalRows,
    byTable: tableCounts,
  },
  checksums: {
    snapshotSha256: await sha256(snapshotPath),
    restoreSqlSha256: await sha256(restoreSqlPath),
    restoredDatabaseSha256: await sha256(restoredDatabasePath),
    validatorSha256: await sha256(validatorPath),
  },
  validation: {
    sourceQuickCheck: snapshot.quickCheck,
    sourceForeignKeyViolations: snapshot.foreignKeyViolations.length,
    restoreSqlExecuted: true,
    restoredIntegrityCheck: "ok",
    restoredForeignKeyViolations: 0,
    schemaObjectsMatch: true,
    tableRowsMatch: true,
    d1CompatibleNoExplicitTransaction: true,
    d1SqlStatementLimitBytes: D1_MAX_SQL_STATEMENT_BYTES,
    maximumGeneratedSqlStatementBytes: maximumStatementBytes,
  },
  commands: {
    revalidate: `node --experimental-sqlite ${shellQuote(validatorPath)} ${shellQuote(snapshotPath)} ${shellQuote(join(dirname(manifestPath), "revalidation"))}`,
    productionRestoreTemplate: `npx wrangler d1 execute <SITES_MANAGED_D1_DATABASE> --remote --file=${shellQuote(restoreSqlPath)}`,
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
await chmod(manifestPath, 0o600);

process.stdout.write(
  `${JSON.stringify({
    outputDirectory,
    schemaObjects: manifest.counts.schemaObjects,
    tables: manifest.counts.tables,
    totalRows,
    snapshotSha256: manifest.checksums.snapshotSha256,
    restoreSqlSha256: manifest.checksums.restoreSqlSha256,
    restoredDatabaseSha256: manifest.checksums.restoredDatabaseSha256,
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    schemaObjectsMatch: true,
    tableRowsMatch: true,
    maximumGeneratedSqlStatementBytes: maximumStatementBytes,
  })}\n`,
);

function validateSnapshotShape(value) {
  if (!value || value.format !== "27pm-d1-logical-v2") {
    throw new Error("Unsupported D1 snapshot format.");
  }
  if (!Array.isArray(value.schemaObjects) || !Array.isArray(value.tables)) {
    throw new Error("D1 snapshot is missing schema or table data.");
  }
  for (const entry of value.schemaObjects) {
    if (
      !entry ||
      typeof entry.name !== "string" ||
      typeof entry.tableName !== "string" ||
      entry.name.startsWith("_cf_") ||
      entry.tableName.startsWith("_cf_")
    ) {
      throw new Error("D1 snapshot contains a reserved or invalid schema object.");
    }
  }
  if (
    !Array.isArray(value.quickCheck) ||
    value.quickCheck.length === 0 ||
    value.quickCheck.some((entry) => entry !== "ok")
  ) {
    throw new Error("Source D1 quick_check was not clean.");
  }
  if (!Array.isArray(value.foreignKeyViolations) || value.foreignKeyViolations.length) {
    throw new Error("Source D1 foreign-key check was not clean.");
  }
  const names = new Set();
  for (const table of value.tables) {
    if (
      !table ||
      typeof table.name !== "string" ||
      table.name.startsWith("_cf_") ||
      names.has(table.name)
    ) {
      throw new Error("D1 snapshot contains an invalid table name.");
    }
    names.add(table.name);
    if (!Array.isArray(table.columns) || !Array.isArray(table.rows)) {
      throw new Error(`D1 snapshot table ${table.name} is malformed.`);
    }
    const storedColumns = table.columns.filter((column) => Number(column.hidden ?? 0) === 0);
    if (
      table.rowCount !== table.rows.length ||
      table.rows.some((row) => !Array.isArray(row) || row.length !== storedColumns.length)
    ) {
      throw new Error(`D1 snapshot table ${table.name} has inconsistent rows.`);
    }
  }
}

function renderRestoreSql(snapshotValue) {
  const schemaByType = (type) =>
    snapshotValue.schemaObjects
      .filter((entry) => entry.type === type && entry.name !== "sqlite_sequence")
      .toSorted((left, right) => left.name.localeCompare(right.name));
  const lines = ["PRAGMA defer_foreign_keys = TRUE;"];
  for (const entry of schemaByType("table")) lines.push(statement(entry.sql));

  for (const table of snapshotValue.tables) {
    if (table.name === "sqlite_sequence") continue;
    const columns = table.columns.filter((column) => Number(column.hidden ?? 0) === 0);
    if (columns.length === 0) continue;
    const identifiers = columns.map((column) => quoteIdentifier(column.name)).join(", ");
    for (const row of table.rows) {
      lines.push(
        `INSERT INTO ${quoteIdentifier(table.name)} (${identifiers}) VALUES (${row.map(sqlLiteral).join(", ")});`,
      );
    }
  }

  const sequence = snapshotValue.tables.find((table) => table.name === "sqlite_sequence");
  if (sequence) {
    lines.push("DELETE FROM sqlite_sequence;");
    const columns = sequence.columns.filter((column) => Number(column.hidden ?? 0) === 0);
    const identifiers = columns.map((column) => quoteIdentifier(column.name)).join(", ");
    for (const row of sequence.rows) {
      lines.push(
        `INSERT INTO sqlite_sequence (${identifiers}) VALUES (${row.map(sqlLiteral).join(", ")});`,
      );
    }
  }

  for (const type of ["index", "view", "trigger"]) {
    for (const entry of schemaByType(type)) lines.push(statement(entry.sql));
  }
  lines.push("");
  const maximumStatementBytes = Math.max(
    ...lines.map((line) => Buffer.byteLength(line, "utf8")),
  );
  if (maximumStatementBytes > D1_MAX_SQL_STATEMENT_BYTES) {
    throw new Error(
      `Generated restore SQL exceeds D1's ${D1_MAX_SQL_STATEMENT_BYTES}-byte statement limit.`,
    );
  }
  return { sql: lines.join("\n"), maximumStatementBytes };
}

function statement(sql) {
  if (typeof sql !== "string" || !sql.trim()) throw new Error("Invalid schema SQL.");
  return `${sql.trim().replace(/;+$/u, "")};`;
}

function sqlLiteral(value) {
  if (value === null) return "NULL";
  if (typeof value === "string") {
    if (value.includes("\0")) {
      return `CAST(X'${Buffer.from(value, "utf8").toString("hex")}' AS TEXT)`;
    }
    return `'${value.replaceAll("'", "''")}'`;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Snapshot contains a non-finite number.");
    return Object.is(value, -0) ? "0" : String(value);
  }
  if (value?.kind === "integer" && /^-?\d+$/u.test(value.decimal)) {
    return value.decimal;
  }
  if (value?.kind === "blob" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.base64)) {
    return `X'${Buffer.from(value.base64, "base64").toString("hex")}'`;
  }
  throw new Error("Snapshot contains an unsupported cell value.");
}

function verifySchema(databaseValue, expected) {
  const actual = databaseValue
    .prepare(`SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_schema
      WHERE sql IS NOT NULL
        AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')
        AND substr(name, 1, 4) <> '_cf_'
        AND substr(tbl_name, 1, 4) <> '_cf_'
      ORDER BY type, name`)
    .all()
    .map((row) => ({ ...row }));
  const canonical = (rows) =>
    rows.map((row) => ({
      type: row.type,
      name: row.name,
      tableName: row.tableName,
      sql: normalizeSql(row.sql),
    }));
  if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) {
    throw new Error("Restored SQLite schema does not match the source snapshot.");
  }
}

function verifyTableRows(databaseValue, tables) {
  for (const table of tables) {
    const columns = table.columns.filter((column) => Number(column.hidden ?? 0) === 0);
    const projection = columns.map((column) => quoteIdentifier(column.name)).join(", ");
    const statementValue = databaseValue.prepare(
      `SELECT ${projection} FROM ${quoteIdentifier(table.name)}`,
    );
    const actualRows = statementValue.all().map((row) =>
      columns.map((column) => encodeDatabaseCell(row[column.name])),
    );
    if (
      JSON.stringify(actualRows.map(canonicalRow).toSorted()) !==
      JSON.stringify(table.rows.map(canonicalRow).toSorted())
    ) {
      throw new Error(`Restored rows do not match table ${table.name}.`);
    }
  }
}

function encodeDatabaseCell(value) {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "bigint") return { kind: "integer", decimal: value.toString(10) };
  if (ArrayBuffer.isView(value)) {
    return {
      kind: "blob",
      base64: Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("base64"),
    };
  }
  throw new Error("Restored database returned an unsupported cell type.");
}

function canonicalRow(row) {
  return JSON.stringify(row);
}

function normalizeSql(value) {
  return String(value).trim().replace(/;+$/u, "").replaceAll(/\s+/gu, " ");
}

function quoteIdentifier(value) {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error("Invalid SQLite identifier.");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
