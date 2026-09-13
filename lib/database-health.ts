export const DATABASE_HEALTH_TABLES = [
  "messages",
  "send_commands",
  "message_events",
  "webhook_receipts",
] as const;

export type DatabaseHealthTable = (typeof DATABASE_HEALTH_TABLES)[number];

export type DatabaseColumnEvidence = {
  name: string;
  notNull: boolean;
  defaultValue: string | null;
};

export type DatabaseIndexEvidence = {
  name: string;
  table: DatabaseHealthTable;
  unique: boolean;
  columns: string[];
};

export type DatabaseHealthEvidence = {
  quickCheck: string[];
  foreignKeyViolations: number;
  counts: Record<DatabaseHealthTable, number>;
  columns: Record<DatabaseHealthTable, DatabaseColumnEvidence[]>;
  indexes: DatabaseIndexEvidence[];
  forbiddenIndexesPresent: string[];
  tableSql: Record<DatabaseHealthTable, string>;
  violations: Record<string, number>;
};

export const DATABASE_HEALTH_INDEX_REQUIREMENTS = [
  {
    table: "messages",
    name: "messages_provider_message_unique",
    unique: true,
    columns: ["transport_provider", "provider_message_id"],
  },
  {
    table: "send_commands",
    name: "send_commands_provider_message_unique",
    unique: true,
    columns: ["transport_provider", "provider_message_id"],
  },
  {
    table: "message_events",
    name: "message_events_provider_event_unique",
    unique: true,
    columns: ["transport_provider", "provider_event_id"],
  },
  {
    table: "message_events",
    name: "message_events_provider_message_idx",
    unique: false,
    columns: ["transport_provider", "provider_message_id", "message_id"],
  },
] as const;

export const DATABASE_HEALTH_FORBIDDEN_INDEXES = [
  {
    table: "send_commands",
    name: "send_commands_provider_message_id_unique",
  },
  {
    table: "message_events",
    name: "message_events_provider_event_id_unique",
  },
] as const;

export const DATABASE_HEALTH_INTEGRITY_QUERIES = [
  {
    name: "invalidTransportProviders",
    sql: `SELECT
      (SELECT COUNT(*) FROM messages WHERE transport_provider NOT IN ('mailgun','cakemail')) +
      (SELECT COUNT(*) FROM send_commands WHERE transport_provider NOT IN ('mailgun','cakemail')) +
      (SELECT COUNT(*) FROM message_events WHERE transport_provider NOT IN ('mailgun','cakemail')) +
      (SELECT COUNT(*) FROM webhook_receipts WHERE transport_provider NOT IN ('mailgun','cakemail'))
      AS count`,
  },
  {
    name: "outboundMessagesMissingProviderId",
    sql: `SELECT COUNT(*) AS count FROM messages
      WHERE direction = 'outbound'
        AND (provider_message_id IS NULL OR trim(provider_message_id) = '')`,
  },
  {
    name: "sentCommandsMissingProviderIds",
    sql: `SELECT COUNT(*) AS count FROM send_commands
      WHERE status = 'sent'
        AND (provider_message_id IS NULL OR trim(provider_message_id) = ''
          OR external_message_id IS NULL OR trim(external_message_id) = '')`,
  },
  {
    name: "eventMessageProviderMismatches",
    sql: `SELECT COUNT(*) AS count
      FROM message_events event
      JOIN messages message ON message.id = event.message_id
      WHERE event.transport_provider <> message.transport_provider
        OR (event.provider_message_id IS NOT NULL
          AND message.provider_message_id IS NOT NULL
          AND event.provider_message_id <> message.provider_message_id)`,
  },
  {
    name: "cakemailNamespaceMismatches",
    sql: `SELECT
      (SELECT COUNT(*) FROM message_events
        WHERE transport_provider = 'cakemail'
          AND (provider_message_id IS NULL OR trim(provider_message_id) = ''
            OR callback_key IS NULL OR trim(callback_key) = ''
            OR substr(callback_key, 1, 9) COLLATE BINARY <> 'cakemail:'
            OR (provider_event_id IS NOT NULL
              AND substr(provider_event_id, 1, 9) COLLATE BINARY <> 'cakemail:'))) +
      (SELECT COUNT(*) FROM webhook_receipts
        WHERE transport_provider = 'cakemail'
          AND (callback_key IS NULL OR trim(callback_key) = ''
            OR substr(callback_key, 1, 9) COLLATE BINARY <> 'cakemail:'
            OR signature_token IS NULL OR trim(signature_token) = ''
            OR substr(signature_token, 1, 9) COLLATE BINARY <> 'cakemail:'))
      AS count`,
  },
] as const;

