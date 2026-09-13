#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { chmod, link, mkdir, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildCakemailPayload,
  createCakemailExternalMessageId,
} from "../lib/cakemail-message.ts";
import { mailboxForAddress } from "../lib/mailboxes.ts";
import { readBoundedResponseBytes } from "./read-bounded-response.mjs";

const PERSONAL_ACCESS_TOKEN = /^ck_pat_[a-f0-9]{40}$/u;
const PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MESSAGE_ID = /^[^<>\s@]+@[^<>\s@]+$/u;
const CANARY_EXTERNAL_MESSAGE_ID =
  /^cakemail\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@27pm\.org$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const RESPONSE_MAX_BYTES = 64 * 1_024;
const DEFAULT_RECEIPT_DIRECTORY = join(
  homedir(),
  ".local",
  "state",
  "27pm-crm",
  "cakemail-canaries",
);

export class CakemailCanaryError extends Error {
  constructor(message) {
    super(message);
    this.name = "CakemailCanaryError";
  }
}

export function canaryPayloadFromEnvironment(
  env = process.env,
  createUuid = () => crypto.randomUUID(),
) {
  const fromAddress = requiredValue(env, "CAKEMAIL_CANARY_FROM");
  const recipient = requiredValue(env, "CAKEMAIL_CANARY_RECIPIENT");
  const mailbox = mailboxForAddress(fromAddress);
  if (!mailbox || mailbox.address !== fromAddress) {
    throw new CakemailCanaryError(
      "CAKEMAIL_CANARY_FROM must be an approved 27PM mailbox.",
    );
  }
  const configuredFromName = optionalValue(env, "CAKEMAIL_CANARY_FROM_NAME");
  if (
    configuredFromName !== null &&
    configuredFromName !== mailbox.displayName
  ) {
    throw new CakemailCanaryError(
      "CAKEMAIL_CANARY_FROM_NAME must match the production mailbox identity.",
    );
  }

  const listId = positiveInteger(env, "CAKEMAIL_LIST_ID");
  const contentMode = requiredValue(env, "CAKEMAIL_CONTENT_MODE");
  if (contentMode !== "html" && contentMode !== "text") {
    throw new CakemailCanaryError(
      "CAKEMAIL_CONTENT_MODE must be html or text.",
    );
  }
  const senderId = requiredValue(env, "CAKEMAIL_CANARY_SENDER_ID");
  const parentMessageId = canaryParentMessageId(env);
  const unsubscribeUrl = requiredValue(
    env,
    "CAKEMAIL_CANARY_UNSUBSCRIBE_URL",
  );
  const externalMessageId = canaryExternalMessageId(
    env,
    fromAddress,
    createUuid,
  );

  return buildCakemailPayload(
    {
      fromAddress,
      fromName: mailbox.displayName,
      to: [recipient],
      subject: "[27PM] Canari technique Cakemail autorisé",
      text:
        "Canari technique unique pour valider le transport, les en-têtes et l’authentification Cakemail de 27PM.",
      html:
        "<p>Canari technique unique pour valider le transport, les en-têtes et l’authentification Cakemail de 27PM.</p>",
      inReplyTo: parentMessageId,
      references: [parentMessageId],
      replyTo: fromAddress,
      unsubscribeUrl,
      tags: ["source-crm", "traffic-canary"],
    },
    {
      listId,
      contentMode,
      senderIds: { [fromAddress]: senderId },
    },
    externalMessageId,
  );
}

export function previewCanaryFromEnvironment(
  env = process.env,
  createUuid = () => crypto.randomUUID(),
) {
  const payload = canaryPayloadFromEnvironment(env, createUuid);
  const payloadSha256 = canaryPayloadSha256(payload);
  const externalMessageId = payload.additional_headers
    .find(({ name }) => name === "Message-ID")
    ?.value.replace(/^<|>$/gu, "");
  return {
    action: "review-only",
    payloadSha256,
    externalMessageId,
    approval: `send-one-canary-to:${payload.email}:sha256:${payloadSha256}`,
    payload,
  };
}

