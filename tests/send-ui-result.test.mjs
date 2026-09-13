import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyCanarySendHttpResponse,
  classifyMessageSendHttpResponse,
} from "../lib/send-ui-result.ts";

test("requires an explicit CRM recording result for accepted message responses", () => {
  assert.equal(
    classifyMessageSendHttpResponse(202, {
      accepted: true,
      crmRecorded: true,
    }),
    "accepted",
  );
  assert.equal(
    classifyMessageSendHttpResponse(202, {
      accepted: true,
      crmRecorded: false,
    }),
    "local_repair",
  );
  for (const crmRecorded of [undefined, null, "false", 0]) {
    assert.equal(
      classifyMessageSendHttpResponse(202, {
        accepted: true,
        crmRecorded,
      }),
      "outcome_unknown",
    );
  }
});

test("uses the separate canary success contract without a CRM recording field", () => {
  assert.equal(
    classifyCanarySendHttpResponse(202, { accepted: true }),
    "accepted",
  );
  assert.equal(classifyCanarySendHttpResponse(202, {}), "outcome_unknown");
});

test("classifies definitive and unknown failures for both response contracts", () => {
  for (const classify of [
    classifyMessageSendHttpResponse,
    classifyCanarySendHttpResponse,
  ]) {
  assert.equal(
      classify(409, {
      error: "cakemail_audience_lawful_basis_not_permitted",
    }),
    "definitive_failure",
  );
  assert.equal(
      classify(502, { error: "outbound_send_failed" }),
    "definitive_failure",
  );
  assert.equal(
      classify(502, { error: "canary_send_failed" }),
    "definitive_failure",
  );
  assert.equal(
      classify(503, { error: "outbound_send_unconfirmed" }),
    "outcome_unknown",
  );
  assert.equal(
      classify(503, { error: "canary_send_unconfirmed" }),
    "outcome_unknown",
  );
  }
});
