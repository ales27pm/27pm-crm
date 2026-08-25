import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { authorizeCrmRequest, parseOperatorAllowlist } from "../lib/auth.ts";
import { attachmentDownloadDecision } from "../lib/attachments.ts";
import {
  deriveThreadKey,
  eventCallbackKey,
  inboundCallbackKey,
  messageIdsFromHeader,
  normalizeCommandIdempotencyKey,
  normalizeMessageId,
  normalizeSubject,
  parseMailgunEventJson,
  referenceLookupOrder,
  requestFingerprint,
  verifyMailgunSignature,
} from "../lib/mailgun.ts";
import {
  extractEmailAddress,
  mailboxFromRecipients,
  parseAddressList,
} from "../lib/mailboxes.ts";

const secret = "test-signing-key-not-a-production-secret";
const nowSeconds = 1_800_000_000;

function signature(timestamp = nowSeconds, token = "token-123456789") {
  return {
    timestamp: String(timestamp),
    token,
    signature: createHmac("sha256", secret)
      .update(`${timestamp}${token}`)
      .digest("hex"),
  };
}

test("accepts a fresh authentic Mailgun signature", async () => {
  assert.deepEqual(
    await verifyMailgunSignature(signature(), {
      secret,
      nowMs: nowSeconds * 1000,
    }),
    { ok: true, timestamp: nowSeconds, token: "token-123456789" },
  );
});

test("rejects invalid, expired, future, and replayed signatures", async (t) => {
  await t.test("invalid digest", async () => {
    const input = signature();
    input.signature = "0".repeat(64);
    assert.deepEqual(
      await verifyMailgunSignature(input, {
        secret,
        nowMs: nowSeconds * 1000,
      }),
      { ok: false, reason: "invalid_signature" },
    );
  });

  await t.test("expired", async () => {
    assert.deepEqual(
      await verifyMailgunSignature(signature(nowSeconds - 901), {
        secret,
        nowMs: nowSeconds * 1000,
        maxAgeSeconds: 900,
      }),
      { ok: false, reason: "expired" },
    );
  });

  await t.test("too far in the future", async () => {
    assert.deepEqual(
      await verifyMailgunSignature(signature(nowSeconds + 61), {
        secret,
        nowMs: nowSeconds * 1000,
        futureToleranceSeconds: 60,
      }),
      { ok: false, reason: "future_timestamp" },
    );
  });

  await t.test("replayed token", async () => {
    assert.deepEqual(
      await verifyMailgunSignature(signature(), {
        secret,
        nowMs: nowSeconds * 1000,
        isReplay: async (token) => token === "token-123456789",
      }),
      { ok: false, reason: "replayed" },
    );
  });
});

test("normalizes addresses and classifies only the two exact CRM mailboxes", () => {
  assert.equal(extractEmailAddress('"Ada Lovelace" <ADA@example.com>'), "ada@example.com");
  assert.deepEqual(
    parseAddressList('"Lovelace, Ada" <ada@example.com>, Bob <bob@example.net>'),
    ["ada@example.com", "bob@example.net"],
  );
  assert.equal(
    mailboxFromRecipients(["Prospect <BONJOUR@27PM.ORG>"])?.purpose,
    "sales",
  );
  assert.equal(mailboxFromRecipients(["admin@27pm.org"])?.purpose, "operations");
  assert.equal(mailboxFromRecipients(["bonjour@27pm.org", "admin@27pm.org"]), null);
  assert.equal(mailboxFromRecipients(["bonjour@attacker.example"]), null);
});

test("threads replies by normalized RFC message references", async () => {
  assert.equal(normalizeMessageId(" <Root.ID@Example.COM> "), "root.id@example.com");
  assert.deepEqual(
    messageIdsFromHeader("<root@example.com> <reply@example.com>"),
    ["root@example.com", "reply@example.com"],
  );
  assert.deepEqual(
    referenceLookupOrder("<latest@example.com>", [
      "root@example.com",
      "middle@example.com",
    ]),
    ["latest@example.com", "middle@example.com", "root@example.com"],
  );
  assert.equal(normalizeSubject(" Re: RÉ:  Nouveau site  "), "nouveau site");
  assert.equal(
    await deriveThreadKey({
      mailboxId: "mailbox_bonjour",
      counterparty: "client@example.com",
      subject: "Re: Projet",
      messageId: "third@example.com",
      inReplyTo: "second@example.com",
      references: ["root@example.com", "second@example.com"],
    }),
    "message:root@example.com",
  );
});

test("fallback thread and callback identities are deterministic", async () => {
  const firstThread = await deriveThreadKey({
    mailboxId: "mailbox_bonjour",
    counterparty: "CLIENT@example.com",
    subject: "RE: Site vitrine",
  });
  const secondThread = await deriveThreadKey({
    mailboxId: "mailbox_bonjour",
    counterparty: "client@example.com",
    subject: "Site   vitrine",
  });
  assert.equal(firstThread, secondThread);

  const mailbox = mailboxFromRecipients(["bonjour@27pm.org"]);
  assert.ok(mailbox);
  const baseInbound = {
    mailbox,
    sender: "client@example.com",
    subject: "Projet",
    textBody: "Bonjour",
    occurredAt: "2026-08-25T12:00:00.000Z",
    messageId: "mailgun-message@example.com",
  };
  assert.equal(
    await inboundCallbackKey(baseInbound),
    await inboundCallbackKey({ ...baseInbound, textBody: "Contenu modifié" }),
  );

  const event = parseMailgunEventJson({
    signature: signature(),
    "event-data": {
      id: "event-123",
      event: "delivered",
      timestamp: nowSeconds,
      recipient: "client@example.com",
      message: { headers: { "message-id": "<mailgun-message@example.com>" } },
    },
  });
  assert.equal(await eventCallbackKey(event), "event:event-123");
});

test("send idempotency keys and canonical request hashes are stable", async () => {
  assert.equal(normalizeCommandIdempotencyKey(" send:client:0001 "), "send:client:0001");
  assert.equal(normalizeCommandIdempotencyKey("short"), null);
  assert.equal(normalizeCommandIdempotencyKey("bad key with spaces"), null);
  assert.equal(
    await requestFingerprint({ subject: "Bonjour", to: ["a@example.com"] }),
    await requestFingerprint({ to: ["a@example.com"], subject: "Bonjour" }),
  );
});

test("operator allowlist is exact and fails closed", () => {
  assert.deepEqual(
    [...parseOperatorAllowlist(" Owner@Example.com, second@example.com ")],
    ["owner@example.com", "second@example.com"],
  );
  const request = new Request("https://crm.27pm.org/api/dashboard", {
    headers: { "oai-authenticated-user-email": "OWNER@example.com" },
  });
  assert.deepEqual(authorizeCrmRequest(request, "owner@example.com"), {
    ok: true,
    operator: { email: "owner@example.com" },
  });
  assert.deepEqual(authorizeCrmRequest(request, ""), {
    ok: false,
    status: 503,
    code: "allowlist_unconfigured",
  });
  assert.equal(
    authorizeCrmRequest(request, "other@example.com").ok,
    false,
  );
});

test("unscanned and unsafe attachments cannot be downloaded", () => {
  assert.deepEqual(attachmentDownloadDecision("unscanned"), {
    allowed: false,
    status: 423,
    code: "attachment_unscanned",
  });
  assert.deepEqual(attachmentDownloadDecision("infected"), {
    allowed: false,
    status: 403,
    code: "attachment_blocked",
  });
  assert.deepEqual(attachmentDownloadDecision("clean"), { allowed: true });
});