function canaryParentMessageId(env) {
  const value = requiredValue(env, "CAKEMAIL_CANARY_PARENT_MESSAGE_ID");
  if (
    value.length > 512 ||
    value.toLowerCase() !== value ||
    !MESSAGE_ID.test(value)
  ) {
    throw new CakemailCanaryError(
      "CAKEMAIL_CANARY_PARENT_MESSAGE_ID is invalid.",
    );
  }
  return value;
}

export async function sendCanaryFromEnvironment(
  env = process.env,
  fetcher = fetch,
  createUuid = () => crypto.randomUUID(),
  reserveAttempt = reserveCanaryAttempt,
  recordResult = recordCanaryAttemptResult,
) {
  const dispatch = approvedCanaryDispatch(env, createUuid);
  await reserveAttempt(dispatch.payloadSha256);
  const response = await postCanary(dispatch, fetcher, recordResult);
  await assertCanaryHttpOutcome(dispatch, response, recordResult);
  const providerResponse = await readCanaryProviderResponse(
    dispatch,
    response,
    recordResult,
  );
  const outcome = canaryProviderOutcome(
    providerResponse,
    dispatch.payload.email,
  );
  await recordResult(
    dispatch.payloadSha256,
    terminalEvidence(
      dispatch,
      outcome.status,
      response.status,
      outcome.providerMessageId,
    ),
  );

  if (outcome.status === "rejected") {
    throw new CakemailCanaryError(
      `Cakemail canary reported a definitive ${outcome.providerStatus} outcome.`,
    );
  }
  if (outcome.status === "outcome_unknown") throw unknownCanaryOutcome();
  return {
    accepted: true,
    providerMessageId: outcome.providerMessageId,
    externalMessageId: dispatch.externalMessageId,
  };
}

function approvedCanaryDispatch(env, createUuid) {
  const pat = requiredValue(env, "CAKEMAIL_PAT");
  if (!PERSONAL_ACCESS_TOKEN.test(pat)) {
    throw new CakemailCanaryError("CAKEMAIL_PAT is invalid.");
  }
  const accountId = positiveInteger(env, "CAKEMAIL_ACCOUNT_ID");
  if (!optionalValue(env, "CAKEMAIL_CANARY_EXTERNAL_MESSAGE_ID")) {
    throw new CakemailCanaryError(
      "CAKEMAIL_CANARY_EXTERNAL_MESSAGE_ID must freeze the reviewed payload.",
    );
  }
  const payload = canaryPayloadFromEnvironment(env, createUuid);
  const payloadSha256 = canaryPayloadSha256(payload);
  const approvedSha256 = requiredValue(
    env,
    "CAKEMAIL_CANARY_PAYLOAD_SHA256",
  );
  if (
    !SHA256.test(approvedSha256) ||
    !safeTextEqual(approvedSha256, payloadSha256) ||
    requiredValue(env, "CAKEMAIL_CANARY_APPROVAL") !==
      `send-one-canary-to:${payload.email}:sha256:${payloadSha256}`
  ) {
    throw new CakemailCanaryError(
      "Cakemail canary approval does not match the exact reviewed payload.",
    );
  }
  const externalMessageId = payload.additional_headers
    .find(({ name }) => name === "Message-ID")
    ?.value.replace(/^<|>$/gu, "");
  return { accountId, externalMessageId, pat, payload, payloadSha256 };
}

function terminalEvidence(
  dispatch,
  status,
  responseStatus,
  providerMessageId = null,
) {
  return {
    status,
    accountId: dispatch.accountId,
    recipient: dispatch.payload.email,
    externalMessageId: dispatch.externalMessageId,
    providerMessageId,
    responseStatus,
  };
}

