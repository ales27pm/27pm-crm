#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  deliverabilityCanaryApprovalDigest,
  parseDeliverabilityCanaryContent,
} from "../lib/deliverability-canary.ts";
import { normalizeEmailAddress } from "../lib/mailboxes.ts";
import { isWellFormedUnicode } from "../lib/unicode.ts";

const FIELDS = ["recipient", "subject", "text"];
const MAX_INPUT_BYTES = 125_000;

export class CanaryApprovalError extends Error {
  constructor(code) {
    super(code);
    this.name = "CanaryApprovalError";
    this.code = code;
  }
}

export async function canaryApprovalFromValue(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== FIELDS.slice().sort().join(",")) {
    throw new CanaryApprovalError("approval_fields_invalid");
  }
  const { recipient, subject, text } = value;
  if (typeof recipient !== "string" ||
    normalizeEmailAddress(recipient) !== recipient ||
    !recipient.endsWith("@outlook.com") || recipient.length > 254) {
    throw new CanaryApprovalError("recipient_invalid");
  }
  if (typeof subject !== "string" || typeof text !== "string" ||
    !isWellFormedUnicode(subject) || !isWellFormedUnicode(text)) {
    throw new CanaryApprovalError("content_invalid");
  }
  const parsed = parseDeliverabilityCanaryContent({ subject, text });
  if (!parsed || parsed.subject !== subject || parsed.text !== text) {
    throw new CanaryApprovalError("content_invalid");
  }
  return {
    action: "configure-one-exact-outlook-canary",
    runtimeSecret: "CRM_CANARY_OUTLOOK_APPROVAL_SHA256",
    approvalSha256: await deliverabilityCanaryApprovalDigest({ recipient, subject, text }),
    scope: {
      recipient,
      subject,
      textLength: text.length,
      textSha256: createHash("sha256").update(text).digest("hex"),
    },
  };
}

export async function canaryApprovalFromFile(inputPath) {
  if (typeof inputPath !== "string" || !inputPath || inputPath.trim() !== inputPath) {
    throw new CanaryApprovalError("input_path_invalid");
  }
  let handle;
  try {
    handle = await open(inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    throw new CanaryApprovalError("input_file_unavailable");
  }
  try {
    const file = await handle.stat();
    if (!file.isFile() || file.size === 0 || file.size > MAX_INPUT_BYTES ||
      (file.mode & 0o077) !== 0) {
      throw new CanaryApprovalError("input_file_invalid");
    }
    let value;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await handle.readFile()));
    } catch {
      throw new CanaryApprovalError("input_json_invalid");
    }
    return canaryApprovalFromValue(value);
  } finally {
    await handle.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3 || !process.argv[2].startsWith("--input=")) {
      throw new CanaryApprovalError("usage");
    }
    const approval = await canaryApprovalFromFile(process.argv[2].slice(8));
    process.stdout.write(`${JSON.stringify(approval)}\n`);
  } catch (error) {
    const code = error instanceof CanaryApprovalError ? error.code : "approval_generation_failed";
    process.stderr.write(`${JSON.stringify({ error: code })}\n`);
    process.exitCode = code === "usage" ? 64 : 1;
  }
}
