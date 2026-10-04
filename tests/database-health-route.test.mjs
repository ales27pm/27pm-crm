import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  buildDatabaseHealthReport,
  DATABASE_HEALTH_FORBIDDEN_INDEXES,
  DATABASE_HEALTH_INDEX_REQUIREMENTS,
  DATABASE_HEALTH_INTEGRITY_QUERIES,
  DATABASE_HEALTH_TABLES,
  MOBILE_AUTH_INDEX_REQUIREMENTS,
  normalizeDatabaseIndexPredicate,
} from "../lib/database-health.ts";

function healthyEvidence() {
  return {
    quickCheck: ["ok"],
    foreignKeyViolations: 0,
    counts: Object.fromEntries(
      DATABASE_HEALTH_TABLES.map((table) => [table, 0]),
    ),
    columns: {
      messages: [
        { name: "transport_provider", notNull: true, defaultValue: "'mailgun'" },
        { name: "provider_message_id", notNull: false, defaultValue: null },
      ],
      send_commands: [
        { name: "transport_provider", notNull: true, defaultValue: "'mailgun'" },
        { name: "provider_message_id", notNull: false, defaultValue: null },
        { name: "external_message_id", notNull: false, defaultValue: null },
        { name: "message_snapshot_json", notNull: false, defaultValue: null },
      ],
      message_events: [
        { name: "transport_provider", notNull: true, defaultValue: "'mailgun'" },
        { name: "provider_message_id", notNull: false, defaultValue: null },
        { name: "provider_event_id", notNull: false, defaultValue: null },
      ],
      webhook_receipts: [
        { name: "transport_provider", notNull: true, defaultValue: "'mailgun'" },
      ],
    },
    indexes: DATABASE_HEALTH_INDEX_REQUIREMENTS.map((requirement) => ({
      ...requirement,
      columns: [...requirement.columns],
    })),
    forbiddenIndexesPresent: [],
    tableSql: Object.fromEntries(
      DATABASE_HEALTH_TABLES.map((table) => [
        table,
        `CREATE TABLE ${table} (transport_provider text DEFAULT 'mailgun' NOT NULL CONSTRAINT ${table}_transport_provider_check CHECK (transport_provider in ('mailgun', 'cakemail')))`,
      ]),
    ),
    violations: {
      invalidTransportProviders: 0,
      outboundMessagesMissingProviderId: 0,
      sentCommandsMissingProviderIds: 0,
      eventMessageProviderMismatches: 0,
      cakemailNamespaceMismatches: 0,
    },
    mobileAuthColumns: {
      mobile_authorization_grants: [
        "id", "code_hash", "operator_email", "client_id", "redirect_uri",
        "code_challenge", "scopes", "device_name", "expires_at", "consumed_at",
        "consumed_session_id", "created_at",
      ],
      mobile_sessions: [
        "id", "authorization_grant_id", "operator_email", "client_id", "device_name",
        "scopes", "refresh_token_hash", "expires_at", "last_refreshed_at",
        "revoked_at", "created_at", "updated_at",
      ],
      mobile_refresh_tokens: [
        "token_hash", "session_id", "issued_at", "rotated_at",
      ],
    },
    mobileAuthIndexes: MOBILE_AUTH_INDEX_REQUIREMENTS.map((requirement) => ({
      ...requirement,
      columns: [...requirement.columns],
      predicate: requirement.name === "mobile_refresh_tokens_one_current"
        ? "rotated_at is null"
        : null,
    })),
    mobileAuthTableSql: {
      mobile_authorization_grants: `CREATE TABLE mobile_authorization_grants (
        code_hash text CONSTRAINT mobile_authorization_grants_code_hash_check
          CHECK(length(code_hash) = 64 and code_hash not glob '*[^0-9a-f]*'),
        code_challenge text CONSTRAINT mobile_authorization_grants_challenge_check
          CHECK(length(code_challenge) = 43 and code_challenge not glob '*[^A-Za-z0-9_-]*'),
        scopes text CONSTRAINT mobile_authorization_grants_scope_check
          CHECK(scopes = 'crm:dashboard:read crm:work'))`,
      mobile_sessions: `CREATE TABLE mobile_sessions (
        refresh_token_hash text CONSTRAINT mobile_sessions_refresh_hash_check
          CHECK(length(refresh_token_hash) = 64 and refresh_token_hash not glob '*[^0-9a-f]*'),
        scopes text CONSTRAINT mobile_sessions_scope_check
          CHECK(scopes = 'crm:dashboard:read crm:work'))`,
      mobile_refresh_tokens: `CREATE TABLE mobile_refresh_tokens (
        token_hash text CONSTRAINT mobile_refresh_tokens_hash_check
          CHECK(length(token_hash) = 64 and token_hash not glob '*[^0-9a-f]*'))`,
    },
    mobileAuthForeignKeys: [
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
    ],
  };
}

