import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  mailgunMessageIdFromPayloadJson,
  reconcileMailgunEventsBestEffort,
  reconcileMailgunEventsForMessage,
} from "../lib/mailgun-event-reconciliation.ts";
import {
  buildDeliveryTimeline,
  mailgunDeliveryState,
} from "../lib/mailgun-lifecycle.ts";

test("reconciles a callback received before its outbound message", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedConversation(database);
  const db = d1Adapter(database);
  const providerMessageId = "mailgun-race@example.com";
  const payloadJson = eventPayload(providerMessageId);

  database
    .prepare(
      `INSERT INTO message_events
        (id, message_id, callback_key, event_type, event_timestamp, payload_json)
       VALUES ('event-delivered', NULL, 'event:delivered-race', 'delivered',
               '2026-08-25T13:01:00.000Z', ?)`,
    )
    .run(payloadJson);

  assert.equal(
    mailgunMessageIdFromPayloadJson(payloadJson),
    providerMessageId,
  );
  assert.deepEqual(
    await reconcileMailgunEventsForMessage(db, providerMessageId),
    { messageId: null, linkedEvents: 0, status: null },
  );

  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, external_message_id,
         sender, status, occurred_at)
       VALUES ('message-race', 'conversation-race', 'mailbox_bonjour',
               'outbound', ?, 'bonjour@27pm.org', 'accepted',
               '2026-08-25T13:00:00.000Z')`,
    )
    .run(providerMessageId);

  assert.deepEqual(
    await reconcileMailgunEventsForMessage(db, `<${providerMessageId}>`),
    { messageId: "message-race", linkedEvents: 1, status: "delivered" },
  );
  assert.deepEqual(
    {
      ...database
        .prepare(
          `SELECT me.message_id AS messageId, m.status
           FROM message_events me
           JOIN messages m ON m.id = me.message_id
           WHERE me.id = 'event-delivered'`,
        )
        .get(),
    },
    { messageId: "message-race", status: "delivered" },
  );
});

test("uses callback insertion order consistently when provider timestamps tie", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedConversation(database);
  const db = d1Adapter(database);
  const providerMessageId = "mailgun-tie@example.com";
  const timestamp = "2026-08-25T13:01:00.000Z";

  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, external_message_id,
         sender, status, occurred_at)
       VALUES ('message-tie', 'conversation-race', 'mailbox_bonjour',
               'outbound', ?, 'bonjour@27pm.org', 'accepted',
               '2026-08-25T13:00:00.000Z')`,
    )
    .run(providerMessageId);
  const insertEvent = database.prepare(
    `INSERT INTO message_events
      (id, message_id, callback_key, event_type, event_timestamp, payload_json)
     VALUES (?, NULL, ?, ?, ?, ?)`,
  );
  insertEvent.run(
    "event-delivered",
    "event:delivered-tie",
    "delivered",
    timestamp,
    eventPayload(providerMessageId),
  );
  insertEvent.run(
    "event-complained",
    "event:complained-tie",
    "complained",
    timestamp,
    eventPayload(providerMessageId),
  );

  const reconciliation = await reconcileMailgunEventsForMessage(
    db,
    providerMessageId,
  );
  assert.equal(reconciliation.linkedEvents, 2);
  assert.equal(reconciliation.status, "complained");
  assert.equal(
    database
      .prepare("SELECT status FROM messages WHERE id = 'message-tie'")
      .get().status,
    "complained",
  );

  const providerEvents = database
    .prepare(
      `SELECT event_type AS eventType, event_timestamp AS occurredAt,
              rowid AS sequence
       FROM message_events
       WHERE message_id = 'message-tie'
       ORDER BY rowid DESC`,
    )
    .all()
    .map((event) => ({
      state: mailgunDeliveryState({ eventType: event.eventType }),
      occurredAt: event.occurredAt,
      sequence: event.sequence,
    }));
  const timeline = buildDeliveryTimeline({
    messageOccurredAt: "2026-08-25T13:00:00.000Z",
    storedState: "complained",
    providerEvents,
  });

  assert.deepEqual(
    timeline.map(({ state }) => state),
    ["accepted", "delivered", "complained"],
  );
  assert.equal(timeline.at(-1)?.state, reconciliation.status);
});

