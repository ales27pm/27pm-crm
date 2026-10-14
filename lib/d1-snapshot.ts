import type { CrmDatabase, D1Row } from "./d1";
import { d1BackupSource, type BackupSource } from "./backup-source";

const SCHEMA_SQL = `SELECT type, name, tbl_name AS tableName, sql
  FROM sqlite_schema
  WHERE sql IS NOT NULL
    AND (name NOT LIKE 'sqlite_%' OR name = 'sqlite_sequence')
    AND substr(name, 1, 4) <> '_cf_'
    AND substr(tbl_name, 1, 4) <> '_cf_'
  ORDER BY type, name`;

const TABLE_COLUMNS_SQL = `SELECT
    schema.name AS tableName,
    columns.cid,
    columns.name,
    columns.type,
    columns."notnull" AS "notnull",
    columns.dflt_value,
    columns.pk,
    columns.hidden
  FROM sqlite_schema AS schema
  JOIN pragma_table_xinfo(schema.name) AS columns
  WHERE schema.type = 'table'
    AND schema.sql IS NOT NULL
    AND (schema.name NOT LIKE 'sqlite_%' OR schema.name = 'sqlite_sequence')
    AND substr(schema.name, 1, 4) <> '_cf_'
  ORDER BY schema.name, columns.cid`;

const DISPATCHING_SEND_COMMANDS_SQL = `SELECT COUNT(*) AS count
  FROM send_commands
  WHERE status = 'dispatching'`;

const RESERVED_WEBHOOK_RECEIPTS_SQL = `SELECT COUNT(*) AS count
  FROM webhook_receipts
  WHERE status = 'reserved'`;

export const D1_SNAPSHOT_FORMAT = "27pm-d1-logical-v3";

const TABLE_LIST_SQL = "PRAGMA table_list";
const ROWID_ALIASES = ["rowid", "_rowid_", "oid"] as const;
type RowIdAlias = typeof ROWID_ALIASES[number];

type TableMetadata = {
  name: string;
  type: "table";
  ncol: number;
  wr: 0 | 1;
  strict: 0 | 1;
};

type SchemaObjectRow = {
  type: string;
  name: string;
  tableName: string;
  sql: string;
};

type ColumnRow = {
  tableName?: string;
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden?: number;
};

export type SnapshotCell =
  | null
  | string
  | number
  | { kind: "blob"; base64: string }
  | { kind: "integer"; decimal: string };

export type LogicalD1Snapshot = {
  format: typeof D1_SNAPSHOT_FORMAT;
  startedAt: string;
  completedAt: string;
  source: BackupSource;
  quickCheck: string[];
  foreignKeyViolations: [];
  quiescence: {
    dispatchingSendCommands: 0;
    reservedWebhookReceipts: 0;
  };
  schemaObjects: SchemaObjectRow[];
  tables: Array<{
    name: string;
    columns: ColumnRow[];
    rowCount: number;
    rows: SnapshotCell[][];
    rowIds: string[] | null;
    rowIdAlias: RowIdAlias | null;
  }>;
};