test("database health is operator-only, read-only, and gathers executable schema evidence", async () => {
  const source = await readFile(
    new URL("../app/api/admin/database-health/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /requireOperatorRequest\(request\)/u);
  assert.match(source, /if \(auth\.response\) return auth\.response/u);
  assert.match(source, /PRAGMA quick_check/u);
  assert.match(source, /PRAGMA foreign_key_check/u);
  assert.match(source, /PRAGMA table_info/u);
  assert.match(source, /PRAGMA index_list/u);
  assert.match(source, /PRAGMA index_info/u);
  assert.match(source, /PRAGMA foreign_key_list/u);
  assert.match(source, /sqlite_schema/u);
  assert.match(source, /DATABASE_HEALTH_INTEGRITY_QUERIES/u);
  assert.equal(
    DATABASE_HEALTH_INTEGRITY_QUERIES.some(
      ({ name }) => name === "eventMessageProviderMismatches",
    ),
    true,
  );
  assert.match(source, /DATABASE_HEALTH_FORBIDDEN_INDEXES/u);
  assert.match(source, /MOBILE_AUTH_HEALTH_TABLES/u);
  assert.match(source, /MOBILE_AUTH_INDEX_REQUIREMENTS/u);
  assert.match(source, /cache-control": "private, no-store"/u);
  assert.doesNotMatch(source, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/iu);
  for (const { sql } of DATABASE_HEALTH_INTEGRITY_QUERIES) {
    assert.match(sql, /^\s*SELECT\b/iu);
    assert.doesNotMatch(
      sql,
      /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/iu,
    );
  }
});

test("database health accepts complete migration 0014 and mobile auth evidence", () => {
  const report = buildDatabaseHealthReport(healthyEvidence());
  assert.equal(report.status, "ok");
  assert.equal(report.migration0014, true);
  assert.equal(report.migration0017, true);
  assert.equal(report.dataConsistent, true);
});

test("database health normalizes the generated partial refresh-token predicate", async () => {
  const migration = await readFile(
    new URL("../drizzle/0017_wonderful_nomad.sql", import.meta.url),
    "utf8",
  );
  assert.equal(
    normalizeDatabaseIndexPredicate(migration),
    "rotated_at is null",
  );
});

test("database health accepts the exact packaged mobile authentication schema", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0015_chief_wilson_fisk.sql",
    "0016_glossy_mongoose.sql",
    "0017_wonderful_nomad.sql",
  ]) {
    const migration = await readFile(new URL(`../drizzle/${name}`, import.meta.url), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }

  const evidence = healthyEvidence();
  evidence.mobileAuthColumns = Object.fromEntries(
    ["mobile_authorization_grants", "mobile_sessions", "mobile_refresh_tokens"]
      .map((table) => [
        table,
        database.prepare(`PRAGMA table_info('${table}')`).all().map(({ name }) => name),
      ]),
  );
  evidence.mobileAuthIndexes = MOBILE_AUTH_INDEX_REQUIREMENTS.map((requirement) => {
    const index = database.prepare(`PRAGMA index_list('${requirement.table}')`)
      .all()
      .find(({ name }) => name === requirement.name);
    const sql = database.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
      .get(requirement.name)?.sql;
    return {
      name: requirement.name,
      table: requirement.table,
      unique: index?.unique === 1,
      partial: index?.partial === 1,
      columns: database.prepare(`PRAGMA index_info('${requirement.name}')`)
        .all()
        .sort((left, right) => left.seqno - right.seqno)
        .map(({ name }) => name),
      predicate: normalizeDatabaseIndexPredicate(sql),
    };
  });
  evidence.mobileAuthTableSql = Object.fromEntries(
    ["mobile_authorization_grants", "mobile_sessions", "mobile_refresh_tokens"]
      .map((table) => [
        table,
        database.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?")
          .get(table).sql,
      ]),
  );
  evidence.mobileAuthForeignKeys = [
    ...database.prepare("PRAGMA foreign_key_list('mobile_sessions')").all()
      .map((row) => ({
        table: "mobile_sessions",
        from: row.from,
        targetTable: row.table,
        to: row.to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      })),
    ...database.prepare("PRAGMA foreign_key_list('mobile_refresh_tokens')").all()
      .map((row) => ({
        table: "mobile_refresh_tokens",
        from: row.from,
        targetTable: row.table,
        to: row.to,
        onUpdate: row.on_update,
        onDelete: row.on_delete,
      })),
  ];

  const report = buildDatabaseHealthReport(evidence);
  assert.equal(report.migration0017, true);
  assert.equal(report.status, "ok");
});

test("database health rejects subtle schema and data drift", () => {
  const cases = [
    (evidence) => {
      evidence.columns.messages[0].notNull = false;
    },
    (evidence) => {
      evidence.columns.send_commands[0].defaultValue = null;
    },
    (evidence) => {
      evidence.indexes[0].columns.reverse();
    },
    (evidence) => {
      evidence.indexes[1].unique = false;
    },
    (evidence) => {
      evidence.forbiddenIndexesPresent.push(
        DATABASE_HEALTH_FORBIDDEN_INDEXES[0].name,
      );
    },
    (evidence) => {
      evidence.tableSql.message_events =
        "CREATE TABLE message_events (transport_provider text)";
    },
    (evidence) => {
      delete evidence.tableSql.webhook_receipts;
    },
    (evidence) => {
      evidence.violations.eventMessageProviderMismatches = 1;
    },
    (evidence) => {
      evidence.mobileAuthColumns.mobile_refresh_tokens.pop();
    },
    (evidence) => {
      evidence.mobileAuthIndexes.at(-1).partial = false;
    },
    (evidence) => {
      evidence.mobileAuthIndexes.at(-1).predicate = "issued_at is null";
    },
    (evidence) => {
      evidence.mobileAuthTableSql.mobile_sessions = "CREATE TABLE mobile_sessions (id text)";
    },
    (evidence) => {
      evidence.mobileAuthForeignKeys.pop();
    },
    (evidence) => {
      evidence.mobileAuthForeignKeys[0].onDelete = "CASCADE";
    },
    (evidence) => {
      evidence.mobileAuthForeignKeys[1].onUpdate = "CASCADE";
    },
  ];

  for (const mutate of cases) {
    const evidence = healthyEvidence();
    mutate(evidence);
    assert.equal(buildDatabaseHealthReport(evidence).status, "degraded");
  }
});

test("Cakemail health rejects missing IDs and non-exact event and receipt namespaces", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE message_events (
        id text PRIMARY KEY,
        transport_provider text NOT NULL,
        provider_message_id text,
        provider_event_id text,
        callback_key text NOT NULL
      );
      CREATE TABLE webhook_receipts (
        id integer PRIMARY KEY,
        transport_provider text NOT NULL,
        signature_token text,
        callback_key text NOT NULL
      );
      INSERT INTO message_events
        (id, transport_provider, provider_message_id, provider_event_id, callback_key)
      VALUES
        ('event', 'cakemail', 'provider-message', 'cakemail:event', 'cakemail:callback');
      INSERT INTO webhook_receipts
        (id, transport_provider, signature_token, callback_key)
      VALUES
        (1, 'cakemail', 'cakemail:token', 'cakemail:callback');
    `);
    const query = DATABASE_HEALTH_INTEGRITY_QUERIES.find(
      ({ name }) => name === "cakemailNamespaceMismatches",
    );
    assert.ok(query);
    const count = () => database.prepare(query.sql).get().count;

    assert.equal(count(), 0);

    const invalidMutations = [
      "UPDATE message_events SET provider_message_id = NULL WHERE id = 'event'",
      "UPDATE message_events SET callback_key = 'CAKEMAIL:callback' WHERE id = 'event'",
      "UPDATE message_events SET provider_event_id = 'CAKEMAIL:event' WHERE id = 'event'",
      "UPDATE webhook_receipts SET signature_token = NULL WHERE id = 1",
      "UPDATE webhook_receipts SET signature_token = 'CAKEMAIL:token' WHERE id = 1",
    ];
    for (const mutation of invalidMutations) {
      database.exec(mutation);
      assert.equal(count(), 1);
      database.exec(`
        UPDATE message_events
        SET provider_message_id = 'provider-message',
            provider_event_id = 'cakemail:event',
            callback_key = 'cakemail:callback'
        WHERE id = 'event';
        UPDATE webhook_receipts
        SET signature_token = 'cakemail:token', callback_key = 'cakemail:callback'
        WHERE id = 1;
      `);
    }
  } finally {
    database.close();
  }
});
