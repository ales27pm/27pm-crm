import assert from "node:assert/strict";
import test from "node:test";

import {
  buildDeliverabilityMetrics,
  classifyDeliverabilityEvent,
  dedicatedIpWarmupDailyCeiling,
  dedicatedIpWarmupIncreaseAllowed,
  evaluateDeliverabilityThresholds,
  mailboxProviderForAddress,
  mailboxProviderForDomain,
  REPUTATION_MODES,
  reputationDailyVolumeCeiling,
} from "../lib/deliverability-policy.ts";

test("classifies canonical consumer mailbox providers without returning an address", () => {
  const cases = [
    ["person@gmail.com", "google"],
    ["PERSON@GOOGLEMAIL.COM", "google"],
    ["person@outlook.com", "microsoft"],
    ["person@hotmail.ca", "microsoft"],
    ["person@live.co.uk", "microsoft"],
    ["person@yahoo.ca", "yahoo"],
    ["person@ymail.com", "yahoo"],
    ["person@aol.com", "yahoo"],
    ["person@company.example", "other"],
    ["person@gmail.com.evil.example", "other"],
    ["not-an-address", "other"],
  ];

  for (const [address, expected] of cases) {
    assert.equal(mailboxProviderForAddress(address), expected);
  }
  assert.equal(mailboxProviderForDomain(" Yahoo.CO.UK. "), "yahoo");
  assert.equal(mailboxProviderForDomain("gmail.com.evil.example"), "other");
});

test("classifies transport and recipient-directed Mailgun outcomes", () => {
  const cases = [
    [{ event: "accepted" }, "accepted_transport"],
    [{ event: "delivered" }, "delivered_transport"],
    [{ event: "complained" }, "complaint"],
    [{ event: "unsubscribed" }, "unsubscribe"],
    [
      { event: "failed", severity: "permanent", reason: "suppress_bounce" },
      "hard_bounce",
    ],
    [
      {
        event: "failed",
        severity: "permanent",
        enhancedStatusCode: "5.1.1",
        description: "User unknown",
      },
      "hard_bounce",
    ],
    [
      {
        event: "failed",
        severity: "temporary",
        reason: "espblock",
        smtpCode: 421,
      },
      "policy_block",
    ],
    [
      {
        event: "failed",
        severity: "permanent",
        enhancedStatusCode: "5.7.26",
        description: "Unauthenticated mail; SPF or DKIM required",
      },
      "auth_failure",
    ],
    [
      { event: "failed", severity: "temporary", smtpCode: "421" },
      "temporary",
    ],
    [
      { event: "failed", severity: "permanent", smtpCode: 550 },
      "other_permanent",
    ],
    [{ event: "opened" }, "unknown"],
  ];

  for (const [input, expected] of cases) {
    assert.equal(classifyDeliverabilityEvent(input), expected);
  }
});

test("keeps policy and authentication blocks distinct from hard bounces", () => {
  assert.equal(
    classifyDeliverabilityEvent({
      event: "failed",
      severity: "permanent",
      enhancedStatusCode: "5.7.1",
      description: "Message rejected by policy",
    }),
    "policy_block",
  );
  assert.equal(
    classifyDeliverabilityEvent({
      event: "failed",
      severity: "temporary",
      smtpCode: 451,
      description: "Temporary local problem",
    }),
    "temporary",
  );
  assert.equal(
    classifyDeliverabilityEvent({
      event: "failed",
      severity: "permanent",
      smtpCode: 550,
      description: "Mailbox unavailable",
    }),
    "other_permanent",
  );
});

test("preserves deterministic precedence when Mailgun diagnostics overlap", () => {
  assert.equal(
    classifyDeliverabilityEvent({
      event: "accepted",
      reason: "suppress-complaint",
      description: "blocked by policy",
    }),
    "accepted_transport",
  );
  assert.equal(
    classifyDeliverabilityEvent({
      event: "failed",
      severity: "permanent",
      enhancedStatusCode: "5.1.1",
      description: "Unauthenticated recipient does not exist",
    }),
    "hard_bounce",
  );
  assert.equal(
    classifyDeliverabilityEvent({
      event: "failed",
      severity: "permanent",
      enhancedStatusCode: "5.7.26",
      description: "Spam policy requires DKIM authentication",
    }),
    "auth_failure",
  );
  assert.equal(
    classifyDeliverabilityEvent({
      event: "failed",
      severity: "temporary",
      reason: "espblock",
      smtpCode: 421,
    }),
    "policy_block",
  );
});

