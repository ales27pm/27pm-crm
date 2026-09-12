import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("deliverability endpoint is operator-only, no-store, bounded, and never selects raw payloads", async () => {
  const source = await readFile(
    new URL("../app/api/admin/deliverability/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /requireOperatorRequest\(request\)/u);
  assert.match(source, /cache-control": "private, no-store"/u);
  assert.match(source, /MESSAGE_LIMIT = 10_000/u);
  assert.match(source, /EVENT_LIMIT = 50_000/u);
  assert.doesNotMatch(source, /payload_json AS/u);
  assert.doesNotMatch(source, /recipientsJson[},\s]*\n?\s*summary/u);
  assert.match(source, /Gmail.*sources externes/u);
  assert.match(source, /pas le placement en boîte de réception/u);
});

test("settings exposes provider-segmented transport metrics without claiming inbox placement", async () => {
  const [panel, settings] = await Promise.all([
    readFile(
      new URL("../app/components/deliverability-panel.tsx", import.meta.url),
      "utf8",
    ),
    readFile(
      new URL("../app/components/work-views.tsx", import.meta.url),
      "utf8",
    ),
  ]);
  assert.match(settings, /<DeliverabilityPanel \/>/u);
  assert.match(panel, /24 h/u);
  assert.match(panel, /7 jours/u);
  assert.match(panel, /30 jours/u);
  assert.match(panel, /Une remise SMTP ne prouve ni/u);
  assert.match(panel, /Données insuffisantes/u);
  assert.match(panel, /Tracking ouverture\/clic désactivé/u);
  assert.match(panel, /Segments de tags plafonnés à 256/u);
  assert.doesNotMatch(panel, /payloadJson|recipientsJson/u);
});

test("deliverability migrations add normalized indexed dimensions and safe message taxonomy", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigrations(database);

  assertIncludes(databaseColumns(database, "message_events"), [
    "reason",
    "sending_domain",
    "recipient_domain",
    "mailbox_provider",
    "sending_ip",
    "failure_class",
    "smtp_code",
    "enhanced_status_code",
    "smtp_description",
    "attempt_no",
    "tags_json",
    "campaigns_json",
  ]);
  assertIncludes(databaseIndexes(database, "message_events"), [
    "message_events_provider_timestamp_idx",
    "message_events_ip_timestamp_idx",
    "message_events_failure_timestamp_idx",
  ]);
  assertIncludes(databaseColumns(database, "messages"), [
    "traffic_type",
    "tags_json",
  ]);
});

test("migration 0012 preserves message dependents inside a D1-style transaction", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await applyMigrations(database, (name) => name < "0012_clean_lilandra.sql");
  database.exec(`
    INSERT INTO conversations
      (id, mailbox_id, thread_key, last_message_at)
    VALUES
      ('conversation_migration', 'mailbox_bonjour', 'migration-thread', '2026-09-11T12:00:00Z');
    INSERT INTO messages
      (id, conversation_id, mailbox_id, direction, sender, occurred_at)
    VALUES
      ('message_migration', 'conversation_migration', 'mailbox_bonjour', 'outbound', 'bonjour@27pm.org', '2026-09-11T12:00:00Z');
    INSERT INTO attachments
      (id, message_id, r2_key, file_name, size_bytes)
    VALUES
      ('attachment_migration', 'message_migration', 'migration/object', 'migration.txt', 12);
    INSERT INTO message_events
      (id, message_id, callback_key, event_type, event_timestamp, payload_json)
    VALUES
      ('event_migration', 'message_migration', 'migration-callback', 'accepted', '2026-09-11T12:00:01Z', '{}');
    BEGIN TRANSACTION;
  `);
  try {
    await applyMigrations(
      database,
      (name) => name === "0012_clean_lilandra.sql",
    );
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }

  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    1,
  );
  assert.equal(
    database.prepare("SELECT COUNT(*) AS count FROM attachments").get().count,
    1,
  );
  assert.equal(
    database
      .prepare("SELECT message_id FROM message_events WHERE id = ?")
      .get("event_migration").message_id,
    "message_migration",
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
  assert.throws(
    () =>
      database
        .prepare("UPDATE messages SET traffic_type = ? WHERE id = ?")
        .run("invalid", "message_migration"),
    /CHECK constraint failed/u,
  );
});

async function applyMigrations(database, include = () => true) {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .filter(include)
    .sort();
  for (const migrationName of migrationNames) {
    const migration = await readFile(
      new URL(migrationName, migrationDirectory),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
}

function databaseColumns(database, table) {
  return database
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((column) => column.name);
}

function databaseIndexes(database, table) {
  return database
    .prepare(`PRAGMA index_list(${table})`)
    .all()
    .map((index) => index.name);
}

function assertIncludes(actual, expected) {
  for (const name of expected) {
    assert.ok(actual.includes(name), `missing ${name}`);
  }
}
