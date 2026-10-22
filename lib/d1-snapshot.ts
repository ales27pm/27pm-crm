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

export const D1_SNAPSHOT_FORMAT = "27pm-d1-logical-v2";

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

  const statements = [
    db.prepare(SCHEMA_SQL),
    db.prepare("PRAGMA foreign_key_check"),
    db.prepare("PRAGMA quick_check"),
    db.prepare(TABLE_COLUMNS_SQL),
    db.prepare(DISPATCHING_SEND_COMMANDS_SQL),
    db.prepare(RESERVED_WEBHOOK_RECEIPTS_SQL),
    ...tableNames.map((name) => db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`)),
    db.prepare(SCHEMA_SQL),
  ];

  const results = await db.batch<D1Row>(statements);
  if (results.length !== statements.length || results.some((result) => !result.success)) {
    throw new Error("D1 snapshot transaction failed.");
  }

  const schemaBefore = normalizeSchema(asRows<SchemaObjectRow>(results[0]));
  const schemaAfter = normalizeSchema(asRows<SchemaObjectRow>(results.at(-1)));
  if (
    JSON.stringify(schemaBefore) !== JSON.stringify(discoveredSchema) ||
    JSON.stringify(schemaAfter) !== JSON.stringify(discoveredSchema)
  ) {
    throw new Error("D1 schema changed while the snapshot was captured.");
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

  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const rawColumn of asRows<ColumnRow>(results[3])) {
    if (typeof rawColumn.tableName !== "string" || !tableNames.includes(rawColumn.tableName)) {
      throw new Error("D1 returned column metadata for an unknown table.");
    }
    const columns = columnsByTable.get(rawColumn.tableName) ?? [];
    columns.push(normalizeColumn(rawColumn));
    columnsByTable.set(rawColumn.tableName, columns);
  }

  const tables = tableNames.map((name, tableIndex) => {
    const columns = columnsByTable.get(name) ?? [];
    if (columns.length === 0) {
      throw new Error("D1 returned no column metadata for a table.");
    }
    const storedColumns = columns.filter((column) => (column.hidden ?? 0) === 0);
    const sourceRows = asRows(results[6 + tableIndex]);
    const rows = sourceRows.map((row) =>
      storedColumns.map((column) => encodeCell(row[column.name])),
    );
    return { name, columns, rowCount: rows.length, rows };
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
