import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const migrationDirectory = new URL("../drizzle/", import.meta.url);

test("example cleanup is targeted, idempotent and preserves the approved cohort", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await migrate(database, 8);

  seedLiveCleanupTargets(database);
  seedRecordsToKeep(database);

  await migrate(database, 9, 9);
  await migrate(database, 9, 9);

  assert.deepEqual(
    database
      .prepare(
        `SELECT name FROM organizations
         WHERE external_key LIKE 'initial-cohort:%'
         ORDER BY sort_order`,
      )
      .all()
      .map((row) => row.name),
    [
      "S.Huot",
      "JAMEC",
      "Vallée",
      "Machineries Pronovost",
      "Groupe Industriel Interprovincial",
    ],
  );
  assert.equal(count(database, "conversations", "id LIKE 'conversation-cohort-%'"), 5);
  assert.equal(count(database, "deals", "id LIKE 'deal-cohort-%'"), 5);
  assert.equal(count(database, "tasks", "id LIKE 'task-cohort-%'"), 5);

  for (const [table, id] of [
    ["contacts", "contact-keep"],
    ["contact_channel_compliance", "channel-keep"],
    ["conversations", "conversation-keep"],
    ["deals", "deal-keep"],
    ["tasks", "task-keep"],
    ["messages", "message-keep"],
    ["message_events", "event-keep"],
    ["send_commands", "command-keep"],
    ["intake_submissions", "intake-keep"],
  ]) {
    assert.equal(count(database, table, `id='${id}'`), 1, `${table} sentinel`);
  }
  assert.equal(
    count(database, "intake_rate_limits", "bucket_key='bucket-keep'"),
    1,
  );
  assert.equal(
    count(database, "webhook_receipts", "callback_key='event:keep'"),
    1,
  );

  assert.equal(
    count(
      database,
      "conversations",
      "id='074b26ef-9fdf-45da-88c1-61ab8b66c750'",
    ),
    0,
  );
  assert.equal(
    count(
      database,
      "contacts",
      "id='e8bb2c94-054e-4cc1-8c0d-8a1f623bc0fe'",
    ),
    0,
  );
  assert.equal(
    count(
      database,
      "intake_submissions",
      "id='4584286f-68a1-45b4-9e45-3bda5c92b7c8'",
    ),
    0,
  );
  assert.equal(
    database.prepare("PRAGMA foreign_key_check").all().length,
    0,
  );
});

