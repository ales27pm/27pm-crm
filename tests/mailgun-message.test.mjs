import assert from "node:assert/strict";
import test from "node:test";

import { buildMailgunForm } from "../lib/mailgun-message.ts";

test("builds a deterministic low-tracking message with a standard unsubscribe header", () => {
  const form = buildMailgunForm({
    fromAddress: "alexis@27pm.org",
    fromName: "Alexis Boulet",
    to: ["client@example.com"],
    subject: "Une observation concrete",
    text: "Bonjour",
    html: "<p>Bonjour</p>",
    inReplyTo: "reply@example.com",
    references: ["first@example.com", "reply@example.com"],
    replyTo: "alexis@27pm.org",
    tags: ["traffic-prospecting", "crm-manual"],
    unsubscribeUrl:
      "https://crm.27pm.org/api/public/unsubscribe?token=opaque-token",
  });

  assert.equal(form.get("from"), "Alexis Boulet <alexis@27pm.org>");
  assert.deepEqual(form.getAll("to"), ["client@example.com"]);
  assert.equal(form.get("subject"), "Une observation concrete");
  assert.equal(form.get("text"), "Bonjour");
  assert.equal(form.get("html"), "<p>Bonjour</p>");
  assert.equal(form.get("h:In-Reply-To"), "<reply@example.com>");
  assert.equal(
    form.get("h:References"),
    "<first@example.com> <reply@example.com>",
  );
  assert.equal(form.get("o:dkim"), "yes");
  assert.equal(form.get("o:tracking"), "no");
  assert.equal(form.get("o:tracking-clicks"), "no");
  assert.equal(form.get("o:tracking-opens"), "no");
  assert.deepEqual(form.getAll("o:tag"), [
    "crm-manual",
    "traffic-prospecting",
  ]);
  assert.equal(form.get("h:Reply-To"), "alexis@27pm.org");
  assert.equal(
    form.get("h:List-Unsubscribe"),
    "<https://crm.27pm.org/api/public/unsubscribe?token=opaque-token>",
  );
  assert.equal(
    form.get("h:List-Unsubscribe-Post"),
    "List-Unsubscribe=One-Click",
  );
});

test("rejects tags that are non-canonical, duplicate, oversized, or shaped like PII", () => {
  const baseMessage = {
    fromAddress: "alexis@27pm.org",
    fromName: "Alexis Boulet",
    to: ["client@example.com"],
    subject: "Bonjour",
    text: "Bonjour",
    replyTo: "alexis@27pm.org",
  };

  for (const tags of [
    "crm-manual",
    [42],
    ["customer@example.com"],
    ["contact-5145550100"],
    ["contact-514-555-0100"],
    ["recipient-550e8400-e29b-41d4-a716-446655440000"],
    ["postal-h2x1y4"],
    ["has space"],
    ["Uppercase"],
    [`a${"b".repeat(64)}`],
    ["crm--prospecting"],
    ["crm-manual", "crm-manual"],
    Array.from({ length: 4 }, (_, index) => `category-${index}`),
  ]) {
    assert.throws(
      () => buildMailgunForm({ ...baseMessage, tags }),
      /Mailgun tags are invalid/u,
    );
  }
});

test("refuses an unsubscribe URL that is not an opaque HTTPS endpoint", () => {
  const baseMessage = {
    fromAddress: "alexis@27pm.org",
    fromName: "Alexis Boulet",
    to: ["client@example.com"],
    subject: "Bonjour",
    text: "Bonjour",
    replyTo: "alexis@27pm.org",
  };

  for (const unsubscribeUrl of [
    "http://crm.27pm.org/unsubscribe?token=opaque",
    "https://user:password@crm.27pm.org/unsubscribe?token=opaque",
    "https://crm.27pm.org/unsubscribe?token=opaque#fragment",
  ]) {
    assert.throws(
      () => buildMailgunForm({ ...baseMessage, unsubscribeUrl }),
      /unsubscribe URL is invalid/u,
    );
  }
});

test("requires Reply-To to match the normalized sender mailbox", () => {
  const baseMessage = {
    fromAddress: "alexis@27pm.org",
    fromName: "Alexis Boulet",
    to: ["client@example.com"],
    subject: "Bonjour",
    text: "Bonjour",
    unsubscribeUrl:
      "https://crm.27pm.org/api/public/unsubscribe?token=opaque-token",
  };

  for (const replyTo of [
    "admin@27pm.org",
    "alexis@27pm.org\r\nBcc: attacker@example.com",
  ]) {
    assert.throws(
      () => buildMailgunForm({ ...baseMessage, replyTo }),
      /Reply-To address is invalid/u,
    );
  }
});

test("allows an administrative canary without marketing unsubscribe headers", () => {
  const form = buildMailgunForm({
    fromAddress: "alexis@27pm.org",
    fromName: "Alexis Boulet — 27PM",
    to: ["27pmorg@gmail.com"],
    subject: "Test DKIM 2048 — 27PM",
    text: "Test administratif",
    replyTo: "alexis@27pm.org",
  });

  assert.equal(form.get("o:dkim"), "yes");
  assert.equal(form.get("o:tracking"), "no");
  assert.equal(form.get("h:Reply-To"), "alexis@27pm.org");
  assert.equal(form.has("o:tag"), false);
  assert.equal(form.has("h:List-Unsubscribe"), false);
  assert.equal(form.has("h:List-Unsubscribe-Post"), false);
});
