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
const EXPECTED_SITES_PROJECT_ID = "appgprj_6a8d706605548191a846e670fafdc72b";

const arguments_ = process.argv.slice(2);
const [snapshotArgument, inventoryArgument, outputArgument] = arguments_;
if (
  arguments_.length !== 3 ||
  !snapshotArgument ||
  !inventoryArgument ||
  !outputArgument
) {
  throw new Error(
    "Usage: validate-d1-export.mjs SNAPSHOT_JSON R2_INVENTORY_JSON OUTPUT_DIRECTORY",
  );
}

const snapshotPath = resolve(snapshotArgument);
const inventoryPath = resolve(inventoryArgument);
const outputDirectory = resolve(outputArgument);
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
const inventory = JSON.parse(await readFile(inventoryPath, "utf8"));
validateSnapshotShape(snapshot);
validateInventoryShape(inventory);
assertMatchingCheckpoints(snapshot.checkpoint, inventory.checkpoint);
if (snapshot.source.projectId !== inventory.source.projectId) {
  throw new Error("D1 and R2 artifacts do not identify the same Sites project.");
}

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

let reconciliation;
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
  const quick = database.prepare("PRAGMA quick_check").all();
  if (
    quick.length === 0 ||
    quick.some((row) => !Object.values(row).every((value) => value === "ok"))
  ) {
    throw new Error("Restored SQLite quick_check failed.");
  }
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
  verifyColumns(database, snapshot.tables);
  verifyTableRows(database, snapshot.tables);
  reconciliation = reconcileAttachments(database, inventory.objects);
} finally {
  database.close();
}
await chmod(restoredDatabasePath, 0o600);

const currentScript = fileURLToPath(import.meta.url);
await copyFile(currentScript, validatorPath, 0);
await chmod(validatorPath, 0o600);
await chmod(snapshotPath, 0o600);
await chmod(inventoryPath, 0o600);

const tableCounts = Object.fromEntries(
  snapshot.tables.map((table) => [table.name, table.rowCount]),
);
const totalRows = Object.values(tableCounts).reduce((sum, count) => sum + count, 0);
const manifest = {
  format: "27pm-predeploy-backup-manifest-v1",
  source: {
    projectId: snapshot.source.projectId,
    d1Binding: snapshot.source.binding,
    r2Binding: inventory.source.binding,
  },
  checkpoint: snapshot.checkpoint,
  snapshotWindow: {
    startedAt: snapshot.startedAt,
    completedAt: snapshot.completedAt,
  },
  r2InventoryWindow: {
    startedAt: inventory.startedAt ?? null,
    completedAt: inventory.completedAt ?? null,
  },
  files: {
    snapshot: basename(snapshotPath),
    r2Inventory: basename(inventoryPath),
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
    r2InventorySha256: await sha256(inventoryPath),
    schemaFingerprintSha256: hashJson(
      snapshot.schemaObjects.map((entry) => ({
        type: entry.type,
        name: entry.name,
        tableName: entry.tableName,
        sql: normalizeSql(entry.sql),
      })),
    ),
    restoreSqlSha256: await sha256(restoreSqlPath),
    restoredDatabaseSha256: await sha256(restoredDatabasePath),
    validatorSha256: await sha256(validatorPath),
  },
  validation: {
    sourceQuickCheck: snapshot.quickCheck,
    sourceForeignKeyViolations: snapshot.foreignKeyViolations.length,
    sourceQuiescence: snapshot.quiescence,
    restoreSqlExecuted: true,
    restoredQuickCheck: "ok",
    restoredIntegrityCheck: "ok",
    restoredForeignKeyViolations: 0,
    schemaObjectsMatch: true,
    tableRowsMatch: true,
    d1CompatibleNoExplicitTransaction: true,
    d1SqlStatementLimitBytes: D1_MAX_SQL_STATEMENT_BYTES,
    maximumGeneratedSqlStatementBytes: maximumStatementBytes,
    r2InventoryComplete: inventory.complete,
    r2InventoryPages: inventory.pageCount,
    r2Reconciliation: reconciliation,
  },
  commands: {
    localValidationExecuted: [
      process.execPath,
      ...process.execArgv,
      ...process.argv.slice(1),
    ]
      .map(shellQuote)
      .join(" "),
    revalidate: `node --experimental-sqlite ${shellQuote(validatorPath)} ${shellQuote(snapshotPath)} ${shellQuote(inventoryPath)} ${shellQuote(join(dirname(manifestPath), "revalidation"))}`,
    productionRestore: {
      status: "not-authorized-not-executed",
      note: "Restore only through the approved Sites-managed D1 controls; the local Wrangler database ID is a placeholder.",
    },
  },
};
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
  encoding: "utf8",
  mode: 0o600,
});
await chmod(manifestPath, 0o600);

