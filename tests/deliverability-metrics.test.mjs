import assert from "node:assert/strict";
import test from "node:test";

import { summarizeDeliverability } from "../lib/deliverability-metrics.ts";

test("aggregates unique messages by provider without counting retries as sends", () => {
  const summary = summarizeDeliverability(
    [
      message("delivered-ms", "person@outlook.com", "delivered", [
        event("accepted", null, "accepted_transport", "microsoft"),
        event("failed", "generic", "temporary", "microsoft"),
        event("delivered", null, "delivered_transport", "microsoft"),
      ]),
      message("complaint-google", "person@gmail.com", "complained", [
        event("delivered", null, "delivered_transport", "google"),
        event("complained", null, "complaint", "google"),
      ]),
      message("policy-yahoo", "person@yahoo.ca", "permanent-failure", [
        event("failed", "espblock", "policy_block", "yahoo"),
      ]),
    ],
    { minimumSampleSize: 100 },
  );

  assert.equal(summary.overall.counts.attempted, 3);
  assert.equal(summary.overall.counts.accepted, 3);
  assert.equal(summary.overall.counts.delivered, 2);
  assert.equal(summary.overall.counts.temporarilyFailed, 1);
  assert.equal(summary.overall.counts.complained, 1);
  assert.equal(summary.overall.counts.policyBlocked, 1);
  assert.deepEqual(summary.overall.signals, [
    "complaint",
    "policy_block",
    "temporary_failure",
  ]);
  assert.equal(summary.overall.evaluation.overall, "insufficient_data");
  assert.equal(
    summary.providers.find((segment) => segment.key === "microsoft")?.counts
      .attempted,
    1,
  );
  assert.equal(
    summary.providers.find((segment) => segment.key === "google")?.counts
      .complained,
    1,
  );
  assert.equal(
    summary.providers.find((segment) => segment.key === "yahoo")?.counts
      .policyBlocked,
    1,
  );
  assert.equal(summary.dataQuality.events, 6);
  assert.equal(summary.dataQuality.withoutTerminalTransport, 0);
});

test("separates provider suppressions from new complaint and hard-bounce rates", () => {
  const summary = summarizeDeliverability(
    [
      message("suppressed-bounce", "old@example.com", "bounced", [
        event("failed", "suppress-bounce", "hard_bounce", "other"),
      ]),
      message("suppressed-complaint", "old@example.com", "complained", [
        event("failed", "suppress-complaint", "complaint", "other"),
      ]),
      message("suppressed-unsubscribe", "old@example.com", "permanent-failure", [
        event("failed", "suppress-unsubscribe", "unsubscribe", "other"),
      ]),
    ],
    { minimumSampleSize: 1 },
  );

  assert.equal(summary.overall.counts.providerSuppressed, 3);
  assert.equal(summary.overall.counts.hardBounced, 0);
  assert.equal(summary.overall.counts.complained, 0);
  assert.equal(summary.overall.counts.unsubscribed, 0);
  assert.deepEqual(summary.overall.signals, ["provider_suppression"]);
});

test("uses strong explicit provider metadata and retains safe operational dimensions", () => {
  const source = message("custom", "person@company.example", "delivered", [
    {
      ...event("delivered", null, "delivered_transport", "microsoft"),
      sendingDomain: "27pm.org",
      sendingIp: "159.135.228.14",
      tags: ["traffic-prospecting", "bad tag"],
    },
  ]);
  source.trafficType = "prospecting";
  source.tags = ["source-crm"];
  const summary = summarizeDeliverability([source], { minimumSampleSize: 1 });

  assert.equal(summary.providers[1].key, "microsoft");
  assert.equal(summary.providers[1].counts.delivered, 1);
  assert.deepEqual(summary.sendingDomains.map(({ key }) => key), ["27pm.org"]);
  assert.deepEqual(summary.sendingIps.map(({ key }) => key), ["159.135.228.14"]);
  assert.deepEqual(summary.trafficTypes.map(({ key }) => key), ["prospecting"]);
  assert.deepEqual(summary.tags.map(({ key }) => key), [
    "source-crm",
    "traffic-prospecting",
  ]);
});

