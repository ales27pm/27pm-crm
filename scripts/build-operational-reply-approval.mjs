#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { normalizeMessageId } from "../lib/mailgun.ts";
import { mailboxForAddress, normalizeEmailAddress } from "../lib/mailboxes.ts";
import { operationalReplyApprovalDigest } from "../lib/operational-reply.ts";
import { isWellFormedUnicode } from "../lib/unicode.ts";

// The server accepts two million JavaScript code units. JSON can encode one
// code unit as a six-byte \uXXXX escape, so keep the file bound aligned with
// that runtime contract plus a small allowance for the fixed envelope.
const INPUT_MAX_BYTES = 12_100_000;
const APPROVAL_FIELDS = [
  "conversationId",
  "conversationSubject",
  "mailboxId",
  "mailboxAddress",
  "recipient",
  "inboundMessageId",
  "inboundExternalMessageId",
  "text",
];

export class OperationalReplyApprovalError extends Error {
  constructor(code) {
    super(code);
    this.name = "OperationalReplyApprovalError";
    this.code = code;
  }
}

export function operationalReplyApprovalFromValue(value) {
  const approval = validatedApproval(value);
  return operationalReplyApprovalDigest(approval).then((approvalSha256) => ({
    action: "configure-one-exact-operational-reply",
    approvalSha256,
    runtimeSecret: "CRM_OPERATIONAL_REPLY_APPROVAL_SHA256",
    scope: {
      conversationId: approval.conversationId,
      conversationSubject: approval.conversationSubject,
      mailboxId: approval.mailboxId,
      mailboxAddress: approval.mailboxAddress,
      recipient: approval.recipient,
      inboundMessageId: approval.inboundMessageId,
      inboundExternalMessageId: approval.inboundExternalMessageId,
      textLength: approval.text.length,
      textSha256: createHash("sha256").update(approval.text).digest("hex"),
    },
  }));
}

export async function operationalReplyApprovalFromFile(inputPath) {
  if (typeof inputPath !== "string" || inputPath.trim() !== inputPath || !inputPath) {
    throw new OperationalReplyApprovalError("input_path_invalid");
  }
  let handle;
  try {
    handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new OperationalReplyApprovalError("input_file_unavailable");
  }
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size === 0 || file.size > INPUT_MAX_BYTES) {
      throw new OperationalReplyApprovalError("input_file_invalid");
    }
    if ((file.mode & 0o077) !== 0) {
      throw new OperationalReplyApprovalError("input_file_permissions_invalid");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength === 0 || bytes.byteLength > INPUT_MAX_BYTES) {
      throw new OperationalReplyApprovalError("input_file_invalid");
    }
    try {
      const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return operationalReplyApprovalFromValue(JSON.parse(source));
    } catch (error) {
      if (error instanceof OperationalReplyApprovalError) throw error;
      throw new OperationalReplyApprovalError("input_json_invalid");
    }
  } finally {
    await handle.close();
  }
}

export function inputPathFromArguments(arguments_) {
  if (!Array.isArray(arguments_) || arguments_.length !== 1) {
    throw new OperationalReplyApprovalError("usage");
  }
  const match = arguments_[0].match(/^--input=(.+)$/u);
  if (!match) throw new OperationalReplyApprovalError("usage");
  return match[1];
}

function validatedApproval(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new OperationalReplyApprovalError("approval_object_invalid");
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== APPROVAL_FIELDS.length ||
    keys.some((key, index) => key !== [...APPROVAL_FIELDS].sort()[index])
  ) {
    throw new OperationalReplyApprovalError("approval_fields_invalid");
  }
  for (const field of APPROVAL_FIELDS) {
    if (typeof value[field] !== "string") {
      throw new OperationalReplyApprovalError("approval_fields_invalid");
    }
  }

  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value.conversationId)) {
    throw new OperationalReplyApprovalError("conversation_id_invalid");
  }
  if (
    value.conversationSubject.length === 0 ||
    value.conversationSubject.length > 500 ||
    value.conversationSubject !== value.conversationSubject.trim() ||
    !isWellFormedUnicode(value.conversationSubject) ||
    /[\r\n]/u.test(value.conversationSubject)
  ) {
    throw new OperationalReplyApprovalError("conversation_subject_invalid");
  }
  const mailbox = mailboxForAddress(value.mailboxAddress);
  if (
    !mailbox ||
    mailbox.purpose !== "operations" ||
    mailbox.id !== value.mailboxId ||
    mailbox.address !== value.mailboxAddress
  ) {
    throw new OperationalReplyApprovalError("mailbox_invalid");
  }
  if (
    normalizeEmailAddress(value.recipient) !== value.recipient ||
    mailboxForAddress(value.recipient) ||
    value.recipient.length > 254
  ) {
    throw new OperationalReplyApprovalError("recipient_invalid");
  }
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(value.inboundMessageId)) {
    throw new OperationalReplyApprovalError("inbound_message_id_invalid");
  }
  if (
    normalizeMessageId(value.inboundExternalMessageId) !==
      value.inboundExternalMessageId
  ) {
    throw new OperationalReplyApprovalError("inbound_external_message_id_invalid");
  }
  if (
    value.text.length === 0 ||
    value.text.length > 2_000_000 ||
    value.text !== value.text.trim() ||
    !isWellFormedUnicode(value.text)
  ) {
    throw new OperationalReplyApprovalError("text_invalid");
  }
  return Object.fromEntries(
    APPROVAL_FIELDS.map((field) => [field, value[field]]),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await operationalReplyApprovalFromFile(
      inputPathFromArguments(process.argv.slice(2)),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code = error instanceof OperationalReplyApprovalError
      ? error.code
      : "approval_generation_failed";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = code === "usage" ? 64 : 1;
  }
}
