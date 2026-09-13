import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationDirectory = new URL("../drizzle/", import.meta.url);

test("migration separates transport IDs and backfills historical Mailgun rows", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationNames = await migrationFileNames();
  const cakemailMigration = migrationNames.at(-1);
  assert.match(cakemailMigration ?? "", /^0014_/u);

  for (const migrationName of migrationNames.slice(0, -1)) {
    await applyMigration(database, migrationName);
  }

  database.prepare(
    "INSERT INTO contacts (id, email) VALUES ('contact-provider-backfill', 'provider@example.com')",
  ).run();
  database.prepare(`INSERT INTO conversations
    (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, last_message_at)
    VALUES ('conversation-provider-backfill', 'mailbox_bonjour',
      'contact-provider-backfill', 'Provider', 'provider', 'provider:backfill',
      '2026-09-12T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, external_message_id, sender,
     status, occurred_at)
    VALUES ('message-provider-backfill', 'conversation-provider-backfill',
      'mailbox_bonjour', 'outbound', 'legacy@27pm.org', 'bonjour@27pm.org',
      'accepted', '2026-09-12T00:00:00.000Z')`).run();
  database.prepare(`INSERT INTO send_commands
    (id, idempotency_key, request_hash, mailbox_id, conversation_id, status,
     provider_message_id)
    VALUES ('command-provider-backfill', 'provider-backfill-key', 'hash',
      'mailbox_bonjour', 'conversation-provider-backfill', 'sent',
      'legacy@27pm.org')`).run();
  database.prepare(`INSERT INTO message_events
    (id, message_id, provider_event_id, callback_key, event_type,
     event_timestamp, payload_json)
    VALUES ('event-provider-backfill', 'message-provider-backfill', 'event-1',
      'event:provider-backfill', 'accepted', '2026-09-12T00:00:01.000Z', '{}')`).run();
  database.prepare(`INSERT INTO attachments
    (id, message_id, r2_key, file_name, size_bytes)
    VALUES ('attachment-provider-backfill', 'message-provider-backfill',
      'provider/backfill.txt', 'backfill.txt', 8)`).run();
  database.prepare(`INSERT INTO webhook_receipts
    (kind, signature_token, signature_timestamp, callback_key)
    VALUES ('event', 'provider-backfill-token', 1789164001,
      'event:provider-backfill')`).run();

  database.exec("BEGIN");
  try {
    await applyMigration(database, cakemailMigration);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  assert.deepEqual(
    plain(database.prepare(`SELECT transport_provider AS provider,
      provider_message_id AS providerMessageId,
      external_message_id AS externalMessageId
      FROM messages WHERE id='message-provider-backfill'`).get()),
    {
      provider: "mailgun",
      providerMessageId: "legacy@27pm.org",
      externalMessageId: "legacy@27pm.org",
    },
  );
  assert.deepEqual(
    plain(database.prepare(`SELECT transport_provider AS provider,
      provider_message_id AS providerMessageId,
      external_message_id AS externalMessageId,
      message_snapshot_json AS messageSnapshotJson
      FROM send_commands WHERE id='command-provider-backfill'`).get()),
    {
      provider: "mailgun",
      providerMessageId: "legacy@27pm.org",
      externalMessageId: "legacy@27pm.org",
      messageSnapshotJson: null,
    },
  );
  assert.deepEqual(
    plain(database.prepare(`SELECT transport_provider AS provider,
      provider_message_id AS providerMessageId,
      message_id AS messageId
      FROM message_events WHERE id='event-provider-backfill'`).get()),
    {
      provider: "mailgun",
      providerMessageId: null,
      messageId: "message-provider-backfill",
    },
  );
  assert.equal(
    database
      .prepare("PRAGMA table_info('message_events')")
      .all()
      .some(({ name }) => name === "provider_message_id"),
    true,
  );
  assert.deepEqual(
    database
      .prepare("PRAGMA index_info('message_events_provider_message_idx')")
      .all()
      .map(({ name }) => name),
    ["transport_provider", "provider_message_id", "message_id"],
  );
  assert.match(
    database
      .prepare(
        `EXPLAIN QUERY PLAN
         UPDATE message_events
         SET message_id = ?
         WHERE transport_provider = 'cakemail'
           AND provider_message_id = ?
           AND message_id IS NULL`,
      )
      .all("message-provider-backfill", "provider-message-id")
      .map(({ detail }) => detail)
      .join("\n"),
    /USING (?:COVERING )?INDEX message_events_provider_message_idx/u,
  );
  assert.equal(
    database.prepare("SELECT message_id FROM attachments WHERE id='attachment-provider-backfill'").get().message_id,
    "message-provider-backfill",
  );
  assert.equal(
    database.prepare("SELECT transport_provider FROM webhook_receipts WHERE signature_token='provider-backfill-token'").get().transport_provider,
    "mailgun",
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(database.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);

  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, transport_provider,
     provider_message_id, external_message_id, sender, status, occurred_at)
    VALUES ('message-provider-reuse', 'conversation-provider-backfill',
      'mailbox_bonjour', 'outbound', 'cakemail', 'legacy@27pm.org',
      'cakemail-external@27pm.org', 'bonjour@27pm.org', 'accepted',
      '2026-09-12T00:00:02.000Z')`).run();
  database.prepare(`INSERT INTO send_commands
    (id, transport_provider, idempotency_key, request_hash, mailbox_id,
     conversation_id, status, provider_message_id, external_message_id)
    VALUES ('command-provider-reuse', 'cakemail', 'provider-reuse-key', 'hash',
      'mailbox_bonjour', 'conversation-provider-backfill', 'sent',
      'legacy@27pm.org', 'cakemail-external@27pm.org')`).run();
  database.prepare(`INSERT INTO message_events
    (id, transport_provider, provider_message_id, message_id,
     provider_event_id, callback_key, event_type, event_timestamp, payload_json)
    VALUES ('event-provider-reuse', 'cakemail', 'legacy@27pm.org',
      'message-provider-reuse', 'event-1', 'cakemail:event-provider-reuse',
      'accepted', '2026-09-12T00:00:03.000Z', '{}')`).run();

  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM messages WHERE provider_message_id = 'legacy@27pm.org'",
      )
      .get().count,
    2,
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM send_commands WHERE provider_message_id = 'legacy@27pm.org'",
      )
      .get().count,
    2,
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM message_events WHERE provider_event_id = 'event-1'",
      )
      .get().count,
    2,
  );
  const eventIndexes = database
    .prepare("PRAGMA index_list('message_events')")
    .all();
  const commandIndexes = database
    .prepare("PRAGMA index_list('send_commands')")
    .all();
  assert.equal(
    eventIndexes.some(
      ({ name }) => name === "message_events_provider_event_id_unique",
    ),
    false,
  );
  assert.equal(
    commandIndexes.some(
      ({ name }) => name === "send_commands_provider_message_id_unique",
    ),
    false,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);

  database.close();
});

async function migrationFileNames() {
  return (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
}

async function applyMigration(database, migrationName) {
  const migration = await readFile(
    new URL(migrationName, migrationDirectory),
    "utf8",
  );
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim()) database.exec(statement);
  }
}

function plain(value) {
  return value ? { ...value } : null;
}