async function postCanary(dispatch, fetcher, recordResult) {
  const url = new URL("https://api.cakemail.dev/v2/emails");
  url.searchParams.set("account_id", String(dispatch.accountId));
  try {
    return await fetcher(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${dispatch.pat}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(dispatch.payload),
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    await recordResult(
      dispatch.payloadSha256,
      terminalEvidence(dispatch, "outcome_unknown", null),
    );
    throw unknownCanaryOutcome();
  }
}

async function assertCanaryHttpOutcome(dispatch, response, recordResult) {
  if (response.status === 201) return;
  const status = definitiveCanaryHttpRejection(response.status)
    ? "rejected"
    : "outcome_unknown";
  await recordResult(
    dispatch.payloadSha256,
    terminalEvidence(dispatch, status, response.status),
  );
  if (status === "rejected") {
    throw new CakemailCanaryError(
      `Cakemail canary was rejected with HTTP ${response.status}.`,
    );
  }
  throw unknownCanaryOutcome();
}

function definitiveCanaryHttpRejection(status) {
  return status >= 400 && status <= 499 && status !== 408 && status !== 429;
}

async function readCanaryProviderResponse(dispatch, response, recordResult) {
  try {
    return await boundedJson(response);
  } catch {
    await recordResult(
      dispatch.payloadSha256,
      terminalEvidence(dispatch, "outcome_unknown", response.status),
    );
    throw unknownCanaryOutcome();
  }
}

function canaryProviderOutcome(providerResponse, recipient) {
  const data = objectValue(providerResponse?.data);
  if (!validCanaryProviderEnvelope(providerResponse, data, recipient)) {
    return { status: "outcome_unknown", providerMessageId: null };
  }
  const providerMessageId = data.id.toLowerCase();
  if (data.status === "rejected" || data.status === "error") {
    return {
      status: "rejected",
      providerMessageId,
      providerStatus: data.status,
    };
  }
  if (data.status !== "queued" || providerResponse.submitted === false) {
    return { status: "outcome_unknown", providerMessageId };
  }
  return { status: "accepted", providerMessageId };
}

function validCanaryProviderEnvelope(providerResponse, data, recipient) {
  return Boolean(
    providerResponse &&
      data &&
      (providerResponse.submitted === undefined ||
        typeof providerResponse.submitted === "boolean") &&
      providerResponse.email === recipient &&
      typeof data.id === "string" &&
      PROVIDER_UUID.test(data.id),
  );
}

export async function reserveCanaryAttempt(
  payloadSha256,
  receiptDirectory = DEFAULT_RECEIPT_DIRECTORY,
) {
  if (!SHA256.test(payloadSha256)) {
    throw new CakemailCanaryError("Cakemail canary receipt digest is invalid.");
  }

  try {
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    await chmod(receiptDirectory, 0o700);
  } catch {
    throw new CakemailCanaryError(
      "Cakemail canary receipt storage is unavailable; nothing was sent.",
    );
  }

  let receipt;
  try {
    receipt = await open(
      join(receiptDirectory, `${payloadSha256}.json`),
      "wx",
      0o600,
    );
    await receipt.writeFile(
      `${JSON.stringify({
        version: 1,
        payloadSha256,
        reservedAt: new Date().toISOString(),
        status: "dispatching",
      })}\n`,
      { encoding: "utf8" },
    );
    await receipt.sync();
  } catch (cause) {
    if (objectValue(cause)?.code === "EEXIST") {
      throw new CakemailCanaryError(
        "This exact Cakemail canary was already attempted; do not send it again.",
      );
    }
    throw new CakemailCanaryError(
      "Cakemail canary receipt storage is unavailable; nothing was sent.",
    );
  } finally {
    await receipt?.close().catch(() => {});
  }
}

export async function recordCanaryAttemptResult(
  payloadSha256,
  result,
  receiptDirectory = DEFAULT_RECEIPT_DIRECTORY,
) {
  if (!SHA256.test(payloadSha256) || !validTerminalResult(result)) {
    throw new CakemailCanaryError(
      "Cakemail canary terminal result is invalid; do not retry.",
    );
  }
  try {
    await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
    await chmod(receiptDirectory, 0o700);
  } catch {
    throw terminalResultPersistenceError();
  }

  const resultPath = join(receiptDirectory, `${payloadSha256}.result.json`);
  const temporaryPath = join(
    receiptDirectory,
    `.${payloadSha256}.${crypto.randomUUID()}.tmp`,
  );
  let temporary;
  try {
    temporary = await open(temporaryPath, "wx", 0o600);
    await temporary.writeFile(
      `${JSON.stringify({
        version: 1,
        payloadSha256,
        recordedAt: new Date().toISOString(),
        ...result,
      })}\n`,
      { encoding: "utf8" },
    );
    await temporary.sync();
    await temporary.close();
    temporary = null;
    await link(temporaryPath, resultPath);
    await unlink(temporaryPath);
  } catch {
    await temporary?.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw terminalResultPersistenceError();
  }
}

function validTerminalResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  return (
    ["accepted", "rejected", "outcome_unknown"].includes(result.status) &&
    Number.isSafeInteger(result.accountId) &&
    result.accountId > 0 &&
    typeof result.recipient === "string" &&
    result.recipient.length > 0 &&
    typeof result.externalMessageId === "string" &&
    CANARY_EXTERNAL_MESSAGE_ID.test(result.externalMessageId) &&
    (result.providerMessageId === null ||
      (typeof result.providerMessageId === "string" &&
        PROVIDER_UUID.test(result.providerMessageId))) &&
    (result.responseStatus === null ||
      (Number.isInteger(result.responseStatus) &&
        result.responseStatus >= 100 &&
        result.responseStatus <= 599))
  );
}

