import assert from "node:assert/strict";
import test from "node:test";

import {
  outboundMessageSnapshotJson,
  parseOutboundMessageSnapshot,
} from "../lib/outbound-message-snapshot.ts";

const snapshot = {
  version: 1,
  requestHash: "a".repeat(64),
  provider: "cakemail",
  contactId: "contact-controlled",
  mailbox: {
    id: "mailbox_alexis",
    address: "alexis@27pm.org",
    purpose: "sales",
  },
  recipient: "controlled@example.com",
  subject: "Canari",
  contentMode: "html",
  text: null,
  html: "<p>Texte conforme</p>",
  actorEmail: "alexis@27pm.org",
  conversationId: null,
  occurredAt: "2026-09-12T15:00:00.000Z",
};

test("round-trips a bounded pre-dispatch message snapshot", () => {
  const serialized = outboundMessageSnapshotJson(snapshot);
  assert.deepEqual(parseOutboundMessageSnapshot(serialized), snapshot);
});

test("rejects malformed or non-canonical recovery snapshots", () => {
  for (const value of [
    null,
    "not-json",
    JSON.stringify({ ...snapshot, requestHash: "short" }),
    JSON.stringify({ ...snapshot, provider: "other" }),
    JSON.stringify({ ...snapshot, contactId: "bad contact" }),
    JSON.stringify({ ...snapshot, recipient: "Controlled@example.com" }),
    JSON.stringify({ ...snapshot, contentMode: "text" }),
    JSON.stringify({ ...snapshot, text: "Texte non transmis" }),
    JSON.stringify({ ...snapshot, occurredAt: "yesterday" }),
  ]) {
    assert.equal(parseOutboundMessageSnapshot(value), null);
  }
});
