import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCakemailPayload,
  createCakemailExternalMessageId,
} from "../lib/cakemail-message.ts";
import { sendContentFromPayload } from "../lib/send-payload.ts";
import { appendComplianceFooter } from "../lib/unsubscribe.ts";

const senderIds = { "alexis@27pm.org": "sender_27pm_alexis" };
const externalMessageId =
  "cakemail.550e8400-e29b-41d4-a716-446655440000@27pm.org";

const message = {
  fromAddress: "alexis@27pm.org",
  fromName: "Alexis Boulet — 27PM",
  to: ["client@example.com"],
  subject: "Une observation concrète",
  text: "Bonjour en texte",
  html: "<p>Bonjour en HTML</p>",
  inReplyTo: "reply@example.com",
  references: ["first@example.com", "reply@example.com"],
  replyTo: "alexis@27pm.org",
  unsubscribeUrl:
    "https://crm.27pm.org/api/public/unsubscribe?token=opaque-token",
  tags: ["traffic-prospecting", "crm-manual"],
};

test("builds one explicitly selected content part and only allowlisted headers", () => {
  const payload = buildCakemailPayload(
    message,
    { listId: 42, contentMode: "html", senderIds },
    externalMessageId,
  );

  assert.deepEqual(payload, {
    sender: { id: "sender_27pm_alexis", name: "Alexis Boulet — 27PM" },
    email: "client@example.com",
    list_id: 42,
    content: {
      type: "marketing",
      subject: "Une observation concrète",
      encoding: "utf-8",
      html: "<p>Bonjour en HTML</p>",
    },
    tags: ["crm-manual", "traffic-prospecting"],
    tracking: {
      opens: false,
      clicks_html: false,
      clicks_text: false,
    },
    additional_headers: [
      { name: "Message-ID", value: `<${externalMessageId}>` },
      { name: "Reply-To", value: "alexis@27pm.org" },
      { name: "In-Reply-To", value: "<reply@example.com>" },
      {
        name: "References",
        value: "<first@example.com> <reply@example.com>",
      },
      {
        name: "List-Unsubscribe",
        value:
          "<https://crm.27pm.org/api/public/unsubscribe?token=opaque-token>",
      },
      {
        name: "List-Unsubscribe-Post",
        value: "List-Unsubscribe=One-Click",
      },
    ],
  });
  assert.equal("text" in payload.content, false);
  assert.deepEqual(
    payload.additional_headers.map((header) => header.name),
    [
      "Message-ID",
      "Reply-To",
      "In-Reply-To",
      "References",
      "List-Unsubscribe",
      "List-Unsubscribe-Post",
    ],
  );
});

test("selects plain text without leaking an HTML alternative", () => {
  const payload = buildCakemailPayload(
    message,
    { listId: 42, contentMode: "text", senderIds },
    externalMessageId,
  );

  assert.equal(payload.content.text, "Bonjour en texte");
  assert.equal("html" in payload.content, false);
});

test("turns the UI body shape into the configured compliant HTML part", () => {
  const parsed = sendContentFromPayload({
    subject: "Bonjour",
    body: "Corps saisi dans le composeur",
  });
  assert.equal(parsed.html, null);

  const compliant = appendComplianceFooter(
    parsed.text,
    parsed.html,
    {
      senderName: "Alexis Boulet",
      organizationName: "27PM",
      postalAddress: "Montréal, Québec",
      contactMethod: "alexis@27pm.org",
    },
    "https://crm.27pm.org/api/public/unsubscribe?token=opaque-token",
  );
  const payload = buildCakemailPayload(
    { ...message, subject: parsed.subject, text: compliant.text, html: compliant.html },
    { listId: 42, contentMode: "html", senderIds },
    externalMessageId,
  );

  assert.match(payload.content.html, /Corps saisi dans le composeur/u);
  assert.match(payload.content.html, /Se désabonner/u);
  assert.equal("text" in payload.content, false);
});

test("generates a branded RFC Message-ID distinct from the provider UUID", () => {
  assert.equal(
    createCakemailExternalMessageId(
      "alexis@27pm.org",
      () => "550e8400-e29b-41d4-a716-446655440000",
    ),
    externalMessageId,
  );
  assert.throws(
    () =>
      createCakemailExternalMessageId(
        "Alexis@27pm.org",
        () => "550e8400-e29b-41d4-a716-446655440000",
      ),
    /sender address is invalid/u,
  );
});

test("fails closed for recipient, sender, reply, content, and header violations", () => {
  const config = { listId: 42, contentMode: "html", senderIds };
  const cases = [
    [{ ...message, to: [] }, config, /exactly one recipient/u],
    [
      { ...message, to: ["one@example.com", "two@example.com"] },
      config,
      /exactly one recipient/u,
    ],
    [
      { ...message, to: ["Client@example.com"] },
      config,
      /recipient address is invalid/u,
    ],
    [
      { ...message, replyTo: "admin@27pm.org" },
      config,
      /Reply-To must match/u,
    ],
    [
      { ...message, html: null },
      config,
      /html content is required/u,
    ],
    [
      { ...message, inReplyTo: "ok@example.com\r\nBcc:bad@example.com" },
      config,
      /In-Reply-To is invalid/u,
    ],
    [
      {
        ...message,
        unsubscribeUrl: "https://user:secret@crm.27pm.org/unsubscribe",
      },
      config,
      /unsubscribe URL is invalid/u,
    ],
    [message, { ...config, listId: 0 }, /list ID is invalid/u],
    [message, { ...config, senderIds: {} }, /sender ID is not configured/u],
  ];

  for (const [candidate, candidateConfig, expected] of cases) {
    assert.throws(
      () =>
        buildCakemailPayload(
          candidate,
          candidateConfig,
          externalMessageId,
        ),
      expected,
    );
  }
});

test("rejects non-canonical or PII-shaped taxonomy tags", () => {
  for (const tags of [
    ["Uppercase"],
    ["contact@example.com"],
    ["contact-514-555-0100"],
    ["postal-h2x1y4"],
    ["crm-manual", "crm-manual"],
    ["one", "two", "three", "four"],
  ]) {
    assert.throws(
      () =>
        buildCakemailPayload(
          { ...message, tags },
          { listId: 42, contentMode: "html", senderIds },
          externalMessageId,
        ),
      /tags are invalid/u,
    );
  }
});