test("reports pending and unknown-provider data without a false healthy badge", () => {
  const summary = summarizeDeliverability(
    [message("pending", "person@company.example", "accepted", [])],
    { minimumSampleSize: 1 },
  );
  assert.equal(summary.overall.counts.pending, 1);
  assert.deepEqual(summary.overall.signals, ["pending"]);
  assert.equal(summary.overall.evaluation.delivery.status, "insufficient_data");
  assert.equal(summary.dataQuality.providerUnknown, 1);
  assert.equal(summary.dataQuality.withoutTerminalTransport, 1);
  assert.equal(summary.dataQuality.latestEventAt, null);
});

test("bounds combined message tags deterministically across event order", () => {
  const candidates = Array.from({ length: 40 }, (_, index) => tagName(index));
  const forward = summarizeDeliverability(
    [messageWithDistributedTags("forward", candidates)],
    { minimumSampleSize: 1 },
  );
  const reverse = summarizeDeliverability(
    [messageWithDistributedTags("reverse", [...candidates].reverse())],
    { minimumSampleSize: 1 },
  );
  const expected = candidates.slice(0, 32);

  assert.deepEqual(forward.tags.map(({ key }) => key), expected);
  assert.deepEqual(reverse.tags.map(({ key }) => key), expected);
  assert.equal(forward.dataQuality.messagesWithTagTruncation, 1);
  assert.equal(reverse.dataQuality.messagesWithTagTruncation, 1);
  assert.equal(forward.dataQuality.tagSegmentsTruncated, false);
});

test("caps high-cardinality tag segments with order-independent output", () => {
  const candidates = Array.from({ length: 300 }, (_, index) => tagName(index));
  const forward = summarizeDeliverability(taggedMessages(candidates), {
    minimumSampleSize: 1,
  });
  const reverse = summarizeDeliverability(
    taggedMessages([...candidates].reverse()),
    { minimumSampleSize: 1 },
  );
  const expected = candidates.slice(0, 256);

  assert.deepEqual(forward.tags.map(({ key }) => key), expected);
  assert.deepEqual(reverse.tags.map(({ key }) => key), expected);
  assert.equal(forward.tags.length, 256);
  assert.equal(forward.tags.every(({ counts }) => counts.attempted === 1), true);
  assert.equal(forward.overall.counts.attempted, 300);
  assert.equal(forward.dataQuality.messagesWithTagTruncation, 0);
  assert.equal(forward.dataQuality.tagSegmentsTruncated, true);
  assert.equal(reverse.dataQuality.tagSegmentsTruncated, true);
});

function message(id, recipient, status, events) {
  return {
    id,
    recipient,
    status,
    trafficType: "unclassified",
    tags: [],
    occurredAt: "2026-09-11T12:00:00.000Z",
    events,
  };
}

function event(eventType, reason, eventClass, mailboxProvider) {
  return {
    eventType,
    reason,
    eventClass,
    mailboxProvider,
    sendingDomain: null,
    sendingIp: null,
    tags: [],
    occurredAt: "2026-09-11T12:01:00.000Z",
  };
}

function messageWithDistributedTags(id, tags) {
  const source = message(id, "person@example.com", "delivered", [
    event("delivered", null, "delivered_transport", "other"),
  ]);
  source.tags = tags.slice(0, 20);
  source.events[0].tags = tags.slice(20);
  return source;
}

function taggedMessages(tags) {
  return tags.map((tag, index) => {
    const source = message(
      `tagged-${index}`,
      "person@example.com",
      "delivered",
      [],
    );
    source.tags = [tag];
    return source;
  });
}

function tagName(index) {
  return `tag-${String(index).padStart(3, "0")}`;
}