test("cleanup migration never deletes protected or broad business tables", async () => {
  const source = await readFile(
    new URL("../drizzle/0009_remove_examples.sql", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /DELETE FROM `?(organizations|audit_entries|contact_suppressions|mailboxes|account_imports)`?/iu);
  assert.doesNotMatch(source, /DROP TRIGGER/iu);
  assert.match(source, /WHERE `id` IN/iu);
});

async function migrate(database, end, start = 0) {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const name of names) {
    const index = Number(name.slice(0, 4));
    if (index < start || index > end) continue;
    const source = await readFile(new URL(name, migrationDirectory), "utf8");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
}

function seedLiveCleanupTargets(database) {
  database
    .prepare("INSERT INTO contacts (id, email) VALUES (?, ?)")
    .run("e8bb2c94-054e-4cc1-8c0d-8a1f623bc0fe", "qa-contact@example.invalid");
  database
    .prepare(
      `INSERT INTO contact_channel_compliance
        (id, contact_id, channel, address_normalized)
       VALUES (?, ?, 'email', ?)`,
    )
    .run(
      "email:e8bb2c94-054e-4cc1-8c0d-8a1f623bc0fe",
      "e8bb2c94-054e-4cc1-8c0d-8a1f623bc0fe",
      "qa-contact@example.invalid",
    );
  database
    .prepare(
      `INSERT INTO conversations
        (id, mailbox_id, subject, normalized_subject, thread_key, last_message_at)
       VALUES (?, 'mailbox_bonjour', 'Canari', 'canari', ?, ?)`,
    )
    .run(
      "074b26ef-9fdf-45da-88c1-61ab8b66c750",
      "test:cleanup-target",
      "2026-08-28T03:37:14.000Z",
    );
  database
    .prepare(
      "INSERT INTO deals (id, conversation_id) VALUES (?, ?)",
    )
    .run(
      "ff3cb048-1cee-471f-8711-e3fba5964df8",
      "074b26ef-9fdf-45da-88c1-61ab8b66c750",
    );
  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, sender, occurred_at)
       VALUES (?, ?, 'mailbox_bonjour', 'inbound', ?, ?)`,
    )
    .run(
      "9a06b339-7d67-4f07-9517-2b7b405d330c",
      "074b26ef-9fdf-45da-88c1-61ab8b66c750",
      "qa@example.invalid",
      "2026-08-28T03:37:14.000Z",
    );
  database
    .prepare(
      `INSERT INTO message_events
        (id, message_id, callback_key, event_type, event_timestamp, payload_json)
       VALUES (?, ?, ?, 'accepted', ?, '{}')`,
    )
    .run(
      "1f6c73e8-24b9-4832-8e8e-072299c273e2",
      "9a06b339-7d67-4f07-9517-2b7b405d330c",
      "event:cleanup-target",
      "2026-08-28T03:37:14.000Z",
    );
  database
    .prepare(
      `INSERT INTO send_commands
        (id, idempotency_key, request_hash, mailbox_id, conversation_id)
       VALUES (?, ?, ?, 'mailbox_bonjour', ?)`,
    )
    .run(
      "571365bc-11f6-45a5-bf8a-3f4fcc5598b3",
      "cleanup-target-command",
      "hash-cleanup-target",
      "074b26ef-9fdf-45da-88c1-61ab8b66c750",
    );
  database
    .prepare(
      `INSERT INTO intake_rate_limits
        (bucket_key, requester_hash, count, expires_at)
       VALUES (?, ?, 1, ?)`,
    )
    .run(
      "5710fcc1b8906c8bffd9831066d732da58ba1cae1a840875abb2eb8480191ece:1788138000000",
      "5710fcc1b8906c8bffd9831066d732da58ba1cae1a840875abb2eb8480191ece",
      "2026-08-31T01:30:00.000Z",
    );
  database
    .prepare(
      `INSERT INTO intake_submissions
        (id, idempotency_key, requester_hash, origin, organization_name,
         contact_name, contact_email, message)
       VALUES (?, ?, ?, 'https://27pm.org', 'TEST QA 27PM', 'QA', ?, 'Test')`,
    )
    .run(
      "4584286f-68a1-45b4-9e45-3bda5c92b7c8",
      "cleanup-target-intake",
      "5710fcc1b8906c8bffd9831066d732da58ba1cae1a840875abb2eb8480191ece",
      "qa-e2e-20260830@example.invalid",
    );
  database
    .prepare(
      `INSERT INTO webhook_receipts
        (kind, signature_token, signature_timestamp, callback_key, status, processed_at)
       VALUES ('event', ?, 1787881597, ?, 'processed', ?)`,
    )
    .run(
      "cleanup-target-token",
      "event:7f_AXLD5RqOoZNBMDQkhGg",
      "2026-08-28T01:46:38.000Z",
    );
}

function seedRecordsToKeep(database) {
  database
    .prepare("INSERT INTO contacts (id, email) VALUES ('contact-keep', 'keep@example.invalid')")
    .run();
  database
    .prepare(
      `INSERT INTO contact_channel_compliance
        (id, contact_id, channel, address_normalized)
       VALUES ('channel-keep', 'contact-keep', 'email', 'keep@example.invalid')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO conversations
        (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, last_message_at)
       VALUES ('conversation-keep', 'mailbox_bonjour', 'contact-keep',
               'Keep', 'keep', 'test:keep', '2026-08-30T12:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      "INSERT INTO deals (id, conversation_id) VALUES ('deal-keep', 'conversation-keep')",
    )
    .run();
  database
    .prepare(
      `INSERT INTO tasks (id, conversation_id, deal_id, title, contact_action)
       VALUES ('task-keep', 'conversation-keep', 'deal-keep', 'Keep', 0)`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, sender, occurred_at)
       VALUES ('message-keep', 'conversation-keep', 'mailbox_bonjour',
               'inbound', 'keep@example.invalid', '2026-08-30T12:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO message_events
        (id, message_id, callback_key, event_type, event_timestamp, payload_json)
       VALUES ('event-keep', 'message-keep', 'event:keep-message', 'accepted',
               '2026-08-30T12:00:00.000Z', '{}')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO send_commands
        (id, idempotency_key, request_hash, mailbox_id, conversation_id)
       VALUES ('command-keep', 'command-keep-key', 'command-keep-hash',
               'mailbox_bonjour', 'conversation-keep')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO intake_rate_limits
        (bucket_key, requester_hash, count, expires_at)
       VALUES ('bucket-keep', 'hash-keep', 1, '2026-09-01T00:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO intake_submissions
        (id, idempotency_key, requester_hash, origin, organization_name,
         contact_name, contact_email, message)
       VALUES ('intake-keep', 'intake-keep-key', 'hash-keep',
               'https://27pm.org', 'Keep', 'Keep', 'keep@example.invalid', 'Keep')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO webhook_receipts
        (kind, signature_token, signature_timestamp, callback_key)
       VALUES ('event', 'token-keep', 1788138000, 'event:keep')`,
    )
    .run();
}

function count(database, table, where) {
  return database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`)
    .get().count;
}