export async function buildLogicalD1Snapshot(
  db: CrmDatabase,
  now: () => Date = () => new Date(),
): Promise<LogicalD1Snapshot> {
  const startedAt = now().toISOString();
  const discovery = await db.prepare(SCHEMA_SQL).all<SchemaObjectRow>();
  if (!discovery.success) throw new Error("D1 schema discovery failed.");

  const discoveredSchema = normalizeSchema(discovery.results);
  const tableNames = discoveredSchema
    .filter((entry) => entry.type === "table")
    .map((entry) => entry.name);
  if (tableNames.length === 0) throw new Error("D1 snapshot found no tables.");

  const [columnDiscovery, tableDiscovery] = await Promise.all([
    db.prepare(TABLE_COLUMNS_SQL).all<ColumnRow>(),
    db.prepare(TABLE_LIST_SQL).all<D1Row>(),
  ]);
  if (!columnDiscovery.success || !tableDiscovery.success) {
    throw new Error("D1 table metadata discovery failed.");
  }
  const discoveredColumns = normalizeTableColumns(columnDiscovery.results, tableNames);
  const discoveredTables = normalizeTableMetadata(tableDiscovery.results, tableNames);
  const plans = tableNames.map((name, index) => {
    const columns = discoveredColumns[index];
    const metadata = discoveredTables[index];
    if (columns.length !== metadata.ncol) {
      throw new Error("D1 table metadata changed during discovery.");
    }
    const names = new Set(columns.map((column) => column.name.toLowerCase()));
    const rowIdAlias = metadata.wr === 1 ? null
      : ROWID_ALIASES.find((alias) => !names.has(alias));
    if (rowIdAlias === undefined) {
      throw new Error("D1 table shadows every implicit rowid alias.");
    }
    let resultAlias = "__27pm_backup_rowid";
    while (names.has(resultAlias.toLowerCase())) resultAlias += "_";
    return { name, columns, rowIdAlias, resultAlias };
  });

  const statements = [
    db.prepare(SCHEMA_SQL),
    db.prepare("PRAGMA foreign_key_check"),
    db.prepare("PRAGMA quick_check"),
    db.prepare(TABLE_COLUMNS_SQL),
    db.prepare(DISPATCHING_SEND_COMMANDS_SQL),
    db.prepare(RESERVED_WEBHOOK_RECEIPTS_SQL),
    db.prepare(TABLE_LIST_SQL),
    ...plans.map(({ name, rowIdAlias, resultAlias }) => db.prepare(rowIdAlias === null
      ? `SELECT * FROM ${quoteIdentifier(name)}`
      : `SELECT *, CAST(${quoteIdentifier(rowIdAlias)} AS TEXT) AS ${quoteIdentifier(resultAlias)} FROM ${quoteIdentifier(name)} ORDER BY ${quoteIdentifier(rowIdAlias)}`)),
    db.prepare(SCHEMA_SQL),
    db.prepare(TABLE_LIST_SQL),
    db.prepare(TABLE_COLUMNS_SQL),
  ];

  const results = await db.batch<D1Row>(statements);
  if (
    results.length !== statements.length ||
    results.some((result) => !result.success || !Array.isArray(result.results))
  ) {
    throw new Error("D1 snapshot transaction failed.");
  }

  const schemaBefore = normalizeSchema(asRows<SchemaObjectRow>(results[0]));
  const schemaAfter = normalizeSchema(asRows<SchemaObjectRow>(results.at(-3)));
  if (
    JSON.stringify(schemaBefore) !== JSON.stringify(discoveredSchema) ||
    JSON.stringify(schemaAfter) !== JSON.stringify(discoveredSchema)
  ) {
    throw new Error("D1 schema changed while the snapshot was captured.");
  }

  const columnsBefore = normalizeTableColumns(asRows<ColumnRow>(results[3]), tableNames);
  const columnsAfter = normalizeTableColumns(asRows<ColumnRow>(results.at(-1)), tableNames);
  const tablesBefore = normalizeTableMetadata(asRows(results[6]), tableNames);
  const tablesAfter = normalizeTableMetadata(asRows(results.at(-2)), tableNames);
  if (
    JSON.stringify(columnsBefore) !== JSON.stringify(discoveredColumns) ||
    JSON.stringify(columnsAfter) !== JSON.stringify(discoveredColumns) ||
    JSON.stringify(tablesBefore) !== JSON.stringify(discoveredTables) ||
    JSON.stringify(tablesAfter) !== JSON.stringify(discoveredTables)
  ) {
    throw new Error("D1 table metadata changed while the snapshot was captured.");
  }

  const foreignKeyViolations = asRows(results[1]);
  if (foreignKeyViolations.length > 0) {
    throw new Error("D1 foreign-key violations prevent a valid snapshot.");
  }

  const quickCheck = asRows(results[2]).flatMap((row) =>
    Object.values(row).map(String),
  );
  if (quickCheck.length === 0 || quickCheck.some((value) => value !== "ok")) {
    throw new Error("D1 quick_check failed.");
  }

  const dispatchingSendCommands = exactCount(
    results[4],
    "dispatching send commands",
  );
  const reservedWebhookReceipts = exactCount(
    results[5],
    "reserved webhook receipts",
  );
  if (dispatchingSendCommands !== 0 || reservedWebhookReceipts !== 0) {
    throw new Error("D1 is not quiescent enough for a pre-deployment snapshot.");
  }

  const tables = plans.map(({ name, columns, rowIdAlias, resultAlias }, tableIndex) => {
    const storedColumns = columns.filter((column) => (column.hidden ?? 0) === 0);
    const sourceRows = asRows(results[7 + tableIndex]);
    const rows = sourceRows.map((row) =>
      storedColumns.map((column) => encodeCell(row[column.name])),
    );
    const rowIds = rowIdAlias === null ? null
      : sourceRows.map((row) => canonicalRowId(row[resultAlias]));
    if (rowIds !== null && new Set(rowIds).size !== rowIds.length) {
      throw new Error("D1 returned duplicate implicit rowids.");
    }
    return { name, columns, rowCount: rows.length, rows, rowIds, rowIdAlias };
  });

  return {
    format: D1_SNAPSHOT_FORMAT,
    startedAt,
    completedAt: now().toISOString(),
    source: d1BackupSource(),
    quickCheck,
    foreignKeyViolations: [],
    quiescence: {
      dispatchingSendCommands: 0,
      reservedWebhookReceipts: 0,
    },
    schemaObjects: discoveredSchema,
    tables,
  };
}

