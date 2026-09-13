import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  reconcileCakemailEventsBestEffort,
  recordCakemailEvent,
} from "../lib/cakemail-event-store.ts";
import {
  markWebhookProcessed,
  reserveWebhook,
} from "../lib/webhook-receipts.ts";
import {
  CAKEMAIL_WEBHOOK_MAX_BYTES,
  cakemailProviderMessageIdFromPayloadJson,
  cakemailWebhookCallbackKey,
  cakemailWebhookEventKey,
  parseCakemailWebhookEvent,
  parseCakemailWebhookSecrets,
  verifyCakemailWebhookSignature,
} from "../lib/cakemail-webhook.ts";

const encoder = new TextEncoder();
const secret = "cakemail-test-secret";

function bodyFor(event, data = {}) {
  return JSON.stringify({
    event,
    timestamp: "2026-09-12T12:34:56.000Z",
    event_id: `event-${event}`,
    data: {
      email_id: "7b111111-2222-4333-8444-555555555555",
      email_address: "Person@Outlook.com",
      ...data,
    },
    ignored_future_field: { safely: "ignored" },
  });
}

function bytes(value) {
  return encoder.encode(value);
}

function signature(value, signingSecret = secret) {
  return createHmac("sha256", signingSecret).update(value).digest("base64");
}

test("verifies the Base64 HMAC over exact raw bytes with rotating secrets", async () => {
  const raw = bodyFor("Email.Delivered");
  assert.deepEqual(
    await verifyCakemailWebhookSignature(
      bytes(raw),
      signature(raw),
      ["retiring-secret", secret],
    ),
    { ok: true },
  );
  assert.deepEqual(
    await verifyCakemailWebhookSignature(
      bytes(`${raw}\n`),
      signature(raw),
      [secret],
    ),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    await verifyCakemailWebhookSignature(bytes(raw), "not-base64", [secret]),
    { ok: false, reason: "malformed_signature" },
  );
  assert.deepEqual(
    await verifyCakemailWebhookSignature(bytes(raw), signature(raw), []),
    { ok: false, reason: "missing_secrets" },
  );
});

test("parses a bounded JSON secret rotation set", () => {
  assert.deepEqual(
    parseCakemailWebhookSecrets(
      '{"Email.Delivered":[" current ","previous"]}',
    ),
    { delivered: ["current", "previous"] },
  );
  assert.deepEqual(parseCakemailWebhookSecrets(null), {});
  assert.throws(
    () => parseCakemailWebhookSecrets('{"secret":"wrong-shape"}'),
    /cakemail_webhook_secrets_invalid/u,
  );
  assert.throws(
    () => parseCakemailWebhookSecrets('["valid",42]'),
    /cakemail_webhook_secrets_invalid/u,
  );
  assert.throws(
    () =>
      parseCakemailWebhookSecrets(
        '{"Email.Delivered":["shared"],"Email.Unsubscribed":["shared"]}',
      ),
    /cakemail_webhook_secrets_invalid/u,
  );
  assert.throws(
    () =>
      parseCakemailWebhookSecrets(
        '{"Email.Delivered":["one","two","three"]}',
      ),
    /cakemail_webhook_secrets_invalid/u,
  );
});

test("binds each webhook signature to the event-specific secret", async () => {
  const configured = parseCakemailWebhookSecrets(
    '{"Email.Delivered":["delivered-secret"],"Email.Unsubscribed":["unsubscribe-secret"]}',
  );
  const raw = bodyFor("Email.Unsubscribed");
  const eventKey = cakemailWebhookEventKey(raw);
  assert.equal(eventKey, "unsubscribed");
  assert.deepEqual(
    await verifyCakemailWebhookSignature(
      bytes(raw),
      signature(raw, "delivered-secret"),
      configured[eventKey] ?? [],
    ),
    { ok: false, reason: "invalid_signature" },
  );
  assert.deepEqual(
    await verifyCakemailWebhookSignature(
      bytes(raw),
      signature(raw, "unsubscribe-secret"),
      configured[eventKey] ?? [],
    ),
    { ok: true },
  );
});

