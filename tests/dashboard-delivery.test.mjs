import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DASHBOARD_CONVERSATION_LIMIT,
  DASHBOARD_CONVERSATION_ORDER,
  dashboardConversationScope,
} from "../lib/dashboard-mail-window.ts";

test("dashboard exposes exact timestamped delivery events without generic failed", async () => {
  const dashboard = await readFile(
    new URL("../app/api/dashboard/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(dashboard, /FROM message_events me/u);
  assert.match(dashboard, /me\.event_timestamp AS eventTimestamp/u);
  assert.match(dashboard, /me\.rowid AS eventSequence/u);
  assert.match(dashboard, /me\.transport_provider AS transportProvider/u);
  assert.match(dashboard, /me\.failure_class AS failureClass/u);
  assert.match(dashboard, /providerDeliveryState\(event\.transportProvider/u);
  assert.match(dashboard, /m\.html_body AS htmlBody/u);
  assert.match(dashboard, /messagePresentationBody\(message\)/u);
  assert.match(
    dashboard,
    /m\.transport_provider = me\.transport_provider/u,
  );
  assert.match(dashboard, /deliveryState:\s*deliveryTimeline\.at\(-1\)\?\.state/u);
  assert.match(dashboard, /deliveryEvents:\s*deliveryTimeline\.map/u);
  assert.match(dashboard, /second:\s*"2-digit"/u);
  assert.doesNotMatch(dashboard, /return ["']failed["']/u);
});

test("dashboard reuses the exact visible conversation IDs for messages and events", async () => {
  const dashboard = await readFile(
    new URL("../app/api/dashboard/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    dashboard,
    /const visibleConversationIds = conversations\.results\.map/u,
  );
  assert.match(
    dashboard,
    /const visibleConversationScope = dashboardConversationScope\([\s\S]*visibleConversationIds/u,
  );
  assert.equal(
    (dashboard.match(/WHERE \$\{visibleConversationScope\.sql\}/gu) ?? []).length,
    2,
  );
  assert.match(
    dashboard,
    /lastActivityAt:\s*conversation\.lastMessageAt/u,
  );
});

test("a tied top-100 boundary cannot fetch a different message window", (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      last_message_at TEXT NOT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL
    );
  `);
  const insertConversation = database.prepare(
    "INSERT INTO conversations(id,last_message_at) VALUES(?,?)",
  );
  const insertMessage = database.prepare(
    "INSERT INTO messages(id,conversation_id) VALUES(?,?)",
  );
  for (let index = 0; index < 230; index += 1) {
    const id = `conversation-${String(index).padStart(3, "0")}`;
    const tiedTimestamp = new Date(
      Date.UTC(2026, 9, 1, 0, Math.floor(index / 3)),
    ).toISOString();
    insertConversation.run(id, tiedTimestamp);
    insertMessage.run(`message-${index}`, id);
  }

  const visibleIds = database
    .prepare(
      `SELECT c.id
       FROM conversations c
       ORDER BY ${DASHBOARD_CONVERSATION_ORDER}
       LIMIT ?`,
    )
    .all(DASHBOARD_CONVERSATION_LIMIT)
    .map((row) => row.id);
  const scope = dashboardConversationScope(visibleIds);
  const messageConversationIds = database
    .prepare(
      `SELECT m.conversation_id AS id
       FROM messages m
       WHERE ${scope.sql}
       ORDER BY m.conversation_id`,
    )
    .all(...scope.bindings)
    .map((row) => row.id);

  assert.equal(visibleIds.length, DASHBOARD_CONVERSATION_LIMIT);
  assert.deepEqual(
    new Set(messageConversationIds),
    new Set(visibleIds),
  );
  const emptyScope = dashboardConversationScope([]);
  assert.deepEqual(emptyScope, { sql: "1 = 0", bindings: [] });
  assert.equal(
    database.prepare(`SELECT COUNT(*) AS count FROM messages m WHERE ${emptyScope.sql}`).get().count,
    0,
  );
});

test("webhook storage strictly resolves the newest provider timestamp", async () => {
  const store = await readFile(
    new URL("../lib/mailgun-event-store.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    store,
    /reconcileRecordedEvent\(db, event\.messageId, reconcile\)/u,
  );
  assert.match(store, /await reconcile\(db, externalMessageId\)/u);

  const reconciliation = await readFile(
    new URL("../lib/mailgun-event-reconciliation.ts", import.meta.url),
    "utf8",
  );
  const providerState = await readFile(
    new URL("../lib/outbound-delivery-state.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    reconciliation,
    /ORDER BY event_timestamp DESC, rowid DESC/u,
  );
  assert.match(reconciliation, /providerDeliveryState\(expectedProvider/u);
  assert.match(
    providerState,
    /mailgunDeliveryState\(\{/u,
  );
  assert.match(
    providerState,
    /mailgunReasonFromPayloadJson\(event\.payloadJson\)/u,
  );
});

test("operations connect every required Mailgun webhook to the event endpoint", async () => {
  const operations = await readFile(
    new URL("../docs/operations.md", import.meta.url),
    "utf8",
  );

  for (const event of [
    "accepted",
    "delivered",
    "temporary_fail",
    "permanent_fail",
    "complained",
  ]) {
    assert.ok(operations.includes(`\`${event}\``));
  }
  assert.match(
    operations,
    /https:\/\/crm\.27pm\.org\/api\/webhooks\/mailgun\/events/u,
  );
});