function normalizeTableColumns(rows: ColumnRow[], tableNames: string[]): ColumnRow[][] {
  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const row of rows) {
    if (typeof row.tableName !== "string" || !tableNames.includes(row.tableName)) {
      throw new Error("D1 returned column metadata for an unknown table.");
    }
    const columns = columnsByTable.get(row.tableName) ?? [];
    columns.push(normalizeColumn(row));
    columnsByTable.set(row.tableName, columns);
  }
  return tableNames.map((name) => {
    const columns = columnsByTable.get(name) ?? [];
    if (columns.length === 0) throw new Error("D1 returned no column metadata for a table.");
    return columns;
  });
}

function normalizeTableMetadata(rows: D1Row[], tableNames: string[]): TableMetadata[] {
  const metadata = new Map<string, TableMetadata>();
  for (const row of rows) {
    if (row.schema !== "main" || typeof row.name !== "string" || !tableNames.includes(row.name)) continue;
    if (row.type !== "table") {
      throw new Error("D1 snapshot does not support virtual or shadow tables.");
    }
    if (
      metadata.has(row.name) ||
      typeof row.ncol !== "number" || !Number.isSafeInteger(row.ncol) || row.ncol < 1 ||
      (row.wr !== 0 && row.wr !== 1) ||
      (row.strict !== 0 && row.strict !== 1)
    ) {
      throw new Error("D1 returned invalid table metadata.");
    }
    metadata.set(row.name, {
      name: row.name, type: row.type, ncol: row.ncol, wr: row.wr, strict: row.strict,
    });
  }
  return tableNames.map((name) => {
    const table = metadata.get(name);
    if (!table) throw new Error("D1 returned no table metadata for an exported table.");
    return table;
  });
}

function canonicalRowId(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 20 ||
    !/^(?:0|-?[1-9]\d*)$/u.test(value)
  ) {
    throw new Error("D1 returned a noncanonical implicit rowid.");
  }
  const integer = BigInt(value);
  if (integer < BigInt("-9223372036854775808") || integer > BigInt("9223372036854775807")) {
    throw new Error("D1 returned an implicit rowid outside int64.");
  }
  return value;
}

function exactCount(
  result: { results?: D1Row[] } | undefined,
  label: string,
): number {
  const rows = asRows<{ count?: unknown }>(result);
  const value = rows.length === 1 ? Number(rows[0]?.count) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`D1 returned an invalid count for ${label}.`);
  }
  return value;
}

function normalizeSchema(rows: SchemaObjectRow[]): SchemaObjectRow[] {
  return rows.map((row) => {
    if (
      !row ||
      typeof row.type !== "string" ||
      typeof row.name !== "string" ||
      typeof row.tableName !== "string" ||
      typeof row.sql !== "string"
    ) {
      throw new Error("D1 returned an invalid schema object.");
    }
    return {
      type: row.type,
      name: row.name,
      tableName: row.tableName,
      sql: row.sql,
    };
  });
}

function normalizeColumn(row: ColumnRow): ColumnRow {
  if (!row || typeof row.name !== "string" || !row.name) {
    throw new Error("D1 returned an invalid column definition.");
  }
  return {
    cid: Number(row.cid),
    name: row.name,
    type: typeof row.type === "string" ? row.type : "",
    notnull: Number(row.notnull),
    dflt_value: row.dflt_value == null ? null : String(row.dflt_value),
    pk: Number(row.pk),
    hidden: Number(row.hidden ?? 0),
  };
}

function asRows<T extends D1Row = D1Row>(
  result: { results?: D1Row[] } | undefined,
): T[] {
  return (result?.results ?? []) as T[];
}

function quoteIdentifier(value: string): string {
  if (value.includes("\0")) throw new Error("D1 identifier contains a null byte.");
  return `"${value.replaceAll('"', '""')}"`;
}

function encodeCell(value: unknown): SnapshotCell {
  if (value === null || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("D1 returned a non-finite number.");
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Error("D1 returned an unsafe integer.");
    }
    return value;
  }
  if (typeof value === "bigint") {
    return { kind: "integer", decimal: value.toString(10) };
  }
  if (value instanceof ArrayBuffer) {
    return { kind: "blob", base64: bytesToBase64(new Uint8Array(value)) };
  }
  if (ArrayBuffer.isView(value)) {
    return {
      kind: "blob",
      base64: bytesToBase64(
        new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
      ),
    };
  }
  if (
    Array.isArray(value) &&
    value.every(
      (entry) => Number.isInteger(entry) && Number(entry) >= 0 && Number(entry) <= 255,
    )
  ) {
    return { kind: "blob", base64: bytesToBase64(Uint8Array.from(value)) };
  }
  throw new Error("D1 returned an unsupported cell type.");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 32_768;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}
