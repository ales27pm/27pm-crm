import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  OperationalReplyApprovalError,
  inputPathFromArguments,
  operationalReplyApprovalFromFile,
  operationalReplyApprovalFromValue,
} from "../scripts/build-operational-reply-approval.mjs";

const approval = {
  conversationId: "conversation-operations",
  conversationSubject: "Aide",
  mailboxId: "mailbox_admin",
  mailboxAddress: "admin@27pm.org",
  recipient: "isabel@example.com",
  inboundMessageId: "message-isabel-inbound",
  inboundExternalMessageId: "inbound-isabel@example.com",
  text: "Bonjour Isabel,\n\nMerci pour votre précision.",
};

test("builds the exact runtime approval without echoing reply content", async () => {
  const result = await operationalReplyApprovalFromValue(approval);
  const expected = createHash("sha256").update(JSON.stringify({
    version: 1,
    ...approval,
  })).digest("hex");

  assert.equal(result.action, "configure-one-exact-operational-reply");
  assert.equal(result.runtimeSecret, "CRM_OPERATIONAL_REPLY_APPROVAL_SHA256");
  assert.equal(result.approvalSha256, expected);
  assert.equal(result.scope.textLength, approval.text.length);
  assert.equal(
    result.scope.textSha256,
    createHash("sha256").update(approval.text).digest("hex"),
  );
  assert.doesNotMatch(JSON.stringify(result), /Merci pour votre précision/u);
});

test("reads one bounded JSON file and rejects additional approval fields", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "27pm-operational-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const validPath = join(directory, "approval.json");
  const invalidPath = join(directory, "invalid.json");
  const exposedPath = join(directory, "exposed.json");
  const symlinkPath = join(directory, "approval-link.json");
  await writeFile(validPath, JSON.stringify(approval), { mode: 0o600 });
  await writeFile(
    invalidPath,
    JSON.stringify({ ...approval, approved: true }),
    { mode: 0o600 },
  );
  await writeFile(exposedPath, JSON.stringify(approval), { mode: 0o644 });
  await symlink(validPath, symlinkPath);

  assert.equal(
    (await operationalReplyApprovalFromFile(validPath)).scope.recipient,
    approval.recipient,
  );
  await assert.rejects(
    operationalReplyApprovalFromFile(invalidPath),
    (error) =>
      error instanceof OperationalReplyApprovalError &&
      error.code === "approval_fields_invalid",
  );
  await assert.rejects(
    operationalReplyApprovalFromFile(exposedPath),
    (error) =>
      error instanceof OperationalReplyApprovalError &&
      error.code === "input_file_permissions_invalid",
  );
  await assert.rejects(
    operationalReplyApprovalFromFile(symlinkPath),
    (error) =>
      error instanceof OperationalReplyApprovalError &&
      error.code === "input_file_unavailable",
  );
});

test("rejects non-canonical identities, content, and CLI arguments", async () => {
  assert.throws(
    () => operationalReplyApprovalFromValue({
      ...approval,
      mailboxAddress: "bonjour@27pm.org",
      mailboxId: "mailbox_bonjour",
    }),
    /mailbox_invalid/u,
  );
  assert.throws(
    () => operationalReplyApprovalFromValue({ ...approval, recipient: " Isabel@example.com " }),
    /recipient_invalid/u,
  );
  assert.throws(
    () => operationalReplyApprovalFromValue({ ...approval, text: `${approval.text}\n` }),
    /text_invalid/u,
  );
  for (const inboundExternalMessageId of [
    "NOT A MAILGUN MESSAGE ID",
    "Inbound-Isabel@example.com",
    "<inbound-isabel@example.com>",
    `${"a".repeat(501)}@example.com`,
  ]) {
    assert.throws(
      () => operationalReplyApprovalFromValue({ ...approval, inboundExternalMessageId }),
      /inbound_external_message_id_invalid/u,
    );
  }
  assert.equal(inputPathFromArguments(["--input=/tmp/reply.json"]), "/tmp/reply.json");
  assert.throws(() => inputPathFromArguments([]), /usage/u);
  assert.throws(() => inputPathFromArguments(["--input", "/tmp/reply.json"]), /usage/u);
});

test("rejects malformed Unicode without rejecting valid astral characters", async () => {
  for (const text of ["broken-\ud800", "broken-\udc00"]) {
    assert.throws(
      () => operationalReplyApprovalFromValue({ ...approval, text }),
      /text_invalid/u,
    );
  }
  assert.throws(
    () => operationalReplyApprovalFromValue({
      ...approval,
      conversationSubject: "broken-\ud800",
    }),
    /conversation_subject_invalid/u,
  );

  const text = "Bonjour 👋";
  const result = await operationalReplyApprovalFromValue({ ...approval, text });
  assert.equal(result.scope.textLength, text.length);
  assert.equal(
    result.scope.textSha256,
    createHash("sha256").update(text).digest("hex"),
  );
});

test("keeps the file byte bound aligned with valid multibyte reply text", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "27pm-operational-approval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputPath = join(directory, "multibyte.json");
  const multibyteApproval = { ...approval, text: "é".repeat(1_100_000) };
  await writeFile(inputPath, JSON.stringify(multibyteApproval), { mode: 0o600 });

  const result = await operationalReplyApprovalFromFile(inputPath);
  assert.equal(result.scope.textLength, 1_100_000);
});