test("normalizes only the delivery and suppression events used by the CRM", async (t) => {
  const cases = [
    ["Email.Submitted", {}, "accepted", null, null],
    ["Email.Queued", {}, "accepted", null, null],
    ["Email.Sent", {}, "accepted", null, null],
    ["Email.Delivered", {}, "delivered", null, null],
    ["Email.Rejected", {}, "rejected", "permanent", "other_permanent"],
    ["Email.Error", {}, "failed", null, null],
    ["Email.Error", { severity: "transient" }, "failed", "temporary", "temporary"],
    ["Email.Bounced", { bounce_type: "hard" }, "bounce", "permanent", "hard_bounce"],
    ["Email.Bounced", { bounce_type: "soft" }, "failed", "temporary", "temporary"],
    ["Email.Bounced", { bounce_type: "permanent" }, "failed", null, null],
    ["Email.Bounced", {}, "failed", null, null],
    ["Email.ReportedAsSpam", {}, "complained", null, "complaint"],
    ["Email.Unsubscribed", {}, "unsubscribed", null, "unsubscribe"],
    ["Email.GlobalUnsubscribed", {}, "unsubscribed", null, "unsubscribe"],
  ];

  for (const [source, data, eventType, severity, failureClass] of cases) {
    await t.test(source + JSON.stringify(data), () => {
      const rawBody = bodyFor(source, data);
      const event = parseCakemailWebhookEvent(bytes(rawBody));
      assert.equal(event.eventType, eventType);
      assert.equal(event.severity, severity);
      assert.equal(event.failureClass, failureClass);
      assert.equal(event.providerMessageId, "7b111111-2222-4333-8444-555555555555");
      assert.equal(event.recipient, "person@outlook.com");
      assert.equal(event.recipientDomain, "outlook.com");
      assert.equal(event.mailboxProvider, "microsoft");
      assert.equal(event.eventTimestamp, "2026-09-12T12:34:56.000Z");
      assert.equal(event.rawBody, rawBody);
    });
  }
});

test("an unknown bounce never becomes a hard-bounce suppression signal", () => {
  const event = parseCakemailWebhookEvent(
    bodyFor("Email.Bounced", { reason: "Mailbox response unavailable" }),
  );
  assert.deepEqual(
    {
      eventType: event.eventType,
      severity: event.severity,
      failureClass: event.failureClass,
    },
    { eventType: "failed", severity: null, failureClass: null },
  );
});

test("rejects unsupported events and malformed core identities", () => {
  assert.throws(
    () => parseCakemailWebhookEvent(bodyFor("Email.Opened")),
    /event_unsupported/u,
  );
  assert.throws(
    () => parseCakemailWebhookEvent(bodyFor("Contact.Unsubscribed")),
    /event_unsupported/u,
  );
  assert.throws(
    () =>
      parseCakemailWebhookEvent(
        JSON.stringify({
          event: "Email.Delivered",
          timestamp: "2026-09-12T12:34:56Z",
          data: { email_address: "person@example.com" },
        }),
      ),
    /provider_message_id_invalid/u,
  );
  assert.throws(
    () =>
      parseCakemailWebhookEvent(
        bodyFor("Email.Delivered", { email_address: "not-an-address" }),
      ),
    /recipient_invalid/u,
  );
  assert.throws(
    () =>
      parseCakemailWebhookEvent(
        JSON.stringify({
          event: "Email.Delivered",
          timestamp: "yesterday",
          data: {
            email_id: "provider-id",
            email_address: "person@example.com",
          },
        }),
      ),
    /timestamp_invalid/u,
  );
});

test("normalizes provider UUID casing for callback correlation", () => {
  const rawBody = bodyFor("Email.Delivered", {
    email_id: "7B111111-2222-4333-8444-555555555555",
  });
  assert.equal(
    parseCakemailWebhookEvent(rawBody).providerMessageId,
    "7b111111-2222-4333-8444-555555555555",
  );
  assert.equal(
    cakemailProviderMessageIdFromPayloadJson(rawBody),
    "7b111111-2222-4333-8444-555555555555",
  );
});

test("accepts message_id as the documented provider-id fallback", () => {
  const rawBody = JSON.stringify({
    event: "Delivered",
    timestamp: 1_789_213_296,
    data: {
      message_id: "provider-message-fallback",
      recipient: "person@example.ca",
    },
  });
  const event = parseCakemailWebhookEvent(rawBody);
  assert.equal(event.providerMessageId, "provider-message-fallback");
  assert.equal(
    cakemailProviderMessageIdFromPayloadJson(rawBody),
    "provider-message-fallback",
  );
});