test("builds unrounded metrics with an explicit denominator for every rate", () => {
  const metrics = buildDeliverabilityMetrics({
    attempted: 10_000,
    accepted: 9_900,
    delivered: 9_801,
    hardBounced: 99,
    complained: 4,
    unsubscribed: 20,
    temporarilyFailed: 100,
    policyBlocked: 12,
    authFailed: 2,
    otherPermanentFailed: 5,
    gmailDelivered: 3_000,
    gmailSpamReported: 2,
  });

  assert.deepEqual(metrics.acceptance, {
    numerator: 9_900,
    denominator: 10_000,
    denominatorKind: "attempted",
    ratio: 0.99,
    percent: 99,
  });
  assert.equal(metrics.delivery.numerator, 9_801);
  assert.equal(metrics.delivery.denominator, 9_900);
  assert.equal(metrics.delivery.denominatorKind, "accepted");
  assert.equal(metrics.delivery.ratio, 9_801 / 9_900);
  assert.equal(metrics.hardBounce.ratio, 99 / 9_900);
  assert.equal(metrics.complaint.denominatorKind, "delivered");
  assert.equal(metrics.complaint.ratio, 4 / 9_801);
  assert.equal(metrics.unsubscribe.ratio, 20 / 9_801);
  assert.equal(metrics.temporaryFailure.ratio, 100 / 9_900);
  assert.equal(metrics.policyBlock.ratio, 12 / 9_900);
  assert.equal(metrics.authFailure.ratio, 2 / 9_900);
  assert.equal(metrics.otherPermanentFailure.ratio, 5 / 9_900);
  assert.equal(metrics.gmailSpam?.denominatorKind, "gmail_delivered");
  assert.equal(metrics.gmailSpam?.ratio, 2 / 3_000);
});

test("uses null rates for an empty denominator and rejects inconsistent counts", () => {
  const empty = buildDeliverabilityMetrics({
    attempted: 0,
    accepted: 0,
    delivered: 0,
    hardBounced: 0,
    complained: 0,
    unsubscribed: 0,
    temporarilyFailed: 0,
  });
  assert.equal(empty.delivery.ratio, null);
  assert.equal(empty.delivery.percent, null);
  assert.equal(empty.gmailSpam, null);

  assert.throws(
    () =>
      buildDeliverabilityMetrics({
        attempted: 10,
        accepted: 11,
        delivered: 0,
        hardBounced: 0,
        complained: 0,
        unsubscribed: 0,
        temporarilyFailed: 0,
      }),
    /accepted cannot exceed attempted/u,
  );
  assert.throws(
    () =>
      buildDeliverabilityMetrics({
        attempted: 10,
        accepted: 10,
        delivered: 10,
        hardBounced: 0,
        complained: 0,
        unsubscribed: 0,
        temporarilyFailed: 0,
        gmailSpamReported: 1,
      }),
    /gmailDelivered and gmailSpamReported must be provided together/u,
  );
});

test("evaluates the exact complaint and hard-bounce boundaries", () => {
  const complaintWarning = evaluateDeliverabilityThresholds(
    buildDeliverabilityMetrics({
      attempted: 2_000,
      accepted: 2_000,
      delivered: 2_000,
      hardBounced: 0,
      complained: 1,
      unsubscribed: 0,
      temporarilyFailed: 0,
    }),
    { minimumSampleSize: 1 },
  );
  assert.equal(complaintWarning.complaint.percent, 0.05);
  assert.equal(complaintWarning.complaint.status, "warning");

  const complaintCritical = evaluateDeliverabilityThresholds(
    buildDeliverabilityMetrics({
      attempted: 2_000,
      accepted: 2_000,
      delivered: 2_000,
      hardBounced: 0,
      complained: 2,
      unsubscribed: 0,
      temporarilyFailed: 0,
    }),
    { minimumSampleSize: 1 },
  );
  assert.equal(complaintCritical.complaint.percent, 0.1);
  assert.equal(complaintCritical.complaint.status, "critical");

  const hardBounceWarning = thresholdFixture({ hardBounced: 1 });
  assert.equal(hardBounceWarning.hardBounce.percent, 1);
  assert.equal(hardBounceWarning.hardBounce.status, "warning");
  const hardBounceCritical = thresholdFixture({ hardBounced: 2 });
  assert.equal(hardBounceCritical.hardBounce.percent, 2);
  assert.equal(hardBounceCritical.hardBounce.status, "critical");
});

test("evaluates delivery and temporary-failure boundaries without inventing a temp warning band", () => {
  assert.equal(thresholdFixture({ delivered: 98 }).delivery.status, "target");
  assert.equal(thresholdFixture({ delivered: 97 }).delivery.status, "warning");
  assert.equal(thresholdFixture({ delivered: 95 }).delivery.status, "warning");
  assert.equal(thresholdFixture({ delivered: 94 }).delivery.status, "critical");
  assert.equal(
    thresholdFixture({ temporarilyFailed: 5 }).temporaryFailure.status,
    "target",
  );
  assert.equal(
    thresholdFixture({ temporarilyFailed: 6 }).temporaryFailure.status,
    "critical",
  );
});

