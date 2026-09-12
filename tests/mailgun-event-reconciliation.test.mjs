import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  mailgunMessageIdFromPayloadJson,
  reconcileMailgunEventsBestEffort,
  reconcileMailgunEventsForMessage,
} from "../lib/mailgun-event-reconciliation.ts";
import { recordMailgunEvent } from "../lib/mailgun-event-store.ts";
import { markWebhookProcessed, reserveWebhook } from "../lib/webhook-receipts.ts";
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
         sender, recipients_json, status, occurred_at)
       VALUES ('message-race', 'conversation-race', 'mailbox_bonjour',
               'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]', 'accepted',
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
         sender, recipients_json, status, occurred_at)
       VALUES ('message-tie', 'conversation-race', 'mailbox_bonjour',
               'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]', 'accepted',
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
  assert.equal(database.prepare("SELECT do_not_contact AS blocked FROM contacts WHERE id='contact-race'").get().blocked, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contact_suppressions WHERE channel='email' AND address_normalized='race@example.com'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_entries WHERE action='contact.provider_suppressed' AND entity_id='contact-race'").get().count, 1);
  const version = database.prepare("SELECT compliance_version AS version FROM contacts WHERE id='contact-race'").get().version;
  await reconcileMailgunEventsForMessage(db, providerMessageId);
  assert.equal(database.prepare("SELECT compliance_version AS version FROM contacts WHERE id='contact-race'").get().version, version);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_entries WHERE action='contact.provider_suppressed' AND entity_id='contact-race'").get().count, 1);

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

test("provider suppression tombstones the historical recipient without blocking a changed identity", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); seedConversation(database);
  const providerMessageId = "mailgun-historical@example.com";
  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, external_message_id, sender, recipients_json, status, occurred_at)
    VALUES ('message-historical', 'conversation-race', 'mailbox_bonjour', 'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]', 'accepted', '2026-08-25T13:00:00.000Z')`).run(providerMessageId);
  database.prepare("UPDATE contacts SET email='new-race@example.com' WHERE id='contact-race'").run();
  database.prepare(`INSERT INTO message_events (id, message_id, callback_key, event_type, event_timestamp, payload_json)
    VALUES ('event-historical', 'message-historical', 'event:historical', 'complained', '2026-08-25T13:01:00.000Z', ?)`).run(eventPayload(providerMessageId));
  await reconcileMailgunEventsForMessage(d1Adapter(database), providerMessageId);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contact_suppressions WHERE address_normalized='race@example.com'").get().count, 1);
  assert.deepEqual({ ...database.prepare("SELECT email, do_not_contact AS blocked FROM contacts WHERE id='contact-race'").get() }, { email: "new-race@example.com", blocked: 0 });
});

test("suppresses explicit hard-bounce and Mailgun suppression-list signals idempotently", async (t) => {
  const cases = [
    {
      label: "hard bounce",
      reason: "bounce",
      expectedStatus: "bounced",
      expectedReason: "provider_bounce",
      expectedEmailStatus: "bounced",
    },
    {
      label: "suppressed bounce",
      reason: "suppress-bounce",
      expectedStatus: "bounced",
      expectedReason: "provider_bounce",
      expectedEmailStatus: "bounced",
    },
    {
      label: "suppressed complaint",
      reason: "suppress-complaint",
      expectedStatus: "complained",
      expectedReason: "provider_complaint",
      expectedEmailStatus: "unsubscribed",
    },
    {
      label: "suppressed unsubscribe",
      reason: "suppress-unsubscribe",
      expectedStatus: "permanent-failure",
      expectedReason: "provider_unsubscribe",
      expectedEmailStatus: "unsubscribed",
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.label, async (t) => {
      const database = await migratedDatabase();
      t.after(() => database.close());
      seedConversation(database);
      const providerMessageId = `mailgun-${testCase.reason}@example.com`;
      database.prepare(`INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, external_message_id,
         sender, recipients_json, status, occurred_at)
        VALUES ('message-suppression', 'conversation-race', 'mailbox_bonjour',
                'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]',
                'accepted', '2026-08-25T13:00:00.000Z')`).run(providerMessageId);
      database.prepare(`INSERT INTO message_events
        (id, message_id, callback_key, event_type, severity, event_timestamp,
         payload_json)
        VALUES ('event-suppression', 'message-suppression', 'event:suppression',
                'failed', 'permanent', '2026-08-25T13:01:00.000Z', ?)`).run(
        eventPayload(providerMessageId, { reason: testCase.reason }),
      );

      const db = d1Adapter(database);
      const first = await reconcileMailgunEventsForMessage(db, providerMessageId);
      const version = database.prepare(
        "SELECT compliance_version AS version FROM contacts WHERE id='contact-race'",
      ).get().version;
      const second = await reconcileMailgunEventsForMessage(db, providerMessageId);

      assert.equal(first.status, testCase.expectedStatus);
      assert.equal(second.status, testCase.expectedStatus);
      assert.deepEqual(
        { ...database.prepare(
          `SELECT status, reason FROM messages
           JOIN contact_suppressions ON address_normalized='race@example.com'
           WHERE messages.id='message-suppression'`,
        ).get() },
        { status: testCase.expectedStatus, reason: testCase.expectedReason },
      );
      assert.deepEqual(
        { ...database.prepare(
          `SELECT email_status AS emailStatus, do_not_contact AS blocked,
                  unsubscribed_at AS unsubscribedAt
           FROM contacts WHERE id='contact-race'`,
        ).get() },
        {
          emailStatus: testCase.expectedEmailStatus,
          blocked: 1,
          unsubscribedAt:
            testCase.expectedEmailStatus === "unsubscribed"
              ? "2026-08-25T13:01:00.000Z"
              : null,
        },
      );
      assert.equal(
        database.prepare(
          "SELECT COUNT(*) AS count FROM contact_suppressions WHERE address_normalized='race@example.com'",
        ).get().count,
        1,
      );
      assert.equal(
        database.prepare(
          "SELECT COUNT(*) AS count FROM audit_entries WHERE action='contact.provider_suppressed'",
        ).get().count,
        1,
      );
      assert.equal(
        database.prepare(
          "SELECT compliance_version AS version FROM contacts WHERE id='contact-race'",
        ).get().version,
        version,
      );
    });
  }
});

test("does not suppress recipients for permanent provider policy or reputation failures", async (t) => {
  for (const reason of ["espblock", "policy", "generic"]) {
    await t.test(reason, async (t) => {
      const database = await migratedDatabase();
      t.after(() => database.close());
      seedConversation(database);
      const providerMessageId = `mailgun-${reason}@example.com`;
      database.prepare(`INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, external_message_id,
         sender, recipients_json, status, occurred_at)
        VALUES ('message-policy', 'conversation-race', 'mailbox_bonjour',
                'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]',
                'accepted', '2026-08-25T13:00:00.000Z')`).run(providerMessageId);
      database.prepare(`INSERT INTO message_events
        (id, message_id, callback_key, event_type, severity, event_timestamp,
         payload_json)
        VALUES ('event-policy', 'message-policy', 'event:policy', 'failed',
                'permanent', '2026-08-25T13:01:00.000Z', ?)`).run(
        eventPayload(providerMessageId, { reason }),
      );

      const result = await reconcileMailgunEventsForMessage(
        d1Adapter(database),
        providerMessageId,
      );

      assert.equal(result.status, "permanent-failure");
      assert.deepEqual(
        { ...database.prepare(
          `SELECT email_status AS emailStatus, do_not_contact AS blocked,
                  unsubscribed_at AS unsubscribedAt
           FROM contacts WHERE id='contact-race'`,
        ).get() },
        { emailStatus: "unknown", blocked: 0, unsubscribedAt: null },
      );
      assert.equal(
        database.prepare(
          "SELECT COUNT(*) AS count FROM contact_suppressions WHERE address_normalized='race@example.com'",
        ).get().count,
        0,
      );
      assert.equal(
        database.prepare(
          "SELECT COUNT(*) AS count FROM audit_entries WHERE action='contact.provider_suppressed'",
        ).get().count,
        0,
      );
    });
  }
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

test("records normalized event dimensions in their database columns", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedConversation(database);
  const providerMessageId = "mailgun-metadata@example.com";
  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, external_message_id, sender,
     recipients_json, status, occurred_at)
    VALUES ('message-metadata', 'conversation-race', 'mailbox_bonjour',
            'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]',
            'accepted', '2026-08-25T13:00:00.000Z')`).run(providerMessageId);

  const reconciled = [];
  await recordMailgunEvent(
    d1Adapter(database),
    {
      signature: { timestamp: "1", token: "token", signature: "signature" },
      eventId: "provider-metadata",
      eventType: "failed",
      severity: "temporary",
      reason: "espblock",
      recipient: "race@example.com",
      messageId: providerMessageId,
      eventTimestamp: "2026-08-25T13:01:00.000Z",
      raw: { event: "failed", recipient: "race@example.com" },
      sendingDomain: "27pm.org",
      recipientDomain: "example.com",
      mailboxProvider: "other",
      sendingIp: "159.135.228.14",
      failureClass: "policy_block",
      smtpCode: 421,
      enhancedStatusCode: "4.7.0",
      smtpDescription: "Policy block for [email]",
      attemptNo: 2,
      tags: ["crm-prospecting"],
      campaigns: ["run-2026-08"],
    },
    "event:metadata",
    async (_db, externalMessageId) => {
      reconciled.push(externalMessageId);
      return {
        messageId: "message-metadata",
        linkedEvents: 0,
        status: "temporary-failure",
      };
    },
  );

  assert.deepEqual(reconciled, [providerMessageId]);
  assert.deepEqual(
    { ...database.prepare(`SELECT
      message_id AS messageId,
      provider_event_id AS providerEventId,
      callback_key AS callbackKey,
      event_type AS eventType,
      severity,
      reason,
      recipient,
      sending_domain AS sendingDomain,
      recipient_domain AS recipientDomain,
      mailbox_provider AS mailboxProvider,
      sending_ip AS sendingIp,
      failure_class AS failureClass,
      smtp_code AS smtpCode,
      enhanced_status_code AS enhancedStatusCode,
      smtp_description AS smtpDescription,
      attempt_no AS attemptNo,
      tags_json AS tagsJson,
      campaigns_json AS campaignsJson,
      event_timestamp AS eventTimestamp,
      payload_json AS payloadJson
      FROM message_events WHERE callback_key='event:metadata'`).get() },
    {
      messageId: "message-metadata",
      providerEventId: "provider-metadata",
      callbackKey: "event:metadata",
      eventType: "failed",
      severity: "temporary",
      reason: "espblock",
      recipient: "race@example.com",
      sendingDomain: "27pm.org",
      recipientDomain: "example.com",
      mailboxProvider: "other",
      sendingIp: "159.135.228.14",
      failureClass: "policy_block",
      smtpCode: 421,
      enhancedStatusCode: "4.7.0",
      smtpDescription: "Policy block for [email]",
      attemptNo: 2,
      tagsJson: '["crm-prospecting"]',
      campaignsJson: '["run-2026-08"]',
      eventTimestamp: "2026-08-25T13:01:00.000Z",
      payloadJson: '{"event":"failed","recipient":"race@example.com"}',
    },
  );
});