if (!reconciliation.r2ObjectBytesRestorable) {
  throw new Error(
    "R2 inventory contains objects, but object bytes were not captured; a native R2 snapshot or private byte export is required.",
  );
}
if (!reconciliation.clean) {
  throw new Error(
    "R2 inventory does not cleanly reconcile with the attachments table.",
  );
}

process.stdout.write(
  `${JSON.stringify({
    outputDirectory,
    schemaObjects: manifest.counts.schemaObjects,
    tables: manifest.counts.tables,
    totalRows,
    snapshotSha256: manifest.checksums.snapshotSha256,
    r2InventorySha256: manifest.checksums.r2InventorySha256,
    restoreSqlSha256: manifest.checksums.restoreSqlSha256,
    restoredDatabaseSha256: manifest.checksums.restoredDatabaseSha256,
    quickCheck: "ok",
    integrityCheck: "ok",
    foreignKeyViolations: 0,
    schemaObjectsMatch: true,
    tableRowsMatch: true,
    r2ReconciliationClean: reconciliation.clean,
    r2Objects: reconciliation.inventoryObjects,
    attachments: reconciliation.attachmentRows,
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
  validateCheckpoint(value.checkpoint, "D1 snapshot");
  validateSource(value.source, "DB", "D1 snapshot");
  const schemaNames = new Set();
  for (const entry of value.schemaObjects) {
    if (
      !entry ||
      !["index", "table", "trigger", "view"].includes(entry.type) ||
      typeof entry.name !== "string" ||
      typeof entry.tableName !== "string" ||
      typeof entry.sql !== "string" ||
      entry.sql.trim() === "" ||
      schemaNames.has(`${entry.type}\0${entry.name}`) ||
      entry.name.startsWith("_cf_") ||
      entry.tableName.startsWith("_cf_")
    ) {
      throw new Error("D1 snapshot contains a reserved or invalid schema object.");
    }
    schemaNames.add(`${entry.type}\0${entry.name}`);
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
  if (
    !value.quiescence ||
    value.quiescence.dispatchingSendCommands !== 0 ||
    value.quiescence.reservedWebhookReceipts !== 0
  ) {
    throw new Error("Source D1 was not quiescent at snapshot time.");
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
    const columnNames = new Set();
    for (const column of table.columns) {
      if (
        !column ||
        !Number.isInteger(Number(column.cid)) ||
        typeof column.name !== "string" ||
        column.name.length === 0 ||
        columnNames.has(column.name) ||
        typeof column.type !== "string" ||
        ![0, 1].includes(Number(column.notnull)) ||
        !(column.dflt_value === null || typeof column.dflt_value === "string") ||
        !Number.isInteger(Number(column.pk)) ||
        !Number.isInteger(Number(column.hidden ?? 0))
      ) {
        throw new Error(`D1 snapshot table ${table.name} has invalid columns.`);
      }
      columnNames.add(column.name);
    }
    const storedColumns = table.columns.filter((column) => Number(column.hidden ?? 0) === 0);
    if (
      table.rowCount !== table.rows.length ||
      table.rows.some((row) => !Array.isArray(row) || row.length !== storedColumns.length)
    ) {
      throw new Error(`D1 snapshot table ${table.name} has inconsistent rows.`);
    }
  }
  const schemaTables = value.schemaObjects
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name)
    .toSorted();
  const dataTables = value.tables.map((table) => table.name).toSorted();
  if (JSON.stringify(schemaTables) !== JSON.stringify(dataTables)) {
    throw new Error("D1 snapshot schema tables and table data do not match.");
  }
}

function validateInventoryShape(value) {
  if (!value || value.format !== "27pm-r2-inventory-v1") {
    throw new Error("Unsupported R2 inventory format.");
  }
  if (value.complete !== true) {
    throw new Error("R2 inventory is not marked complete.");
  }
  if (!Number.isInteger(value.pageCount) || value.pageCount < 1) {
    throw new Error("R2 inventory has an invalid page count.");
  }
  if (!Array.isArray(value.objects)) {
    throw new Error("R2 inventory is missing object metadata.");
  }
  validateCheckpoint(value.checkpoint, "R2 inventory");
  validateSource(value.source, "BUCKET", "R2 inventory");

  const keys = new Set();
  for (const object of value.objects) {
    if (
      !object ||
      typeof object.key !== "string" ||
      object.key.length === 0 ||
      object.key.includes("\0") ||
      keys.has(object.key)
    ) {
      throw new Error("R2 inventory contains an invalid or duplicate key.");
    }
    keys.add(object.key);
    if (!Number.isSafeInteger(object.size) || object.size < 0) {
      throw new Error("R2 inventory contains an invalid object size.");
    }
    for (const field of ["etag", "uploaded", "version"]) {
      if (
        object[field] !== undefined &&
        object[field] !== null &&
        (typeof object[field] !== "string" || object[field].length === 0)
      ) {
        throw new Error(`R2 inventory contains an invalid ${field}.`);
      }
    }
    if (
      object.sha256 !== undefined &&
      object.sha256 !== null &&
      !isSha256(object.sha256)
    ) {
      throw new Error("R2 inventory contains an invalid SHA-256 checksum.");
    }
  }
}

function validateCheckpoint(value, label) {
  if (
    !value ||
    typeof value.sitesVersionId !== "string" ||
    !/^appgprj_[a-zA-Z0-9]+~appgver_[a-zA-Z0-9]+$/u.test(
      value.sitesVersionId,
    ) ||
    typeof value.sourceCommitSha !== "string" ||
    !/^[a-fA-F0-9]{40}$/u.test(value.sourceCommitSha)
  ) {
    throw new Error(`${label} is missing a valid deployment checkpoint.`);
  }
}

function assertMatchingCheckpoints(left, right) {
  if (
    left.sitesVersionId !== right.sitesVersionId ||
    left.sourceCommitSha.toLowerCase() !== right.sourceCommitSha.toLowerCase()
  ) {
    throw new Error("D1 and R2 artifacts do not describe the same checkpoint.");
  }
}

function validateSource(value, expectedBinding, label) {
  if (
    !value ||
    typeof value.projectId !== "string" ||
    value.projectId !== EXPECTED_SITES_PROJECT_ID ||
    value.binding !== expectedBinding
  ) {
    throw new Error(`${label} is missing the exact Sites resource identity.`);
  }
}

function reconcileAttachments(databaseValue, inventoryObjects) {
  const attachmentTable = databaseValue
    .prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'attachments'",
    )
    .get();
  if (!attachmentTable) {
    throw new Error("Restored SQLite database is missing the attachments table.");
  }

  const attachments = databaseValue
    .prepare(`SELECT
        r2_key AS r2Key,
        size_bytes AS sizeBytes,
        sha256,
        scan_status AS scanStatus
      FROM attachments
      ORDER BY r2_key`)
    .all()
    .map((row) => ({ ...row }));
  const objectsByKey = new Map(
    inventoryObjects.map((object) => [object.key, object]),
  );
  const attachmentKeys = new Set();
  const missingObjects = [];
  const sizeMismatches = [];
  const checksumMismatches = [];
  const cleanChecksumFailures = [];
  let matched = 0;
  let cleanAttachments = 0;
  let cleanChecksumsVerified = 0;

  for (const attachment of attachments) {
    if (
      typeof attachment.r2Key !== "string" ||
      attachment.r2Key.length === 0 ||
      attachmentKeys.has(attachment.r2Key) ||
      !Number.isSafeInteger(attachment.sizeBytes) ||
      attachment.sizeBytes < 0 ||
      typeof attachment.scanStatus !== "string"
    ) {
      throw new Error("Restored attachments metadata is invalid.");
    }
    attachmentKeys.add(attachment.r2Key);
    if (attachment.sha256 !== null && !isSha256(attachment.sha256)) {
      throw new Error("Restored attachment has an invalid SHA-256 checksum.");
    }

    const object = objectsByKey.get(attachment.r2Key);
    const keySha256 = hashString(attachment.r2Key);
    if (!object) {
      missingObjects.push(keySha256);
      if (attachment.scanStatus === "clean") {
        cleanAttachments += 1;
        cleanChecksumFailures.push(keySha256);
      }
      continue;
    }
    matched += 1;
    if (object.size !== attachment.sizeBytes) {
      sizeMismatches.push(keySha256);
    }

    const attachmentChecksum = normalizeChecksum(attachment.sha256);
    const objectChecksum = normalizeChecksum(object.sha256);
    if (
      attachmentChecksum &&
      objectChecksum &&
      attachmentChecksum !== objectChecksum
    ) {
      checksumMismatches.push(keySha256);
    }
    if (attachment.scanStatus === "clean") {
      cleanAttachments += 1;
      if (
        !attachmentChecksum ||
        !objectChecksum ||
        attachmentChecksum !== objectChecksum
      ) {
        cleanChecksumFailures.push(keySha256);
      } else {
        cleanChecksumsVerified += 1;
      }
    }
  }

  const orphanObjects = inventoryObjects
    .filter((object) => !attachmentKeys.has(object.key))
    .map((object) => hashString(object.key))
    .toSorted();
  const reconciliationClean =
    missingObjects.length === 0 &&
    orphanObjects.length === 0 &&
    sizeMismatches.length === 0 &&
    checksumMismatches.length === 0 &&
    cleanChecksumFailures.length === 0;
  const r2ObjectBytesRestorable = inventoryObjects.length === 0;

  return {
    clean: reconciliationClean && r2ObjectBytesRestorable,
    reconciliationClean,
    r2ObjectBytesRestorable,
    attachmentRows: attachments.length,
    inventoryObjects: inventoryObjects.length,
    matched,
    cleanAttachments,
    cleanChecksumsVerified,
    missingObjects: missingObjects.toSorted(),
    orphanObjects,
    sizeMismatches: sizeMismatches.toSorted(),
    checksumMismatches: checksumMismatches.toSorted(),
    cleanChecksumFailures: cleanChecksumFailures.toSorted(),
  };
}

function isSha256(value) {
  return typeof value === "string" && /^[a-fA-F0-9]{64}$/u.test(value);
}

function normalizeChecksum(value) {
  return isSha256(value) ? value.toLowerCase() : null;
}

function hashString(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashJson(value) {
  return hashString(JSON.stringify(value));
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

function verifyColumns(databaseValue, tables) {
  const query = databaseValue.prepare(`SELECT
      cid,
      name,
      type,
      "notnull" AS "notnull",
      dflt_value,
      pk,
      hidden
    FROM pragma_table_xinfo(?)
    ORDER BY cid`);
  const canonical = (column) => ({
    cid: Number(column.cid),
    name: column.name,
    type: typeof column.type === "string" ? column.type : "",
    notnull: Number(column.notnull),
    dflt_value: column.dflt_value == null ? null : String(column.dflt_value),
    pk: Number(column.pk),
    hidden: Number(column.hidden ?? 0),
  });

  for (const table of tables) {
    const actual = query.all(table.name).map(canonical);
    const expected = table.columns.map(canonical);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(
        `Restored column metadata does not match table ${table.name}.`,
      );
    }
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