test("a reconciliation failure cannot turn an accepted send into a retryable failure", async () => {
  const failingDb = {
    prepare() {
      throw new Error("database_unavailable");
    },
  };

  assert.equal(
    await reconcileMailgunEventsBestEffort(
      failingDb,
      "accepted-send@example.com",
    ),
    null,
  );

  const sendRoute = await readFile(
    new URL("../app/api/messages/send/route.ts", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(sendRoute, /reconcileMailgunEventsForMessage/u);
  assert.equal(
    sendRoute.match(/await reconcileMailgunEventsBestEffort\(/gu)?.length,
    2,
  );
});

test("a stale reconciler cannot overwrite a concurrently persisted newer event", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedConversation(database);
  const providerMessageId = "mailgun-cas@example.com";

  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, external_message_id,
         sender, status, occurred_at)
       VALUES ('message-cas', 'conversation-race', 'mailbox_bonjour',
               'outbound', ?, 'bonjour@27pm.org', 'accepted',
               '2026-08-25T13:00:00.000Z')`,
    )
    .run(providerMessageId);
  database
    .prepare(
      `INSERT INTO message_events
        (id, message_id, callback_key, event_type, event_timestamp, payload_json)
       VALUES ('event-cas-delivered', 'message-cas', 'event:cas-delivered',
               'delivered', '2026-08-25T13:01:00.000Z', ?)`,
    )
    .run(eventPayload(providerMessageId));

  let interleaved = false;
  const db = d1Adapter(database, {
    beforeStatusCas() {
      interleaved = true;
      database
        .prepare(
          `INSERT INTO message_events
            (id, message_id, callback_key, event_type, event_timestamp, payload_json)
           VALUES ('event-cas-complained', 'message-cas', 'event:cas-complained',
                   'complained', '2026-08-25T13:02:00.000Z', ?)`,
        )
        .run(eventPayload(providerMessageId));
      database
        .prepare(
          "UPDATE messages SET status = 'complained' WHERE id = 'message-cas'",
        )
        .run();
    },
  });

  const reconciliation = await reconcileMailgunEventsForMessage(
    db,
    providerMessageId,
  );

  assert.equal(interleaved, true);
  assert.equal(reconciliation.status, "complained");
  assert.equal(
    database
      .prepare("SELECT status FROM messages WHERE id = 'message-cas'")
      .get().status,
    "complained",
  );
});

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
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
  return database;
}

function seedConversation(database) {
  database
    .prepare(
      "INSERT INTO contacts (id, email) VALUES ('contact-race', 'race@example.com')",
    )
    .run();
  database
    .prepare(
      `INSERT INTO conversations
        (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, last_message_at)
       VALUES ('conversation-race', 'mailbox_bonjour', 'contact-race',
               'Race', 'race', 'race:test', '2026-08-25T13:00:00.000Z')`,
    )
    .run();
}

function eventPayload(providerMessageId) {
  return JSON.stringify({
    message: { headers: { "message-id": `<${providerMessageId}>` } },
  });
}

function d1Adapter(database, hooks = {}) {
  const state = { statusCasIntercepted: false };
  return {
    prepare(query) {
      return preparedQuery(database, query, [], hooks, state);
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function preparedQuery(database, query, bindings, hooks, state) {
  return {
    bind(...values) {
      return preparedQuery(database, query, values, hooks, state);
    },
    async first() {
      return database.prepare(query).get(...bindings) ?? null;
    },
    async all() {
      return {
        results: database.prepare(query).all(...bindings),
        success: true,
      };
    },
    async run() {
      if (
        !state.statusCasIntercepted &&
        query.includes("SELECT COUNT(*) FROM message_events") &&
        hooks.beforeStatusCas
      ) {
        state.statusCasIntercepted = true;
        hooks.beforeStatusCas();
      }
      const result = database.prepare(query).run(...bindings);
      return {
        success: true,
        meta: { changes: Number(result.changes) },
      };
    },
  };
}
