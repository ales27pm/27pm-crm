import { requireOperatorRequest } from "@/lib/api-auth";
import { crmDatabase, type D1Row } from "@/lib/d1";
import {
  buildDatabaseHealthReport,
  DATABASE_HEALTH_FORBIDDEN_INDEXES,
  DATABASE_HEALTH_INDEX_REQUIREMENTS,
  DATABASE_HEALTH_INTEGRITY_QUERIES,
  DATABASE_HEALTH_TABLES,
  type DatabaseColumnEvidence,
  type DatabaseHealthEvidence,
  type DatabaseHealthTable,
  type DatabaseIndexEvidence,
} from "@/lib/database-health";

export const dynamic = "force-dynamic";

const INDEX_TABLES = [
  ...new Set(
    [
      ...DATABASE_HEALTH_INDEX_REQUIREMENTS,
      ...DATABASE_HEALTH_FORBIDDEN_INDEXES,
    ].map(({ table }) => table),
  ),
];

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;

  try {
    const db = crmDatabase();
    const results = await db.batch([
      db.prepare("PRAGMA quick_check"),
      db.prepare("PRAGMA foreign_key_check"),
      ...DATABASE_HEALTH_TABLES.map((table) =>
        db.prepare(`SELECT COUNT(*) AS count FROM ${table}`),
      ),
      ...DATABASE_HEALTH_TABLES.map((table) =>
        db.prepare(`PRAGMA table_info('${table}')`),
      ),
      ...INDEX_TABLES.map((table) =>
        db.prepare(`PRAGMA index_list('${table}')`),
      ),
      ...DATABASE_HEALTH_INDEX_REQUIREMENTS.map(({ name }) =>
        db.prepare(`PRAGMA index_info('${name}')`),
      ),
      db.prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'table'
           AND name IN ('messages','send_commands','message_events','webhook_receipts')`,
      ),
      ...DATABASE_HEALTH_INTEGRITY_QUERIES.map(({ sql }) => db.prepare(sql)),
    ]);
    if (results.some((result) => !result.success)) {
      throw new Error("database_health_query_failed");
    }

    let offset = 0;
    const next = () => results[offset++];
    const quickCheck = rows(next()).flatMap((row) =>
      Object.values(row).map(String),
    );
    const foreignKeyViolations = rows(next()).length;
    const counts = Object.fromEntries(
      DATABASE_HEALTH_TABLES.map((table) => [table, numericCount(next())]),
    ) as Record<DatabaseHealthTable, number>;
    const columns = Object.fromEntries(
      DATABASE_HEALTH_TABLES.map((table) => [table, columnEvidence(next())]),
    ) as Record<DatabaseHealthTable, DatabaseColumnEvidence[]>;
    const indexLists = new Map(
      INDEX_TABLES.map((table) => [table, rows(next())]),
    );
    const indexes: DatabaseIndexEvidence[] =
      DATABASE_HEALTH_INDEX_REQUIREMENTS.map((requirement) => ({
        name: requirement.name,
        table: requirement.table,
        unique: indexIsUnique(
          indexLists.get(requirement.table),
          requirement.name,
        ),
        columns: indexColumns(next()),
      }));
    const forbiddenIndexesPresent = DATABASE_HEALTH_FORBIDDEN_INDEXES.flatMap(
      ({ table, name }) =>
        indexExists(indexLists.get(table), name) ? [name] : [],
    );
    const tableSql = Object.fromEntries(
      rows(next()).flatMap((row) =>
        typeof row.name === "string" && typeof row.sql === "string"
          ? [[row.name, row.sql]]
          : [],
      ),
    ) as Record<DatabaseHealthTable, string>;
    const violations = Object.fromEntries(
      DATABASE_HEALTH_INTEGRITY_QUERIES.map(({ name }) => [
        name,
        numericCount(next()),
      ]),
    );
    if (offset !== results.length) {
      throw new Error("database_health_result_count_invalid");
    }

    const evidence: DatabaseHealthEvidence = {
      quickCheck,
      foreignKeyViolations,
      counts,
      columns,
      indexes,
      forbiddenIndexesPresent,
      tableSql,
      violations,
    };
    const report = buildDatabaseHealthReport(evidence);
    return Response.json(report, {
      status: report.healthy ? 200 : 503,
      headers: noStoreHeaders(),
    });
  } catch {
    return Response.json(
      { status: "degraded", error: "database_health_unavailable" },
      { status: 503, headers: noStoreHeaders() },
    );
  }
}

function rows(result: { results?: D1Row[] } | undefined): D1Row[] {
  return result?.results ?? [];
}

function numericCount(result: { results?: D1Row[] } | undefined): number {
  const value = rows(result)[0]?.count;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("database_health_count_invalid");
  }
  return value;
}

function columnEvidence(
  result: { results?: D1Row[] } | undefined,
): DatabaseColumnEvidence[] {
  return rows(result).flatMap((row) =>
    typeof row.name === "string"
      ? [
          {
            name: row.name,
            notNull: row.notnull === 1,
            defaultValue:
              typeof row.dflt_value === "string" ? row.dflt_value : null,
          },
        ]
      : [],
  );
}

function indexIsUnique(
  indexList: D1Row[] | undefined,
  name: string,
): boolean {
  return (
    indexList?.some((row) => row.name === name && row.unique === 1) ?? false
  );
}

function indexExists(indexList: D1Row[] | undefined, name: string): boolean {
  return indexList?.some((row) => row.name === name) ?? false;
}

function indexColumns(
  result: { results?: D1Row[] } | undefined,
): string[] {
  return rows(result)
    .filter(
      (row): row is D1Row & { name: string; seqno: number } =>
        typeof row.name === "string" && typeof row.seqno === "number",
    )
    .sort((left, right) => left.seqno - right.seqno)
    .map(({ name }) => name);
}

function noStoreHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}