function terminalResultPersistenceError() {
  return new CakemailCanaryError(
    "Cakemail canary terminal result could not be persisted; do not retry.",
  );
}

function canaryExternalMessageId(env, fromAddress, createUuid) {
  const configured = optionalValue(env, "CAKEMAIL_CANARY_EXTERNAL_MESSAGE_ID");
  if (configured === null) {
    return createCakemailExternalMessageId(fromAddress, createUuid);
  }
  if (!CANARY_EXTERNAL_MESSAGE_ID.test(configured)) {
    throw new CakemailCanaryError(
      "CAKEMAIL_CANARY_EXTERNAL_MESSAGE_ID is invalid.",
    );
  }
  return configured;
}

function canaryPayloadSha256(payload) {
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function safeTextEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function requiredValue(env, name) {
  const value = optionalValue(env, name);
  if (value === null) {
    throw new CakemailCanaryError(`${name} is required.`);
  }
  return value;
}

function optionalValue(env, name) {
  const value = env[name];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new CakemailCanaryError(`${name} is invalid.`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function positiveInteger(env, name) {
  const raw = requiredValue(env, name);
  if (!/^[1-9][0-9]*$/u.test(raw)) {
    throw new CakemailCanaryError(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CakemailCanaryError(`${name} must be a positive integer.`);
  }
  return value;
}

async function boundedJson(response) {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) ||
      Number(declaredLength) > RESPONSE_MAX_BYTES)
  ) {
    throw unknownCanaryOutcome();
  }
  if (!response.body) {
    throw unknownCanaryOutcome();
  }
  try {
    const bytes = await readBoundedResponseBytes(
      response.body,
      RESPONSE_MAX_BYTES,
    );
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return objectValue(value);
  } catch {
    throw unknownCanaryOutcome();
  }
}

function unknownCanaryOutcome() {
  return new CakemailCanaryError(
    "Cakemail canary outcome is unknown; do not retry automatically.",
  );
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const result = process.argv.includes("--send")
    ? await sendCanaryFromEnvironment()
    : previewCanaryFromEnvironment();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
