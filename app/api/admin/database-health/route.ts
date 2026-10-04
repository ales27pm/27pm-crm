import { requireOperatorRequest } from "@/lib/api-auth";
import { crmDatabase, type D1Row } from "@/lib/d1";
import {
  buildDatabaseHealthReport,
  DATABASE_HEALTH_FORBIDDEN_INDEXES,
  DATABASE_HEALTH_INDEX_REQUIREMENTS,
  DATABASE_HEALTH_INTEGRITY_QUERIES,
  DATABASE_HEALTH_TABLES,
  INTERNAL_API_NONCE_HEALTH_TABLE,
  INTERNAL_API_NONCE_INDEX_REQUIREMENT,
  MOBILE_AUTH_INDEX_REQUIREMENTS,
  MOBILE_AUTH_HEALTH_TABLES,
  normalizeDatabaseIndexPredicate,
  type DatabaseColumnEvidence,
  type DatabaseHealthEvidence,
  type DatabaseHealthTable,
  type DatabaseIndexEvidence,
  type InternalApiNonceColumnEvidence,
  type InternalApiNonceIndexEvidence,
  type MobileAuthIndexEvidence,
  type MobileAuthForeignKeyEvidence,
  type MobileAuthHealthTable,
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
      ...MOBILE_AUTH_HEALTH_TABLES.map((table) =>
        db.prepare(`PRAGMA table_info('${table}')`),
      ),
      ...MOBILE_AUTH_HEALTH_TABLES.map((table) =>
        db.prepare(`PRAGMA index_list('${table}')`),
      ),
      ...MOBILE_AUTH_INDEX_REQUIREMENTS.map(({ name }) =>
        db.prepare(`PRAGMA index_info('${name}')`),
      ),
      db.prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'index' AND name LIKE 'mobile_%'`,
      ),
      db.prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'mobile_%'`,
      ),
      db.prepare("PRAGMA foreign_key_list('mobile_sessions')"),
      db.prepare("PRAGMA foreign_key_list('mobile_refresh_tokens')"),
      db.prepare(`PRAGMA table_info('${INTERNAL_API_NONCE_HEALTH_TABLE}')`),
      db.prepare(`PRAGMA index_list('${INTERNAL_API_NONCE_HEALTH_TABLE}')`),
      db.prepare(
        `PRAGMA index_info('${INTERNAL_API_NONCE_INDEX_REQUIREMENT.name}')`,
      ),
      db.prepare(
        `SELECT name, sql FROM sqlite_schema
         WHERE type = 'table' AND name = '${INTERNAL_API_NONCE_HEALTH_TABLE}'`,
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
    const mobileAuthColumns = Object.fromEntries(
      MOBILE_AUTH_HEALTH_TABLES.map((table) => [
        table,
        rows(next()).flatMap((row) =>
          typeof row.name === "string" ? [row.name] : [],
        ),
      ]),
    ) as Record<MobileAuthHealthTable, string[]>;
    const mobileAuthIndexLists = new Map(
      MOBILE_AUTH_HEALTH_TABLES.map((table) => [table, rows(next())]),
    );
    const mobileAuthIndexColumnEvidence = new Map(
      MOBILE_AUTH_INDEX_REQUIREMENTS.map((requirement) => [
        requirement.name,
        indexColumns(next()),
      ]),
    );
    const mobileAuthIndexSql = new Map(
      rows(next()).flatMap((row) =>
        typeof row.name === "string" && typeof row.sql === "string"
          ? [[row.name, row.sql] as const]
          : [],
      ),
    );
    const mobileAuthIndexes: MobileAuthIndexEvidence[] =
      MOBILE_AUTH_INDEX_REQUIREMENTS.map((requirement) => ({
        name: requirement.name,
        table: requirement.table,
        unique: indexIsUnique(
          mobileAuthIndexLists.get(requirement.table),
          requirement.name,
        ),
        partial: indexIsPartial(
          mobileAuthIndexLists.get(requirement.table),
          requirement.name,
        ),
        columns: mobileAuthIndexColumnEvidence.get(requirement.name) ?? [],
        predicate: normalizeDatabaseIndexPredicate(
          mobileAuthIndexSql.get(requirement.name),
        ),
      }));
    const mobileAuthTableSql = Object.fromEntries(
      rows(next()).flatMap((row) =>
        typeof row.name === "string" && typeof row.sql === "string"
          ? [[row.name, row.sql]]
          : [],
      ),
    ) as Record<MobileAuthHealthTable, string>;
    const mobileAuthForeignKeys: MobileAuthForeignKeyEvidence[] = [
      ...foreignKeyEvidence("mobile_sessions", next()),
      ...foreignKeyEvidence("mobile_refresh_tokens", next()),
    ];
    const internalApiNonceColumns = internalApiNonceColumnEvidence(next());
    const internalApiNonceIndexList = rows(next());
    const internalApiNonceIndexes: InternalApiNonceIndexEvidence[] = [
      {
        name: INTERNAL_API_NONCE_INDEX_REQUIREMENT.name,
        table: INTERNAL_API_NONCE_HEALTH_TABLE,
        unique: indexIsUnique(
          internalApiNonceIndexList,
          INTERNAL_API_NONCE_INDEX_REQUIREMENT.name,
        ),
        partial: indexIsPartial(
          internalApiNonceIndexList,
          INTERNAL_API_NONCE_INDEX_REQUIREMENT.name,
        ),
        columns: indexColumns(next()),
      },
    ];
    const internalApiNonceTableSql =
      rows(next()).find(
        (row) =>
          row.name === INTERNAL_API_NONCE_HEALTH_TABLE &&
          typeof row.sql === "string",
      )?.sql as string | undefined;
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
      mobileAuthColumns,
      mobileAuthIndexes,
      mobileAuthTableSql,
      mobileAuthForeignKeys,
      internalApiNonceColumns,
      internalApiNonceIndexes,
      internalApiNonceTableSql: internalApiNonceTableSql ?? "",
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

function internalApiNonceColumnEvidence(
  result: { results?: D1Row[] } | undefined,
): InternalApiNonceColumnEvidence[] {
  return rows(result).flatMap((row) =>
    typeof row.name === "string" &&
    typeof row.type === "string" &&
    typeof row.pk === "number"
      ? [
          {
            name: row.name,
            type: row.type,
            notNull: row.notnull === 1,
            defaultValue:
              typeof row.dflt_value === "string" ? row.dflt_value : null,
            primaryKeyPosition: row.pk,
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

function indexIsPartial(
  indexList: D1Row[] | undefined,
  name: string,
): boolean {
  return (
    indexList?.some((row) => row.name === name && row.partial === 1) ?? false
  );
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

function foreignKeyEvidence(
  table: MobileAuthHealthTable,
  result: { results?: D1Row[] } | undefined,
): MobileAuthForeignKeyEvidence[] {
  return rows(result).flatMap((row) =>
    typeof row.from === "string" &&
    typeof row.table === "string" &&
    MOBILE_AUTH_HEALTH_TABLES.some((candidate) => candidate === row.table) &&
    typeof row.to === "string" &&
    typeof row.on_update === "string" &&
    typeof row.on_delete === "string"
      ? [
          {
            table,
            from: row.from,
            targetTable: row.table as MobileAuthHealthTable,
            to: row.to,
            onUpdate: row.on_update.trim().toUpperCase(),
            onDelete: row.on_delete.trim().toUpperCase(),
          },
        ]
      : [],
  );
}

function noStoreHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}
