import assert from "node:assert/strict";
import test from "node:test";

import {
  classifyMailgunFailure,
  extractMailgunEventMetadata,
  normalizedMailboxProvider,
} from "../lib/mailgun-event-metadata.ts";

test("extracts bounded provider, transport, SMTP, tag, and campaign dimensions", () => {
  assert.deepEqual(
    extractMailgunEventMetadata({
      eventType: "failed",
      severity: "temporary",
      reason: "espblock",
      recipient: "person@outlook.com",
      raw: {
        domain: { name: "27pm.org" },
        envelope: { "sending-ip": "159.135.228.14" },
        "recipient-domain": "outlook.com",
        "recipient-provider": "Microsoft Outlook",
        tags: ["crm-prospecting", "crm-prospecting", "bad tag", "pii@example.com"],
        campaigns: [{ id: "run-2026-09" }, { name: "bad campaign" }],
        "delivery-status": {
          code: 421,
          "enhanced-code": "4.7.0",
          "attempt-no": 2,
          message: "Policy block for person@outlook.com due to reputation",
        },
      },
    }),
    {
      sendingDomain: "27pm.org",
      recipientDomain: "outlook.com",
      mailboxProvider: "microsoft",
      sendingIp: "159.135.228.14",
      failureClass: "policy_block",
      smtpCode: 421,
      enhancedStatusCode: "4.7.0",
      smtpDescription: "Policy block for [email] due to reputation",
      attemptNo: 2,
      tags: ["crm-prospecting"],
      campaigns: ["run-2026-09"],
    },
  );
});

test("classifies only explicit hard-recipient signals as hard bounces", () => {
  assert.equal(
    classifyMailgunFailure({
      eventType: "failed",
      severity: "permanent",
      reason: "bounce",
    }),
    "hard_bounce",
  );
  assert.equal(
    classifyMailgunFailure({
      eventType: "failed",
      severity: "permanent",
      reason: "generic",
      enhancedStatusCode: "5.7.1",
      smtpDescription: "Message rejected by policy",
    }),
    "policy_block",
  );
  assert.equal(
    classifyMailgunFailure({
      eventType: "failed",
      severity: "permanent",
      reason: "generic",
      smtpCode: 550,
      smtpDescription: "Mailbox unavailable",
    }),
    "other_permanent",
  );
});

test("recognizes complaint, unsubscribe, authentication, and temporary signals", () => {
  assert.equal(
    classifyMailgunFailure({ eventType: "complained" }),
    "complaint",
  );
  assert.equal(
    classifyMailgunFailure({
      eventType: "failed",
      severity: "permanent",
      reason: "suppress-unsubscribe",
    }),
    "unsubscribe",
  );
  assert.equal(
    classifyMailgunFailure({
      eventType: "failed",
      severity: "permanent",
      smtpDescription: "DKIM authentication failed",
    }),
    "auth_failure",
  );
  assert.equal(
    classifyMailgunFailure({
      eventType: "failed",
      severity: "temporary",
      reason: "generic",
    }),
    "temporary",
  );
  assert.equal(classifyMailgunFailure({ eventType: "delivered" }), null);
});

test("classifies mailbox providers conservatively", () => {
  assert.equal(normalizedMailboxProvider("Gmail", "custom.invalid"), "google");
  assert.equal(normalizedMailboxProvider(null, "hotmail.com"), "microsoft");
  assert.equal(normalizedMailboxProvider("Yahoo! Mail", null), "yahoo");
  assert.equal(normalizedMailboxProvider("Videotron", "example.ca"), "other");
});

test("drops malformed dimensions and invalid network values", () => {
  const metadata = extractMailgunEventMetadata({
    eventType: "delivered",
    severity: null,
    reason: null,
    recipient: "invalid",
    raw: {
      domain: { name: "bad domain" },
      envelope: { "sending-ip": "999.1.1.1" },
      tags: new Array(40).fill("tag").map((tag, index) => `${tag}-${index}`),
      "delivery-status": {
        code: 999,
        "enhanced-code": "9.9.9",
        "attempt-no": 0,
      },
    },
  });

  assert.equal(metadata.sendingDomain, null);
  assert.equal(metadata.recipientDomain, null);
  assert.equal(metadata.sendingIp, null);
  assert.equal(metadata.smtpCode, null);
  assert.equal(metadata.enhancedStatusCode, null);
  assert.equal(metadata.attemptNo, null);
  assert.equal(metadata.tags.length, 32);
});
