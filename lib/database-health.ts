export const DATABASE_HEALTH_TABLES = [
  "messages",
  "send_commands",
  "message_events",
  "webhook_receipts",
] as const;

export type DatabaseHealthTable = (typeof DATABASE_HEALTH_TABLES)[number];

export const MOBILE_AUTH_HEALTH_TABLES = [
  "mobile_authorization_grants",
  "mobile_sessions",
  "mobile_refresh_tokens",
] as const;

export type MobileAuthHealthTable = (typeof MOBILE_AUTH_HEALTH_TABLES)[number];

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

export type MobileAuthIndexEvidence = {
  name: string;
  table: MobileAuthHealthTable;
  unique: boolean;
  partial: boolean;
  columns: string[];
  predicate: string | null;
};

export type MobileAuthForeignKeyEvidence = {
  table: MobileAuthHealthTable;
  from: string;
  targetTable: MobileAuthHealthTable;
  to: string;
  onUpdate: string;
  onDelete: string;
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
  mobileAuthColumns: Record<MobileAuthHealthTable, string[]>;
  mobileAuthIndexes: MobileAuthIndexEvidence[];
  mobileAuthTableSql: Record<MobileAuthHealthTable, string>;
  mobileAuthForeignKeys: MobileAuthForeignKeyEvidence[];
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

const REQUIRED_MOBILE_AUTH_COLUMNS: Readonly<
  Record<MobileAuthHealthTable, readonly string[]>
> = {
  mobile_authorization_grants: [
    "id",
    "code_hash",
    "operator_email",
    "client_id",
    "redirect_uri",
    "code_challenge",
    "scopes",
    "device_name",
    "expires_at",
    "consumed_at",
    "consumed_session_id",
    "created_at",
  ],
  mobile_sessions: [
    "id",
    "authorization_grant_id",
    "operator_email",
    "client_id",
    "device_name",
    "scopes",
    "refresh_token_hash",
    "expires_at",
    "last_refreshed_at",
    "revoked_at",
    "created_at",
    "updated_at",
  ],
  mobile_refresh_tokens: [
    "token_hash",
    "session_id",
    "issued_at",
    "rotated_at",
  ],
};

export const MOBILE_AUTH_INDEX_REQUIREMENTS = [
  {
    table: "mobile_authorization_grants",
    name: "mobile_authorization_grants_code_hash_unique",
    unique: true,
    partial: false,
    columns: ["code_hash"],
  },
  {
    table: "mobile_authorization_grants",
    name: "mobile_authorization_grants_expiry_idx",
    unique: false,
    partial: false,
    columns: ["expires_at"],
  },
  {
    table: "mobile_authorization_grants",
    name: "mobile_authorization_grants_operator_idx",
    unique: false,
    partial: false,
    columns: ["operator_email", "created_at"],
  },
  {
    table: "mobile_sessions",
    name: "mobile_sessions_grant_unique",
    unique: true,
    partial: false,
    columns: ["authorization_grant_id"],
  },
  {
    table: "mobile_sessions",
    name: "mobile_sessions_refresh_hash_unique",
    unique: true,
    partial: false,
    columns: ["refresh_token_hash"],
  },
  {
    table: "mobile_sessions",
    name: "mobile_sessions_operator_idx",
    unique: false,
    partial: false,
    columns: ["operator_email", "created_at"],
  },
  {
    table: "mobile_sessions",
    name: "mobile_sessions_expiry_idx",
    unique: false,
    partial: false,
    columns: ["expires_at", "revoked_at"],
  },
  {
    table: "mobile_refresh_tokens",
    name: "mobile_refresh_tokens_session_idx",
    unique: false,
    partial: false,
    columns: ["session_id", "issued_at"],
  },
  {
    table: "mobile_refresh_tokens",
    name: "mobile_refresh_tokens_one_current",
    unique: true,
    partial: true,
    columns: ["session_id"],
  },
] as const satisfies readonly (Omit<MobileAuthIndexEvidence, "predicate"> & {
  columns: readonly string[];
})[];

const MOBILE_AUTH_FOREIGN_KEY_REQUIREMENTS = [
  {
    table: "mobile_sessions",
    from: "authorization_grant_id",
    targetTable: "mobile_authorization_grants",
    to: "id",
    onUpdate: "NO ACTION",
    onDelete: "RESTRICT",
  },
  {
    table: "mobile_refresh_tokens",
    from: "session_id",
    targetTable: "mobile_sessions",
    to: "id",
    onUpdate: "NO ACTION",
    onDelete: "RESTRICT",
  },
] as const satisfies readonly MobileAuthForeignKeyEvidence[];

export function buildDatabaseHealthReport(evidence: DatabaseHealthEvidence) {
  const schemaChecks = {
    columns: requiredColumnsArePresent(evidence.columns),
    transportDefaults: transportColumnsAreSafe(evidence.columns),
    indexes: requiredIndexesAreExact(evidence.indexes),
    legacyIndexesRemoved: evidence.forbiddenIndexesPresent.length === 0,
    providerChecks: providerChecksArePresent(evidence.tableSql),
  };
  const migration0014 = Object.values(schemaChecks).every(Boolean);
  const mobileAuthSchemaChecks = {
    columns: MOBILE_AUTH_HEALTH_TABLES.every((table) =>
      containsEvery(
        evidence.mobileAuthColumns[table],
        REQUIRED_MOBILE_AUTH_COLUMNS[table],
      ),
    ),
    indexes: MOBILE_AUTH_INDEX_REQUIREMENTS.every((requirement) => {
      const actual = evidence.mobileAuthIndexes.find(
        ({ name, table }) =>
          name === requirement.name && table === requirement.table,
      );
      return (
        actual?.unique === requirement.unique &&
        actual.partial === requirement.partial &&
        arraysEqual(actual.columns, requirement.columns) &&
        actual.predicate === (
          requirement.name === "mobile_refresh_tokens_one_current"
            ? "rotated_at is null"
            : null
        )
      );
    }),
    constraints: mobileAuthConstraintsArePresent(evidence.mobileAuthTableSql),
    foreignKeys: MOBILE_AUTH_FOREIGN_KEY_REQUIREMENTS.every((requirement) =>
      evidence.mobileAuthForeignKeys.some((actual) =>
        actual.table === requirement.table &&
        actual.from === requirement.from &&
        actual.targetTable === requirement.targetTable &&
        actual.to === requirement.to &&
        actual.onUpdate === requirement.onUpdate &&
        actual.onDelete === requirement.onDelete
      ),
    ),
  };
  const migration0017 = Object.values(mobileAuthSchemaChecks).every(Boolean);
  const dataConsistent = Object.values(evidence.violations).every(
    (count) => Number.isSafeInteger(count) && count === 0,
  );
  const healthy =
    evidence.quickCheck.length > 0 &&
    evidence.quickCheck.every((value) => value === "ok") &&
    evidence.foreignKeyViolations === 0 &&
    migration0014 &&
    migration0017 &&
    dataConsistent;

  return {
    status: healthy ? ("ok" as const) : ("degraded" as const),
    healthy,
    quickCheck: evidence.quickCheck,
    foreignKeyViolations: evidence.foreignKeyViolations,
    migration0014,
    migration0017,
    dataConsistent,
    schemaChecks,
    mobileAuthSchemaChecks,
    counts: evidence.counts,
    columns: Object.fromEntries(
      DATABASE_HEALTH_TABLES.map((table) => [
        table,
        (evidence.columns[table] ?? []).map(({ name }) => name),
      ]),
    ),
    indexes: evidence.indexes.map(({ name }) => name),
    mobileAuthIndexes: evidence.mobileAuthIndexes.map(({ name }) => name),
    forbiddenIndexesPresent: evidence.forbiddenIndexesPresent,
    violations: evidence.violations,
  };
}

function containsEvery(
  actual: readonly string[] | undefined,
  required: readonly string[],
): boolean {
  if (!Array.isArray(actual)) return false;
  const values = new Set(actual);
  return required.every((value) => values.has(value));
}

export function normalizeDatabaseIndexPredicate(
  sql: string | null | undefined,
): string | null {
  if (!sql) return null;
  const normalized = sql
    .toLowerCase()
    .replaceAll("`", "")
    .replaceAll('"', "")
    .replace(/\s+/gu, " ")
    .trim();
  const where = normalized.match(/\bwhere\s+(.+)$/u)?.[1]?.trim();
  return where
    ?.replace(/\bmobile_refresh_tokens\./gu, "")
    .replace(/;$/u, "") || null;
}

function mobileAuthConstraintsArePresent(
  tableSql: Record<MobileAuthHealthTable, string>,
): boolean {
  const required: Record<MobileAuthHealthTable, readonly string[]> = {
    mobile_authorization_grants: [
      "mobile_authorization_grants_code_hash_check",
      "mobile_authorization_grants_challenge_check",
      "mobile_authorization_grants_scope_check",
      "check(length(code_hash) = 64 and code_hash not glob '*[^0-9a-f]*')",
      "check(length(code_challenge) = 43 and code_challenge not glob '*[^a-za-z0-9_-]*')",
      "check(scopes = 'crm:dashboard:read crm:work')",
    ],
    mobile_sessions: [
      "mobile_sessions_refresh_hash_check",
      "mobile_sessions_scope_check",
      "check(length(refresh_token_hash) = 64 and refresh_token_hash not glob '*[^0-9a-f]*')",
      "check(scopes = 'crm:dashboard:read crm:work')",
    ],
    mobile_refresh_tokens: [
      "mobile_refresh_tokens_hash_check",
      "check(length(token_hash) = 64 and token_hash not glob '*[^0-9a-f]*')",
    ],
  };
  return MOBILE_AUTH_HEALTH_TABLES.every((table) => {
    const sql = normalizeTableSql(tableSql[table]);
    return required[table].every((fragment) => sql.includes(fragment));
  });
}

function normalizeTableSql(value: string | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replaceAll("`", "")
    .replaceAll('"', "")
    .replace(/\bmobile_(?:authorization_grants|sessions|refresh_tokens)\./gu, "")
    .replace(/\s+/gu, " ")
    .trim();
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
