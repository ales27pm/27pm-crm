import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard exposes exact timestamped delivery events without generic failed", async () => {
  const dashboard = await readFile(
    new URL("../app/api/dashboard/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(dashboard, /FROM message_events me/u);
  assert.match(dashboard, /me\.event_timestamp AS eventTimestamp/u);
  assert.match(dashboard, /me\.rowid AS eventSequence/u);
  assert.match(dashboard, /mailgunReasonFromPayloadJson\(event\.payloadJson\)/u);
  assert.match(dashboard, /deliveryState:\s*deliveryTimeline\.at\(-1\)\?\.state/u);
  assert.match(dashboard, /deliveryEvents:\s*deliveryTimeline\.map/u);
  assert.match(dashboard, /second:\s*"2-digit"/u);
  assert.doesNotMatch(dashboard, /return ["']failed["']/u);
});

test("webhook storage resolves the newest provider timestamp", async () => {
  const store = await readFile(
    new URL("../lib/webhook-store.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    store,
    /reconcileMailgunEventsBestEffort\(db, event\.messageId\)/u,
  );

  const reconciliation = await readFile(
    new URL("../lib/mailgun-event-reconciliation.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    reconciliation,
    /ORDER BY event_timestamp DESC, rowid DESC/u,
  );
  assert.match(reconciliation, /mailgunDeliveryState\(\{/u);
  assert.match(
    reconciliation,
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