const REQUIRED_COLUMNS: Readonly<
  Record<DatabaseHealthTable, readonly string[]>
> = {
  messages: ["transport_provider", "provider_message_id"],
  send_commands: [
    "transport_provider",
    "provider_message_id",
    "external_message_id",
    "message_snapshot_json",
  ],
  message_events: [
    "transport_provider",
    "provider_message_id",
    "provider_event_id",
  ],
  webhook_receipts: ["transport_provider"],
};

export function buildDatabaseHealthReport(evidence: DatabaseHealthEvidence) {
  const schemaChecks = {
    columns: requiredColumnsArePresent(evidence.columns),
    transportDefaults: transportColumnsAreSafe(evidence.columns),
    indexes: requiredIndexesAreExact(evidence.indexes),
    legacyIndexesRemoved: evidence.forbiddenIndexesPresent.length === 0,
    providerChecks: providerChecksArePresent(evidence.tableSql),
  };
  const migration0014 = Object.values(schemaChecks).every(Boolean);
  const dataConsistent = Object.values(evidence.violations).every(
    (count) => Number.isSafeInteger(count) && count === 0,
  );
  const healthy =
    evidence.quickCheck.length > 0 &&
    evidence.quickCheck.every((value) => value === "ok") &&
    evidence.foreignKeyViolations === 0 &&
    migration0014 &&
    dataConsistent;

  return {
    status: healthy ? ("ok" as const) : ("degraded" as const),
    healthy,
    quickCheck: evidence.quickCheck,
    foreignKeyViolations: evidence.foreignKeyViolations,
    migration0014,
    dataConsistent,
    schemaChecks,
    counts: evidence.counts,
    columns: Object.fromEntries(
      DATABASE_HEALTH_TABLES.map((table) => [
        table,
        (evidence.columns[table] ?? []).map(({ name }) => name),
      ]),
    ),
    indexes: evidence.indexes.map(({ name }) => name),
    forbiddenIndexesPresent: evidence.forbiddenIndexesPresent,
    violations: evidence.violations,
  };
}

function requiredColumnsArePresent(
  columns: DatabaseHealthEvidence["columns"],
): boolean {
  return DATABASE_HEALTH_TABLES.every((table) => {
    const tableColumns = columns[table];
    if (!Array.isArray(tableColumns)) return false;
    const actual = new Set(tableColumns.map(({ name }) => name));
    return REQUIRED_COLUMNS[table].every((name) => actual.has(name));
  });
}

function transportColumnsAreSafe(
  columns: DatabaseHealthEvidence["columns"],
): boolean {
  return DATABASE_HEALTH_TABLES.every((table) => {
    const tableColumns = columns[table];
    if (!Array.isArray(tableColumns)) return false;
    const column = tableColumns.find(
      ({ name }) => name === "transport_provider",
    );
    return (
      column?.notNull === true &&
      (column.defaultValue === "'mailgun'" ||
        column.defaultValue === '"mailgun"')
    );
  });
}

function requiredIndexesAreExact(indexes: DatabaseIndexEvidence[]): boolean {
  return DATABASE_HEALTH_INDEX_REQUIREMENTS.every((requirement) => {
    const actual = indexes.find(
      ({ name, table }) =>
        name === requirement.name && table === requirement.table,
    );
    return (
      actual?.unique === requirement.unique &&
      arraysEqual(actual.columns, requirement.columns)
    );
  });
}

function providerChecksArePresent(
  tableSql: DatabaseHealthEvidence["tableSql"],
): boolean {
  return DATABASE_HEALTH_TABLES.every((table) => {
    const source = tableSql[table];
    if (typeof source !== "string") return false;
    const normalized = source
      .toLowerCase()
      .replaceAll("`", "")
      .replaceAll('"', "")
      .replace(/\s+/gu, " ");
    const constraint = `${table}_transport_provider_check`;
    const providerCheck =
      /check\s*\(\s*transport_provider\s+in\s*\(\s*'mailgun'\s*,\s*'cakemail'\s*\)\s*\)/u;
    return normalized.includes(constraint) && providerCheck.test(normalized);
  });
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}
