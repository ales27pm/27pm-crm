import assert from "node:assert/strict";
import test from "node:test";

import { providerDeliveryState } from "../lib/outbound-delivery-state.ts";

test("uses Mailgun reason semantics only for Mailgun events", () => {
  const event = {
    eventType: "failed",
    severity: "permanent",
    failureClass: "hard_bounce",
    payloadJson: JSON.stringify({ reason: "suppress-complaint" }),
  };

  assert.equal(providerDeliveryState("mailgun", event), "complained");
  assert.equal(providerDeliveryState("cakemail", event), "bounced");
});

test("maps normalized Cakemail failure classes without trusting raw reason", () => {
  assert.equal(
    providerDeliveryState("cakemail", {
      eventType: "failed",
      severity: "permanent",
      failureClass: "temporary",
      reason: "suppress-bounce",
    }),
    "temporary-failure",
  );
  assert.equal(
    providerDeliveryState("cakemail", {
      eventType: "complained",
      failureClass: "complaint",
    }),
    "complained",
  );
});
