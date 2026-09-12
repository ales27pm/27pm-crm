import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeliveryTimeline,
  DELIVERY_PRESENTATION,
  mailgunDeliveryState,
  mailgunRecipientSuppression,
  mailgunReasonFromPayloadJson,
  OUTBOUND_DELIVERY_STATES,
  storedMessageDeliveryState,
} from "../lib/mailgun-lifecycle.ts";

test("preserves every canonical Mailgun delivery state", async (t) => {
  const cases = [
    [{ eventType: "accepted" }, "accepted"],
    [{ eventType: "delivered" }, "delivered"],
    [{ eventType: "bounced" }, "bounced"],
    [{ eventType: "complained" }, "complained"],
    [
      { eventType: "failed", severity: "temporary" },
      "temporary-failure",
    ],
    [
      { eventType: "failed", severity: "permanent", reason: "generic" },
      "permanent-failure",
    ],
  ];

  for (const [input, expected] of cases) {
    await t.test(expected, () => {
      assert.equal(mailgunDeliveryState(input), expected);
    });
  }
});

test("distinguishes bounce failures from other permanent failures", () => {
  assert.equal(
    mailgunDeliveryState({
      eventType: "FAILED",
      severity: "PERMANENT",
      reason: "bounce",
    }),
    "bounced",
  );
  assert.equal(
    mailgunDeliveryState({
      eventType: "failed",
      severity: "permanent",
      reason: "suppress_bounce",
    }),
    "bounced",
  );
  assert.equal(
    mailgunDeliveryState({ eventType: "permanent_fail", reason: "old" }),
    "permanent-failure",
  );
  assert.equal(
    mailgunDeliveryState({ eventType: "failed", severity: null }),
    null,
  );
  assert.equal(mailgunDeliveryState({ eventType: "opened" }), null);
});

test("derives recipient suppression only from explicit Mailgun signals", () => {
  assert.equal(
    mailgunRecipientSuppression({
      eventType: "failed",
      severity: "permanent",
      reason: "bounce",
    }),
    "bounce",
  );
  assert.equal(
    mailgunRecipientSuppression({
      eventType: "failed",
      severity: "permanent",
      reason: "suppress_bounce",
    }),
    "bounce",
  );
  assert.equal(
    mailgunRecipientSuppression({
      eventType: "failed",
      severity: "permanent",
      reason: "suppress-complaint",
    }),
    "complaint",
  );
  assert.equal(
    mailgunRecipientSuppression({
      eventType: "failed",
      severity: "permanent",
      reason: "suppress_unsubscribe",
    }),
    "unsubscribe",
  );
  assert.equal(
    mailgunRecipientSuppression({ eventType: "complained" }),
    "complaint",
  );
  assert.equal(
    mailgunRecipientSuppression({ eventType: "unsubscribed" }),
    "unsubscribe",
  );
  assert.equal(
    mailgunRecipientSuppression({
      eventType: "failed",
      severity: "permanent",
      reason: "espblock",
    }),
    null,
  );
  assert.equal(
    mailgunRecipientSuppression({
      eventType: "failed",
      severity: "temporary",
      reason: "bounce",
    }),
    null,
  );
});

test("maps suppression-list complaints without mislabeling unsubscribes", () => {
  assert.equal(
    mailgunDeliveryState({
      eventType: "failed",
      severity: "permanent",
      reason: "suppress-complaint",
    }),
    "complained",
  );
  assert.equal(
    mailgunDeliveryState({
      eventType: "failed",
      severity: "permanent",
      reason: "suppress-unsubscribe",
    }),
    "permanent-failure",
  );
});

test("reads the Mailgun reason without exposing malformed payloads", () => {
  assert.equal(
    mailgunReasonFromPayloadJson(JSON.stringify({ reason: "bounce" })),
    "bounce",
  );
  assert.equal(mailgunReasonFromPayloadJson("not-json"), null);
  assert.equal(mailgunReasonFromPayloadJson(JSON.stringify({ reason: 550 })), null);
});

test("builds the lifecycle by provider time rather than callback arrival order", () => {
  const timeline = buildDeliveryTimeline({
    messageOccurredAt: "2026-08-25T13:00:00.000Z",
    storedState: "delivered",
    providerEvents: [
      {
        state: "complained",
        occurredAt: "2026-08-25T13:03:00.000Z",
      },
      {
        state: "delivered",
        occurredAt: "2026-08-25T13:02:00.000Z",
      },
      {
        state: "temporary-failure",
        occurredAt: "2026-08-25T13:01:00.000Z",
      },
    ],
  });

  assert.deepEqual(
    timeline.map((event) => event.state),
    ["accepted", "temporary-failure", "delivered", "complained"],
  );
  assert.equal(timeline.at(-1)?.state, "complained");
});

test("never lets the synthetic accepted event supersede a provider result", () => {
  const timeline = buildDeliveryTimeline({
    messageOccurredAt: "2026-08-25T13:00:01.000Z",
    storedState: "delivered",
    providerEvents: [
      {
        state: "delivered",
        occurredAt: "2026-08-25T13:00:00.500Z",
      },
    ],
  });

  assert.deepEqual(
    timeline.map((event) => event.state),
    ["accepted", "delivered"],
  );
  assert.equal(timeline.at(-1)?.state, "delivered");
});

test("breaks equal provider timestamps by persisted callback sequence", () => {
  const timestamp = "2026-08-25T13:00:00.000Z";
  const timeline = buildDeliveryTimeline({
    messageOccurredAt: timestamp,
    storedState: "complained",
    providerEvents: [
      { state: "complained", occurredAt: timestamp, sequence: 12 },
      { state: "delivered", occurredAt: timestamp, sequence: 11 },
    ],
  });

  assert.deepEqual(
    timeline.map((event) => event.state),
    ["accepted", "delivered", "complained"],
  );
  assert.equal(timeline.at(-1)?.state, "complained");
});

test("keeps stored statuses backward compatible when no event history exists", () => {
  assert.equal(storedMessageDeliveryState("queued", "outbound"), "accepted");
  assert.equal(
    storedMessageDeliveryState("failed", "outbound"),
    "permanent-failure",
  );
  assert.equal(storedMessageDeliveryState("delivered", "inbound"), "received");

  assert.deepEqual(
    buildDeliveryTimeline({
      messageOccurredAt: "2026-08-25T13:00:00.000Z",
      storedState: "bounced",
      providerEvents: [],
    }).map((event) => event.state),
    ["accepted", "bounced"],
  );
});

test("provides operator guidance for every outbound state", () => {
  assert.deepEqual(Object.keys(DELIVERY_PRESENTATION), [
    ...OUTBOUND_DELIVERY_STATES,
  ]);
  for (const state of OUTBOUND_DELIVERY_STATES) {
    assert.ok(DELIVERY_PRESENTATION[state].label.length > 0);
    assert.ok(DELIVERY_PRESENTATION[state].guidance.length > 20);
  }
  assert.match(
    DELIVERY_PRESENTATION.delivered.guidance,
    /serveur du destinataire.*accepté/u,
  );
  assert.match(
    DELIVERY_PRESENTATION.delivered.guidance,
    /ne (?:confirme|garantit) pas.*boîte de réception/u,
  );
});
