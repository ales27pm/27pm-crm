import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { hasWebhookToken, markWebhookProcessed, reserveWebhook } from "../lib/webhook-receipts.ts";

test("generated D1 migration seeds both identities and enforces idempotency", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const migrationName of migrationNames) {
    const migration = await readFile(new URL(migrationName, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }

  assert.deepEqual(
    database
      .prepare(
        "SELECT id, address, purpose FROM mailboxes ORDER BY address",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: "mailbox_admin",
        address: "admin@27pm.org",
        purpose: "operations",
      },
      {
        id: "mailbox_bonjour",
        address: "bonjour@27pm.org",
        purpose: "sales",
      },
    ],
  );

  assert.ok(
    database
      .prepare("PRAGMA table_info(deals)")
      .all()
      .some((column) => column.name === "note" && column.notnull === 1),
  );

  assert.deepEqual(
    database
      .prepare("PRAGMA table_info(credential_handoffs)")
      .all()
      .map((column) => column.name),
    [
      "id",
      "purpose",
      "key_fingerprint",
      "ciphertext",
      "submitted_by",
      "expires_at",
      "consumed_at",
      "created_at",
      "updated_at",
    ],
  );

  const insertReceipt = database.prepare(
    `INSERT INTO webhook_receipts
      (kind, signature_token, signature_timestamp, callback_key)
     VALUES (?, ?, ?, ?)`,
  );
  insertReceipt.run("inbound", "token-one", 1_800_000_000, "inbound:one");
  assert.throws(
    () => insertReceipt.run("event", "token-one", 1_800_000_001, "event:two"),
    /unique constraint failed/i,
  );
  assert.throws(
    () => insertReceipt.run("inbound", "token-two", 1_800_000_002, "inbound:one"),
    /unique constraint failed/i,
  );
  const db = d1Adapter(database);
  assert.equal(await hasWebhookToken(db, "token-one"), false);
  assert.equal(await reserveWebhook(db, { kind: "inbound", token: "token-one", signatureTimestamp: 1_800_000_000, callbackKey: "inbound:one" }), "accepted");
  assert.equal(await reserveWebhook(db, { kind: "inbound", token: "token-retry", signatureTimestamp: 1_800_000_003, callbackKey: "inbound:one" }), "accepted");
  await markWebhookProcessed(db, "inbound:one");
  assert.equal(await hasWebhookToken(db, "token-one"), true);
  assert.equal(await reserveWebhook(db, { kind: "inbound", token: "token-one", signatureTimestamp: 1_800_000_000, callbackKey: "inbound:one" }), "replay");
  assert.equal(await reserveWebhook(db, { kind: "inbound", token: "token-new", signatureTimestamp: 1_800_000_004, callbackKey: "inbound:one" }), "duplicate");

  const insertSendCommand = database.prepare(
    `INSERT INTO send_commands
      (id, idempotency_key, request_hash, mailbox_id)
     VALUES (?, ?, ?, 'mailbox_bonjour')`,
  );
  insertSendCommand.run("command-one", "send:unique:0001", "hash-one");
  assert.throws(
    () => insertSendCommand.run("command-two", "send:unique:0001", "hash-two"),
    /unique constraint failed/i,
  );

  database
    .prepare("INSERT INTO contacts (id, email) VALUES ('contact-events', 'events@example.com')")
    .run();
  database
    .prepare(
      `INSERT INTO conversations
        (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, last_message_at)
       VALUES
        ('conversation-events', 'mailbox_bonjour', 'contact-events', 'Events',
         'events', 'events:test', '2026-08-25T13:00:00.000Z')`,
    )
    .run();
  const insertMessage = database.prepare(
    `INSERT INTO messages
      (id, conversation_id, mailbox_id, direction, sender, status, occurred_at)
     VALUES (?, 'conversation-events', 'mailbox_bonjour', 'outbound',
             'bonjour@27pm.org', ?, '2026-08-25T13:00:00.000Z')`,
  );
  const deliveryStates = [
    "accepted",
    "delivered",
    "bounced",
    "complained",
    "temporary-failure",
    "permanent-failure",
  ];
  for (const [index, status] of deliveryStates.entries()) {
    insertMessage.run(`message-state-${index}`, status);
  }
  assert.throws(
    () => insertMessage.run("message-generic-failed", "failed"),
    /check constraint failed/i,
  );
  assert.deepEqual(
    database
      .prepare(
        "SELECT status FROM messages WHERE id LIKE 'message-state-%' ORDER BY id",
      )
      .all()
      .map((row) => row.status),
    deliveryStates,
  );

  database
    .prepare(
      `INSERT INTO message_events
        (id, message_id, callback_key, event_type, severity,
         event_timestamp, payload_json)
       VALUES
        ('event-delivered', 'message-state-1', 'event:delivered', 'delivered',
         NULL, '2026-08-25T13:01:00.000Z', '{}')`,
    )
    .run();
  assert.equal(
    database
      .prepare(
        "SELECT event_timestamp FROM message_events WHERE id = 'event-delivered'",
      )
      .get().event_timestamp,
    "2026-08-25T13:01:00.000Z",
  );

  database.close();
});

function d1Adapter(database) {
  return { prepare(query) { return preparedQuery(database, query, []); } };
}

function preparedQuery(database, query, bindings) {
  return {
    bind(...values) { return preparedQuery(database, query, values); },
    async first() { return database.prepare(query).get(...bindings) ?? null; },
    async run() { const result = database.prepare(query).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; },
  };
}
