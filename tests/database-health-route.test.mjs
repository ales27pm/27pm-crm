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
  assert.match(source, /sqlite_schema/u);
  assert.match(source, /DATABASE_HEALTH_INTEGRITY_QUERIES/u);
  assert.equal(
    DATABASE_HEALTH_INTEGRITY_QUERIES.some(
      ({ name }) => name === "eventMessageProviderMismatches",
    ),
    true,
  );
  assert.match(source, /DATABASE_HEALTH_FORBIDDEN_INDEXES/u);
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

test("database health accepts complete migration 0014 evidence", () => {
  const report = buildDatabaseHealthReport(healthyEvidence());
  assert.equal(report.status, "ok");
  assert.equal(report.migration0014, true);
  assert.equal(report.dataConsistent, true);
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