test("reports insufficient data below the configurable denominator minimum", () => {
  const metrics = buildDeliverabilityMetrics({
    attempted: 99,
    accepted: 99,
    delivered: 99,
    hardBounced: 0,
    complained: 0,
    unsubscribed: 0,
    temporarilyFailed: 0,
  });
  const defaultEvaluation = evaluateDeliverabilityThresholds(metrics);
  assert.equal(defaultEvaluation.delivery.status, "insufficient_data");
  assert.equal(defaultEvaluation.complaint.status, "insufficient_data");
  assert.equal(defaultEvaluation.overall, "insufficient_data");

  const configured = evaluateDeliverabilityThresholds(metrics, {
    minimumSampleSize: 50,
  });
  assert.equal(configured.delivery.status, "target");
  assert.equal(configured.overall, "target");
});

test("keeps the optional Gmail spam signal separate from aggregate complaints", () => {
  const evaluation = evaluateDeliverabilityThresholds(
    buildDeliverabilityMetrics({
      attempted: 2_000,
      accepted: 2_000,
      delivered: 2_000,
      hardBounced: 0,
      complained: 0,
      unsubscribed: 0,
      temporarilyFailed: 0,
      gmailDelivered: 2_000,
      gmailSpamReported: 1,
    }),
    { minimumSampleSize: 100 },
  );

  assert.equal(evaluation.complaint.status, "target");
  assert.ok(evaluation.gmailSpam);
  assert.equal(evaluation.gmailSpam.percent, 0.05);
  assert.equal(evaluation.gmailSpam.status, "target");
  assert.equal(evaluation.overall, "target");

  const warning = evaluateDeliverabilityThresholds(
    buildDeliverabilityMetrics({
      attempted: 1_000,
      accepted: 1_000,
      delivered: 1_000,
      hardBounced: 0,
      complained: 0,
      unsubscribed: 0,
      temporarilyFailed: 0,
      gmailDelivered: 1_000,
      gmailSpamReported: 1,
    }),
    { minimumSampleSize: 100 },
  );
  assert.ok(warning.gmailSpam);
  assert.equal(warning.gmailSpam.percent, 0.1);
  assert.equal(warning.gmailSpam.status, "warning");

  const critical = evaluateDeliverabilityThresholds(
    buildDeliverabilityMetrics({
      attempted: 1_000,
      accepted: 1_000,
      delivered: 1_000,
      hardBounced: 0,
      complained: 0,
      unsubscribed: 0,
      temporarilyFailed: 0,
      gmailDelivered: 1_000,
      gmailSpamReported: 3,
    }),
    { minimumSampleSize: 100 },
  );
  assert.ok(critical.gmailSpam);
  assert.equal(critical.gmailSpam.percent, 0.3);
  assert.equal(critical.gmailSpam.status, "critical");
});

test("exposes the warm-up formula only for dedicated-IP warm-up mode", () => {
  assert.deepEqual(REPUTATION_MODES, [
    "normal",
    "domain_ramp",
    "recovery",
    "dedicated_ip_warmup",
  ]);
  assert.equal(reputationDailyVolumeCeiling("normal", 1), null);
  assert.equal(reputationDailyVolumeCeiling("domain_ramp", 1), null);
  assert.equal(reputationDailyVolumeCeiling("recovery", 1), null);
  assert.equal(reputationDailyVolumeCeiling("dedicated_ip_warmup", 1), 100);
  assert.equal(dedicatedIpWarmupDailyCeiling(7), 298);
  assert.equal(dedicatedIpWarmupDailyCeiling(14), 1_069);
  assert.equal(dedicatedIpWarmupDailyCeiling(39), 102_067);
  assert.equal(dedicatedIpWarmupIncreaseAllowed(100, 120), true);
  assert.equal(dedicatedIpWarmupIncreaseAllowed(100, 121), false);
  assert.throws(() => dedicatedIpWarmupDailyCeiling(0), /positive integer/u);
});

function thresholdFixture(overrides = {}) {
  return evaluateDeliverabilityThresholds(
    buildDeliverabilityMetrics({
      attempted: 100,
      accepted: 100,
      delivered: 100,
      hardBounced: 0,
      complained: 0,
      unsubscribed: 0,
      temporarilyFailed: 0,
      ...overrides,
    }),
    { minimumSampleSize: 1 },
  );
}