test("a failed webhook reconciliation remains reserved and can resume", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); seedConversation(database);
  const db = d1Adapter(database);
  const providerMessageId = "mailgun-resume@example.com";
  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, external_message_id, sender, recipients_json, status, occurred_at)
    VALUES ('message-resume', 'conversation-race', 'mailbox_bonjour', 'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]', 'accepted', '2026-08-25T13:00:00.000Z')`).run(providerMessageId);
  const callbackKey = "event:resume";
  assert.equal(await reserveWebhook(db, { kind: "event", token: "resume-token", signatureTimestamp: 1, callbackKey }), "accepted");
  const event = { messageId: providerMessageId, eventId: "provider-resume", eventType: "complained", severity: null, recipient: "race@example.com", eventTimestamp: "2026-08-25T13:01:00.000Z", raw: { event: "complained" } };
  await assert.rejects(() => recordMailgunEvent(db, event, callbackKey, async () => { throw new Error("suppression_failed"); }), /suppression_failed/u);
  assert.equal(database.prepare("SELECT status FROM webhook_receipts WHERE callback_key=?").get(callbackKey).status, "reserved");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM message_events WHERE callback_key=?").get(callbackKey).count, 1);
  await recordMailgunEvent(db, event, callbackKey, async () => ({ messageId: "message-resume", linkedEvents: 0, status: "complained" }));
  await markWebhookProcessed(db, callbackKey);
  assert.equal(database.prepare("SELECT status FROM webhook_receipts WHERE callback_key=?").get(callbackKey).status, "processed");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM message_events WHERE callback_key=?").get(callbackKey).count, 1);
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
         sender, recipients_json, status, occurred_at)
       VALUES ('message-cas', 'conversation-race', 'mailbox_bonjour',
               'outbound', ?, 'bonjour@27pm.org', '["race@example.com"]', 'accepted',
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

function eventPayload(providerMessageId, fields = {}) {
  return JSON.stringify({
    ...fields,
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
