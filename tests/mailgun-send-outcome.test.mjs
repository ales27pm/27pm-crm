import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMailgunFailure,
  mailgunFailureKindForStatus,
  MailgunSendError,
  normalizeAcceptedMailgunMessageId,
} from "../lib/mailgun-send-outcome.ts";

test("classifies only a received Mailgun rejection as a definitive failure", () => {
  assert.equal(
    classifyMailgunFailure(false, new Error("configuration failed")),
    "definitive_failure",
  );
  assert.equal(
    classifyMailgunFailure(
      true,
      new MailgunSendError(400, "rejected"),
    ),
    "definitive_failure",
  );
});

test("maps Mailgun 4xx to rejection and 5xx to an unknown outcome", () => {
  assert.equal(mailgunFailureKindForStatus(400), "rejected");
  assert.equal(mailgunFailureKindForStatus(429), "rejected");
  assert.equal(mailgunFailureKindForStatus(500), "outcome_unknown");
  assert.equal(mailgunFailureKindForStatus(503), "outcome_unknown");
});

test("keeps network and malformed-success outcomes non-retryable", () => {
  assert.equal(
    classifyMailgunFailure(true, new Error("connection reset")),
    "outcome_unknown",
  );
  assert.equal(
    classifyMailgunFailure(
      true,
      new MailgunSendError(502, "outcome_unknown"),
    ),
    "outcome_unknown",
  );
});

test("accepts only a correlatable message id from a Mailgun 2xx", () => {
  assert.equal(
    normalizeAcceptedMailgunMessageId("<Queued.Message@27pm.org>"),
    "queued.message@27pm.org",
  );
  for (const value of [
    "",
    " ",
    "abc",
    "bad id",
    "bad@@id",
    "<>",
    "bad\u0000id@example.com",
    "prefix<ok@example.com>suffix",
    "x".repeat(513),
  ]) {
    assert.throws(
      () => normalizeAcceptedMailgunMessageId(value),
      (error) =>
        error instanceof MailgunSendError &&
        error.kind === "outcome_unknown",
    );
  }
});
