import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  DELIVERABILITY_CANARY_RECIPIENT,
  deliverabilityCanaryApprovalDigest,
  deliverabilityCanaryTransmittedText,
  parseDeliverabilityCanaryContent,
  resolveDeliverabilityCanaryRecipient,
} from "../lib/deliverability-canary.ts";
import {
  recordDeliverabilityCanaryResult,
  reserveDeliverabilityCanary,
} from "../lib/deliverability-canary-ledger.ts";
import { canaryApprovalFromValue } from "../scripts/build-mailgun-canary-approval.mjs";

test("the configured Gmail seed remains the default and only primary target", () => {
  assert.equal(
    resolveDeliverabilityCanaryRecipient(
      undefined,
      DELIVERABILITY_CANARY_RECIPIENT,
      null,
    ),
    DELIVERABILITY_CANARY_RECIPIENT,
  );
  assert.equal(
    resolveDeliverabilityCanaryRecipient(
      "somebody@gmail.com",
      DELIVERABILITY_CANARY_RECIPIENT,
      null,
    ),
    null,
  );
  assert.equal(
    resolveDeliverabilityCanaryRecipient(
      DELIVERABILITY_CANARY_RECIPIENT,
      "different@gmail.com",
      null,
    ),
    null,
  );
});

test("an Outlook seed is accepted only when it exactly matches the private runtime pin", () => {
  const configured = "controlled.seed@outlook.com";
  assert.equal(
    resolveDeliverabilityCanaryRecipient(
      configured,
      DELIVERABILITY_CANARY_RECIPIENT,
      configured,
    ),
    configured,
  );
  assert.equal(
    resolveDeliverabilityCanaryRecipient(
      "other@outlook.com",
      DELIVERABILITY_CANARY_RECIPIENT,
      configured,
    ),
    null,
  );
  assert.equal(
    resolveDeliverabilityCanaryRecipient(
      configured,
      DELIVERABILITY_CANARY_RECIPIENT,
      null,
    ),
    null,
  );
});

test("the Outlook pin must be one canonical mailbox, not another domain or address list", () => {
  for (const pin of [
    "controlled.seed@gmail.com",
    "controlled.seed@outlook.com,other@outlook.com",
    " CONTROLLED.SEED@OUTLOOK.COM ",
    DELIVERABILITY_CANARY_RECIPIENT,
  ]) {
    assert.equal(
      resolveDeliverabilityCanaryRecipient(
        "controlled.seed@outlook.com",
        DELIVERABILITY_CANARY_RECIPIENT,
        pin,
      ),
      null,
      pin,
    );
  }
});

test("the Outlook approval binds the exact canonical recipient, sender, subject, and text", async () => {
  const input = {
    recipient: "controlled.seed@outlook.com",
    subject: "27PM controlled test",
    text: "One approved message.",
  };
  const approval = await canaryApprovalFromValue(input);
  assert.equal(approval.runtimeSecret, "CRM_CANARY_OUTLOOK_APPROVAL_SHA256");
  assert.equal(approval.approvalSha256, await deliverabilityCanaryApprovalDigest(input));
  for (const changed of [
    { ...input, recipient: "another.seed@outlook.com" },
    { ...input, subject: "A different subject" },
    { ...input, text: "One changed message." },
  ]) {
    assert.notEqual(approval.approvalSha256, await deliverabilityCanaryApprovalDigest(changed));
  }
  assert.deepEqual(parseDeliverabilityCanaryContent(input), {
    subject: input.subject,
    text: input.text,
  });
  assert.equal(parseDeliverabilityCanaryContent({ subject: "bad\ud800", text: input.text }), null);
  await assert.rejects(canaryApprovalFromValue({ ...input, recipient: "controlled.seed@gmail.com" }), /recipient_invalid/u);
  await assert.rejects(canaryApprovalFromValue({ ...input, subject: " subject " }), /content_invalid/u);
  await assert.rejects(canaryApprovalFromValue({ ...input, text: "text\n" }), /content_invalid/u);
});

test("the transmitted text adds only the disclosed identifier and send time", () => {
  assert.equal(
    deliverabilityCanaryTransmittedText(
      "Test technique de placement demandé par Alexis. Aucune action requise.",
      "canary-example",
      "2026-09-20T22:39:00.000Z",
    ),
    "Test technique de placement demandé par Alexis. Aucune action requise.\n\nIdentifiant : canary-example\nEnvoyé à : 2026-09-20T22:39:00.000Z",
  );
});

test("the immutable D1 audit reservation admits one concurrent attempt and never releases it", async (t) => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE audit_entries (
    id TEXT PRIMARY KEY NOT NULL, actor_email TEXT NOT NULL,
    action TEXT NOT NULL, entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL, details_json TEXT NOT NULL
  )`);
  sqlite.exec(`CREATE TRIGGER audit_entries_no_update BEFORE UPDATE ON audit_entries
    BEGIN SELECT RAISE(ABORT, 'audit_entries_are_immutable'); END`);
  sqlite.exec(`CREATE TRIGGER audit_entries_no_delete BEFORE DELETE ON audit_entries
    BEGIN SELECT RAISE(ABORT, 'audit_entries_are_immutable'); END`);
  const db = {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async run() {
              const result = sqlite.prepare(sql).run(...values);
              return { success: true, meta: { changes: result.changes } };
            },
          };
        },
      };
    },
  };
  const approvalDigest = "a".repeat(64);
  const base = {
    approvalDigest,
    operator: "operator@example.com",
    recipient: "controlled.seed@outlook.com",
    subject: "27PM controlled test",
    sentAt: "2026-09-20T18:39:00.000Z",
  };
  const attempts = await Promise.all(
    Array.from({ length: 8 }, (_, i) => reserveDeliverabilityCanary(db, {
      ...base,
      canaryId: `canary-${i}`,
    })),
  );
  assert.equal(attempts.filter(Boolean).length, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM audit_entries").get().total, 1);
  assert.throws(() => sqlite.exec("DELETE FROM audit_entries"), /immutable/u);
  await recordDeliverabilityCanaryResult(db, {
    approvalDigest,
    canaryId: "canary-0",
    operator: base.operator,
    result: "accepted",
    providerMessageId: "test@27pm.org",
  });
  await assert.rejects(recordDeliverabilityCanaryResult(db, {
    approvalDigest,
    canaryId: "canary-0",
    operator: base.operator,
    result: "accepted",
  }), /canary_result_record_failed/u);
  assert.equal(await reserveDeliverabilityCanary(db, { ...base, canaryId: "replay" }), false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM audit_entries").get().total, 2);
});