test("deduplicates by SHA-256 of the exact raw body under the Cakemail namespace", async () => {
  const raw = bytes(bodyFor("Email.Delivered"));
  const first = await cakemailWebhookCallbackKey(raw);
  const repeat = await cakemailWebhookCallbackKey(raw);
  const whitespaceVariant = await cakemailWebhookCallbackKey(
    bytes(`${new TextDecoder().decode(raw)}\n`),
  );
  assert.match(first, /^cakemail:[a-f0-9]{64}$/u);
  assert.equal(first, repeat);
  assert.notEqual(first, whitespaceVariant);
});

test("stores raw payload and links only by the Cakemail provider message id", async () => {
  const rawBody = bodyFor("Email.Delivered", {
    campaign_id: "campaign-2026",
  });
  const event = parseCakemailWebhookEvent(rawBody);
  const calls = [];
  const db = fakeDatabase(calls, {
    linkedMessage: {
      id: "message-1",
      externalMessageId: "crm-rfc-id@27pm.org",
    },
  });
  const reconciled = [];

  await recordCakemailEvent(
    db,
    event,
    `cakemail:${"a".repeat(64)}`,
    async (_db, externalMessageId, provider) => {
      reconciled.push([externalMessageId, provider]);
      return { messageId: "message-1", linkedEvents: 0, status: "delivered" };
    },
  );

  const lookup = calls.find((call) => call.sql.includes("FROM messages"));
  assert.match(lookup.sql, /transport_provider = 'cakemail'/u);
  assert.match(lookup.sql, /provider_message_id = \?/u);
  assert.deepEqual(lookup.values, [event.providerMessageId]);
  const insertion = calls.find((call) => call.sql.includes("INSERT OR IGNORE INTO message_events"));
  assert.ok(insertion);
  assert.match(insertion.sql, /transport_provider/u);
  assert.match(insertion.sql, /provider_message_id/u);
  assert.equal(insertion.values[1], event.providerMessageId);
  assert.equal(insertion.values[2], "message-1");
  assert.equal(insertion.values[3], `cakemail:${event.providerEventId}`);
  assert.equal(insertion.values.at(-1), rawBody);
  assert.deepEqual(reconciled, [["crm-rfc-id@27pm.org", "cakemail"]]);
  const repaired = calls.find((call) =>
    call.sql.includes("UPDATE message_events"),
  );
  assert.match(repaired.sql, /provider_message_id = \?/u);
  assert.deepEqual(repaired.values, ["message-1", event.providerMessageId]);
  assert.equal(
    calls.some((call) => call.sql.includes("FROM message_events")),
    false,
  );
});

test("best-effort reconciliation links callbacks that raced the outbound insert", async () => {
  const rawBody = bodyFor("Email.Delivered");
  const event = parseCakemailWebhookEvent(rawBody);
  const calls = [];
  const db = fakeDatabase(calls, {
    linkedMessage: {
      id: "message-race",
      externalMessageId: "crm-race@27pm.org",
    },
  });

  const result = await reconcileCakemailEventsBestEffort(
    db,
    event.providerMessageId,
    "crm-race@27pm.org",
    async (_db, externalMessageId, provider) => {
      assert.deepEqual(
        [externalMessageId, provider],
        ["crm-race@27pm.org", "cakemail"],
      );
      return {
        messageId: "message-race",
        linkedEvents: 0,
        status: "delivered",
      };
    },
  );

  assert.deepEqual(result, {
    messageId: "message-race",
    linkedEvents: 1,
    status: "delivered",
  });
  const update = calls.find((call) => call.sql.includes("UPDATE message_events"));
  assert.deepEqual(update.values, ["message-race", event.providerMessageId]);
  assert.equal(
    calls.some((call) => call.sql.includes("FROM message_events")),
    false,
  );
});

