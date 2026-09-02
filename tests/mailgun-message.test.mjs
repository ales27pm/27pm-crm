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
  assert.equal(
    form.get("h:List-Unsubscribe"),
    "<https://crm.27pm.org/api/public/unsubscribe?token=opaque-token>",
  );
  assert.equal(
    form.get("h:List-Unsubscribe-Post"),
    "List-Unsubscribe=One-Click",
  );
});

test("refuses an unsubscribe URL that is not an opaque HTTPS endpoint", () => {
  const baseMessage = {
    fromAddress: "alexis@27pm.org",
    fromName: "Alexis Boulet",
    to: ["client@example.com"],
    subject: "Bonjour",
    text: "Bonjour",
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
