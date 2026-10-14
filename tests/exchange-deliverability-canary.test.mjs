import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  recordExchangeDeliverabilityCanaryResult,
  reserveExchangeDeliverabilityCanary,
} from "../lib/exchange-deliverability-canary.ts";

test("reserves one exact Exchange canary and records acceptance without prospect data", async (t) => {
  const sqlite = canaryDatabase(t);
  const db = d1Adapter(sqlite);
  const reservation = canaryReservation();

  assert.equal(
    await reserveExchangeDeliverabilityCanary(db, reservation),
    true,
  );
  assert.equal(
    await reserveExchangeDeliverabilityCanary(db, {
      ...reservation,
      canaryId: randomUUID(),
      commandId: randomUUID(),
    }),
    false,
  );

  const command = sqlite.prepare(
    `SELECT transport_provider AS provider, status, contact_id AS contactId,
            operator_confirmed_at AS confirmedAt, message_snapshot_json AS snapshot
     FROM send_commands WHERE id=?`,
  ).get(reservation.commandId);
  assert.equal(command.provider, "exchange");
  assert.equal(command.status, "dispatching");
  assert.equal(command.contactId, null);
  assert.ok(command.confirmedAt);
  assert.equal(JSON.parse(command.snapshot).kind, "controlled_deliverability_canary");

  await recordExchangeDeliverabilityCanaryResult(db, {
    ...reservation,
    result: {
      outcome: "accepted",
      providerMessageId: "graph-draft-id",
      providerConversationId: "graph-conversation-id",
    },
  });
  assert.deepEqual(
    { ...sqlite.prepare(
      `SELECT status, provider_message_id AS providerMessageId,
              response_status AS responseStatus, failure_code AS failureCode
       FROM send_commands WHERE id=?`,
    ).get(reservation.commandId) },
    {
      status: "sent",
      providerMessageId: "graph-draft-id",
      responseStatus: 202,
      failureCode: null,
    },
  );
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS total FROM audit_entries").get().total,
    2,
  );
});

test("an uncertain Exchange canary remains non-retryable and dispatching", async (t) => {
  const sqlite = canaryDatabase(t);
  const db = d1Adapter(sqlite);
  const reservation = canaryReservation();
  assert.equal(await reserveExchangeDeliverabilityCanary(db, reservation), true);

  await recordExchangeDeliverabilityCanaryResult(db, {
    ...reservation,
    result: { outcome: "unconfirmed" },
  });
  assert.deepEqual(
    { ...sqlite.prepare(
      `SELECT status, provider_message_id AS providerMessageId,
              response_status AS responseStatus, failure_code AS failureCode
       FROM send_commands WHERE id=?`,
    ).get(reservation.commandId) },
    {
      status: "dispatching",
      providerMessageId: null,
      responseStatus: null,
      failureCode: "transport_outcome_unknown",
    },
  );
  assert.equal(
    await reserveExchangeDeliverabilityCanary(db, {
      ...reservation,
      canaryId: randomUUID(),
      commandId: randomUUID(),
    }),
    false,
  );
});

function canaryReservation() {
  return {
    approvalDigest: "a".repeat(64),
    canaryId: randomUUID(),
    commandId: randomUUID(),
    operator: "operator@example.com",
    recipient: "27pmorg@gmail.com",
    subject: "Validation Exchange 27PM — 2026-10-14",
    text: "Test technique unique.\n\nIdentifiant : canary\nEnvoyé à : now",
    sentAt: "2026-10-14T09:45:00.000Z",
  };
}

function canaryDatabase(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE mailboxes (id TEXT PRIMARY KEY NOT NULL);
    INSERT INTO mailboxes(id) VALUES ('mailbox_alexis');
    CREATE TABLE audit_entries (
      id TEXT PRIMARY KEY NOT NULL,
      actor_email TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      details_json TEXT NOT NULL
    );
    CREATE TRIGGER audit_entries_no_update BEFORE UPDATE ON audit_entries
      BEGIN SELECT RAISE(ABORT, 'audit_entries_are_immutable'); END;
    CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries
      BEGIN SELECT RAISE(ABORT, 'audit_entries_are_immutable'); END;
    CREATE TABLE send_commands (
      id TEXT PRIMARY KEY NOT NULL,
      transport_provider TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      request_hash TEXT NOT NULL,
      mailbox_id TEXT NOT NULL REFERENCES mailboxes(id),
      status TEXT NOT NULL,
      contact_id TEXT,
      authorized_at TEXT,
      dispatched_at TEXT,
      operator_confirmed_at TEXT,
      compliance_snapshot_json TEXT,
      message_snapshot_json TEXT,
      provider_message_id TEXT,
      response_status INTEGER,
      failure_code TEXT,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP NOT NULL
    );
  `);
  return sqlite;
}

function d1Adapter(sqlite) {
  return {
    prepare(sql) {
      return {
        sql,
        values: [],
        bind(...values) {
          return { ...this, values };
        },
      };
    },
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          const result = sqlite.prepare(statement.sql).run(...statement.values);
          return { success: true, meta: { changes: Number(result.changes) } };
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}