test("indexed reconciliation links only the matching Cakemail provider message", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  const matchingEvent = parseCakemailWebhookEvent(bodyFor("Email.Delivered"));
  const unrelatedEvent = parseCakemailWebhookEvent(
    bodyFor("Email.Sent", {
      email_id: "8c111111-2222-4333-8444-555555555555",
    }),
  );

  await recordCakemailEvent(
    sqliteD1(database),
    matchingEvent,
    `cakemail:${await hashMarker("matching-event")}`,
  );
  await recordCakemailEvent(
    sqliteD1(database),
    unrelatedEvent,
    `cakemail:${await hashMarker("unrelated-event")}`,
  );
  seedOutboundCakemailMessage(database);

  const result = await reconcileCakemailEventsBestEffort(
    sqliteD1(database),
    matchingEvent.providerMessageId,
    "crm-cakemail@27pm.org",
    async () => ({
      messageId: "message-cakemail",
      linkedEvents: 0,
      status: "delivered",
    }),
  );

  assert.deepEqual(result, {
    messageId: "message-cakemail",
    linkedEvents: 1,
    status: "delivered",
  });
  assert.deepEqual(
    database
      .prepare(
        `SELECT provider_message_id AS providerMessageId,
                message_id AS messageId
         FROM message_events
         ORDER BY provider_message_id`,
      )
      .all()
      .map(plain),
    [
      {
        providerMessageId: matchingEvent.providerMessageId,
        messageId: "message-cakemail",
      },
      {
        providerMessageId: unrelatedEvent.providerMessageId,
        messageId: null,
      },
    ],
  );
});

test("a failed Cakemail webhook reconciliation remains reserved and can resume", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOutboundCakemailMessage(database);
  const db = sqliteD1(database);
  const rawBody = bodyFor("Email.ReportedAsSpam");
  const event = parseCakemailWebhookEvent(rawBody);
  const callbackKey = `cakemail:${await hashMarker("reserved-retry")}`;
  const token = `cakemail:${await hashMarker("reserved-retry-token")}`;

  assert.equal(
    await reserveWebhook(db, {
      provider: "cakemail",
      kind: "event",
      token,
      signatureTimestamp: event.signatureTimestamp,
      callbackKey,
    }),
    "accepted",
  );
  await assert.rejects(
    () =>
      recordCakemailEvent(db, event, callbackKey, async () => {
        throw new Error("suppression_failed");
      }),
    /suppression_failed/u,
  );
  assert.equal(
    database
      .prepare(
        "SELECT status FROM webhook_receipts WHERE callback_key = ?",
      )
      .get(callbackKey).status,
    "reserved",
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM message_events WHERE callback_key = ?",
      )
      .get(callbackKey).count,
    1,
  );

  assert.equal(
    await reserveWebhook(db, {
      provider: "cakemail",
      kind: "event",
      token,
      signatureTimestamp: event.signatureTimestamp,
      callbackKey,
    }),
    "accepted",
  );
  await recordCakemailEvent(db, event, callbackKey, async () => ({
    messageId: "message-cakemail",
    linkedEvents: 0,
    status: "complained",
  }));
  await markWebhookProcessed(db, callbackKey);
  assert.equal(
    database
      .prepare(
        "SELECT status FROM webhook_receipts WHERE callback_key = ?",
      )
      .get(callbackKey).status,
    "processed",
  );
  assert.equal(
    database
      .prepare(
        "SELECT COUNT(*) AS count FROM message_events WHERE callback_key = ?",
      )
      .get(callbackKey).count,
    1,
  );
});

test("never interprets Mailgun reason tokens as Cakemail suppressions", async (t) => {
  for (const [source, data] of [
    ["Email.Rejected", { reason: "suppress-bounce" }],
    ["Email.Error", { severity: "permanent", reason: "suppress-bounce" }],
  ]) {
    await t.test(source, async (t) => {
      const database = await migratedDatabase();
      t.after(() => database.close());
      seedOutboundCakemailMessage(database);
      const event = parseCakemailWebhookEvent(bodyFor(source, data));

      await recordCakemailEvent(
        sqliteD1(database),
        event,
        `cakemail:${await hashMarker(source)}`,
      );

      assert.equal(
        database
          .prepare("SELECT status FROM messages WHERE id='message-cakemail'")
          .get().status,
        "permanent-failure",
      );
      assert.equal(
        database
          .prepare("SELECT COUNT(*) AS count FROM contact_suppressions")
          .get().count,
        0,
      );
      assert.deepEqual(
        { ...database.prepare(
          `SELECT do_not_contact AS blocked, email_status AS emailStatus
           FROM contacts WHERE id='contact-cakemail'`,
        ).get() },
        { blocked: 0, emailStatus: "unknown" },
      );
    });
  }
});

test("database reconciliation suppresses only an explicitly hard Cakemail bounce", async (t) => {
  const cases = [
    {
      label: "hard bounce",
      payload: { bounce_type: "hard" },
      expectedStatus: "bounced",
      expectedSuppressions: 1,
    },
    {
      label: "unclassified bounce",
      payload: { reason: "provider did not classify the bounce" },
      expectedStatus: "accepted",
      expectedSuppressions: 0,
    },
  ];

  for (const testCase of cases) {
    await t.test(testCase.label, async (t) => {
      const database = await migratedDatabase();
      t.after(() => database.close());
      seedOutboundCakemailMessage(database);
      const event = parseCakemailWebhookEvent(
        bodyFor("Email.Bounced", testCase.payload),
      );

      await recordCakemailEvent(
        sqliteD1(database),
        event,
        `cakemail:${await hashMarker(testCase.label)}`,
      );

      assert.equal(
        database
          .prepare("SELECT status FROM messages WHERE id='message-cakemail'")
          .get().status,
        testCase.expectedStatus,
      );
      assert.equal(
        database
          .prepare(
            "SELECT COUNT(*) AS count FROM contact_suppressions WHERE address_normalized='person@outlook.com'",
          )
          .get().count,
        testCase.expectedSuppressions,
      );
    });
  }
});

test("the HTTP boundary is 256 KiB, verifies raw signatures, and namespaces receipts", async () => {
  const source = await readFile(
    new URL("../app/api/webhooks/cakemail/events/route.ts", import.meta.url),
    "utf8",
  );
  assert.equal(CAKEMAIL_WEBHOOK_MAX_BYTES, 262_144);
  assert.match(source, /boundedRequest\(request, CAKEMAIL_WEBHOOK_MAX_BYTES\)/u);
  assert.match(source, /X-Cakemail-Signature/u);
  assert.match(source, /CAKEMAIL_WEBHOOK_SECRETS_JSON/u);
  assert.match(source, /provider: "cakemail"/u);
  assert.match(source, /recordCakemailEvent\(db, event, callbackKey\)/u);
});

function fakeDatabase(calls, { linkedMessage = null } = {}) {
  return {
    prepare(sql) {
      let values = [];
      const statement = {
        bind(...nextValues) {
          values = nextValues;
          calls.push({ sql, values });
          return statement;
        },
        async first() {
          return sql.includes("FROM messages") ? linkedMessage : null;
        },
        async all() {
          return { results: [], success: true };
        },
        async run() {
          return { success: true, meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch() {
      return [];
    },
  };
}

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

function seedOutboundCakemailMessage(database) {
  database
    .prepare(
      "INSERT INTO contacts (id, email) VALUES ('contact-cakemail', 'person@outlook.com')",
    )
    .run();
  database
    .prepare(
      `INSERT INTO conversations
        (id, mailbox_id, contact_id, subject, normalized_subject, thread_key,
         last_message_at)
       VALUES ('conversation-cakemail', 'mailbox_bonjour', 'contact-cakemail',
         'Cakemail', 'cakemail', 'cakemail:test',
         '2026-09-12T12:00:00.000Z')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, transport_provider,
         provider_message_id, external_message_id, sender, recipients_json,
         status, occurred_at)
       VALUES ('message-cakemail', 'conversation-cakemail', 'mailbox_bonjour',
         'outbound', 'cakemail', '7b111111-2222-4333-8444-555555555555',
         'crm-cakemail@27pm.org', 'bonjour@27pm.org',
         '["person@outlook.com"]', 'accepted',
         '2026-09-12T12:00:00.000Z')`,
    )
    .run();
}

function sqliteD1(database) {
  return {
    prepare(query) {
      return sqliteStatement(database, query, []);
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function sqliteStatement(database, query, bindings) {
  return {
    bind(...values) {
      return sqliteStatement(database, query, values);
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
      const result = database.prepare(query).run(...bindings);
      return {
        success: true,
        meta: { changes: Number(result.changes) },
      };
    },
  };
}

async function hashMarker(value) {
  const digest = await crypto.subtle.digest("SHA-256", bytes(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function plain(value) {
  return value ? { ...value } : null;
}
