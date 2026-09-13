import { bytesToHex } from "./byte-utils";
import { normalizedMailboxProvider } from "./mailgun-event-metadata";

export const CAKEMAIL_WEBHOOK_MAX_BYTES = 256 * 1024;

export type CakemailWebhookVerification =
  | { ok: true }
  | {
      ok: false;
      reason: "missing_secrets" | "malformed_signature" | "invalid_signature";
    };

export type CakemailFailureClass =
  | "hard_bounce"
  | "complaint"
  | "unsubscribe"
  | "temporary"
  | "other_permanent";

export type ParsedCakemailEvent = {
  providerEventId: string | null;
  providerMessageId: string;
  eventType:
    | "accepted"
    | "delivered"
    | "rejected"
    | "failed"
    | "bounce"
    | "complained"
    | "unsubscribed";
  severity: "temporary" | "permanent" | null;
  reason: string | null;
  recipient: string;
  recipientDomain: string;
  mailboxProvider: "google" | "microsoft" | "yahoo" | "other";
  sendingDomain: string | null;
  sendingIp: string | null;
  failureClass: CakemailFailureClass | null;
  smtpCode: number | null;
  enhancedStatusCode: string | null;
  smtpDescription: string | null;
  attemptNo: number | null;
  tags: string[];
  campaigns: string[];
  eventTimestamp: string;
  signatureTimestamp: number;
  raw: Record<string, unknown>;
  rawBody: string;
};

type NormalizedEvent = Pick<
  ParsedCakemailEvent,
  "eventType" | "severity" | "failureClass"
>;

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_SECRETS_PER_EVENT = 2;
const MAX_SECRET_COUNT = 20;
const MAX_SECRET_LENGTH = 1_024;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_REASON_LENGTH = 1_000;
const MAX_DIMENSION_COUNT = 32;
const PROVIDER_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DIMENSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/u;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const IPV6_LIKE_PATTERN = /^[0-9a-f:]+$/u;

const CAKEMAIL_REQUIRED_WEBHOOK_EVENTS = [
  "sent",
  "delivered",
  "rejected",
  "error",
  "bounced",
  "reported-as-spam",
  "unsubscribed",
  "global-unsubscribed",
] as const;

export type CakemailWebhookEventKey =
  | (typeof CAKEMAIL_REQUIRED_WEBHOOK_EVENTS)[number]
  | "submitted"
  | "queued";

export type CakemailWebhookSecretMap = Readonly<
  Partial<Record<CakemailWebhookEventKey, readonly string[]>>
>;

const CAKEMAIL_EVENTS = new Map<string, CakemailWebhookEventKey>([
  ["email.submitted", "submitted"],
  ["submitted", "submitted"],
  ["email.queued", "queued"],
  ["queued", "queued"],
  ["email.sent", "sent"],
  ["sent", "sent"],
  ["email.delivered", "delivered"],
  ["delivered", "delivered"],
  ["email.rejected", "rejected"],
  ["rejected", "rejected"],
  ["email.error", "error"],
  ["error", "error"],
  ["email.bounced", "bounced"],
  ["bounced", "bounced"],
  ["email.reportedasspam", "reported-as-spam"],
  ["email.reported-as-spam", "reported-as-spam"],
  ["reportedasspam", "reported-as-spam"],
  ["reported-as-spam", "reported-as-spam"],
  ["email.unsubscribed", "unsubscribed"],
  ["unsubscribed", "unsubscribed"],
  ["email.globalunsubscribed", "global-unsubscribed"],
  ["globalunsubscribed", "global-unsubscribed"],
  ["global-unsubscribed", "global-unsubscribed"],
]);

export function parseCakemailWebhookSecrets(
  serialized: string | null | undefined,
): CakemailWebhookSecretMap {
  if (!serialized?.trim()) return {};
  const value = parsedWebhookSecretObject(serialized);
  const configured: Partial<Record<CakemailWebhookEventKey, string[]>> = {};
  const allSecrets = new Set<string>();
  for (const [sourceEvent, candidates] of Object.entries(value)) {
    const event = uniqueWebhookSecretEvent(sourceEvent, configured);
    configured[event] = validatedWebhookSecrets(candidates, allSecrets);
  }
  return configured;
}

function parsedWebhookSecretObject(
  serialized: string,
): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("cakemail_webhook_secrets_invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("cakemail_webhook_secrets_invalid");
  }
  return value as Record<string, unknown>;
}

function uniqueWebhookSecretEvent(
  sourceEvent: string,
  configured: Partial<Record<CakemailWebhookEventKey, string[]>>,
): CakemailWebhookEventKey {
  const event = CAKEMAIL_EVENTS.get(normalizedEventName(sourceEvent));
  if (!event || configured[event]) {
    throw new Error("cakemail_webhook_secrets_invalid");
  }
  return event;
}

function validatedWebhookSecrets(
  candidates: unknown,
  allSecrets: Set<string>,
): string[] {
  if (
    !Array.isArray(candidates) ||
    candidates.length === 0 ||
    candidates.length > MAX_SECRETS_PER_EVENT
  ) {
    throw new Error("cakemail_webhook_secrets_invalid");
  }
  const eventSecrets: string[] = [];
  for (const candidate of candidates) {
    const secret = validatedWebhookSecret(candidate, eventSecrets, allSecrets);
    eventSecrets.push(secret);
    allSecrets.add(secret);
    if (allSecrets.size > MAX_SECRET_COUNT) {
      throw new Error("cakemail_webhook_secrets_invalid");
    }
  }
  return eventSecrets;
}

function validatedWebhookSecret(
  candidate: unknown,
  eventSecrets: readonly string[],
  allSecrets: ReadonlySet<string>,
): string {
  if (typeof candidate !== "string") {
    throw new Error("cakemail_webhook_secrets_invalid");
  }
  const secret = candidate.trim();
  if (
    !secret ||
    secret.length > MAX_SECRET_LENGTH ||
    eventSecrets.includes(secret) ||
    allSecrets.has(secret)
  ) {
    throw new Error("cakemail_webhook_secrets_invalid");
  }
  return secret;
}

export function cakemailWebhookEventKey(
  rawBody: Uint8Array | string,
): CakemailWebhookEventKey {
  const body = typeof rawBody === "string" ? rawBody : decodeBody(rawBody);
  const raw = parsedObject(body);
  return eventKeyFromRaw(raw);
}

export function hasRequiredCakemailWebhookSecrets(
  configured: CakemailWebhookSecretMap,
): boolean {
  return CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.every(
    (event) => (configured[event]?.length ?? 0) > 0,
  );
}

/**
 * Cakemail signs the exact HTTP body with Base64-encoded HMAC-SHA256. Web
 * Crypto performs the digest comparison so application code does not branch
 * over secret-dependent bytes.
 */
export async function verifyCakemailWebhookSignature(
  rawBody: Uint8Array,
  signature: string | null | undefined,
  secrets: readonly string[],
): Promise<CakemailWebhookVerification> {
  if (secrets.length === 0) return { ok: false, reason: "missing_secrets" };
  const suppliedDigest = decodeSha256Base64(signature);
  if (!suppliedDigest) {
    return { ok: false, reason: "malformed_signature" };
  }

  let valid = false;
  for (const secret of secrets) {
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const matches = await crypto.subtle.verify(
      "HMAC",
      key,
      bufferSource(suppliedDigest),
      bufferSource(rawBody),
    );
    valid = matches || valid;
  }
  return valid
    ? { ok: true }
    : { ok: false, reason: "invalid_signature" };
}

export function parseCakemailWebhookEvent(
  rawBody: Uint8Array | string,
): ParsedCakemailEvent {
  const body = typeof rawBody === "string" ? rawBody : decodeBody(rawBody);
  const raw = parsedObject(body);
  const data = objectValue(raw.data);
  const allowedEvent = eventKeyFromRaw(raw);

  const providerMessageId = requiredProviderMessageId(raw, data);
  const recipient = requiredRecipient(raw, data);
  const eventTimestamp = requiredTimestamp(
    firstDefined(raw.timestamp, raw.occurred_at, data.timestamp, data.occurred_at),
  );
  const normalized = normalizedEvent(allowedEvent, data);
  const recipientDomain = recipient.slice(recipient.lastIndexOf("@") + 1);
  const reason = safeDescription(
    firstString(
      data.reason,
      objectValue(data.error).message,
      data.error,
      data.description,
      raw.reason,
    ),
  );
  const sendingDomain = normalizedDomain(
    firstString(data.sender_domain, data.sending_domain) ??
      domainFromAddress(firstString(data.sender_email, data.from_email)),
  );
  const smtpDescription = safeDescription(
    firstString(data.smtp_description, data.smtp_response),
  );

  return {
    providerEventId: optionalIdentifier(
      firstDefined(raw.event_id, raw.id, data.event_id),
    ),
    providerMessageId,
    ...normalized,
    reason,
    recipient,
    recipientDomain,
    mailboxProvider: normalizedMailboxProvider(
      firstString(data.mailbox_provider, data.recipient_provider),
      recipientDomain,
    ),
    sendingDomain,
    sendingIp: normalizedIp(firstString(data.sending_ip, data.ip)),
    smtpCode: boundedInteger(data.smtp_code, 100, 599),
    enhancedStatusCode: enhancedStatusCode(data.enhanced_status_code),
    smtpDescription,
    attemptNo: boundedInteger(data.attempt_no, 1, 10_000),
    tags: safeDimensions(data.tags),
    campaigns: safeDimensions([
      data.campaign_id,
      data.campaignId,
    ]),
    eventTimestamp,
    signatureTimestamp: Math.floor(Date.parse(eventTimestamp) / 1_000),
    raw,
    rawBody: body,
  };
}

function eventKeyFromRaw(
  raw: Record<string, unknown>,
): CakemailWebhookEventKey {
  const sourceEvent = boundedRequiredString(raw.event, 128, "event_invalid");
  const event = CAKEMAIL_EVENTS.get(normalizedEventName(sourceEvent));
  if (!event) throw new Error("event_unsupported");
  return event;
}

export async function cakemailWebhookCallbackKey(
  rawBody: Uint8Array,
): Promise<string> {
  return `cakemail:${await sha256Hex(rawBody)}`;
}

export async function cakemailWebhookReceiptToken(
  rawBody: Uint8Array,
): Promise<string> {
  return `cakemail:${await sha256Hex(rawBody)}`;
}

export function cakemailProviderMessageIdFromPayloadJson(
  payloadJson: string | null | undefined,
): string | null {
  if (!payloadJson) return null;
  try {
    const root = parsedObject(payloadJson);
    return requiredProviderMessageId(root, objectValue(root.data));
  } catch {
    return null;
  }
}

function normalizedEvent(event: string, data: Record<string, unknown>): NormalizedEvent {
  if (["submitted", "queued", "sent"].includes(event)) {
    return { eventType: "accepted", severity: null, failureClass: null };
  }
  if (event === "delivered") {
    return { eventType: "delivered", severity: null, failureClass: null };
  }
  if (event === "rejected") {
    return {
      eventType: "rejected",
      severity: "permanent",
      failureClass: "other_permanent",
    };
  }
  if (event === "error") return normalizedError(data);
  if (event === "bounced") return normalizedBounce(data);
  if (event === "reported-as-spam") {
    return { eventType: "complained", severity: null, failureClass: "complaint" };
  }
  return { eventType: "unsubscribed", severity: null, failureClass: "unsubscribe" };
}

function normalizedError(data: Record<string, unknown>): NormalizedEvent {
  const severity = explicitSeverity(data);
  return {
    eventType: "failed",
    severity,
    failureClass:
      severity === "temporary"
        ? "temporary"
        : severity === "permanent"
          ? "other_permanent"
          : null,
  };
}

function normalizedBounce(data: Record<string, unknown>): NormalizedEvent {
  const bounce = objectValue(data.bounce);
  const hint = normalizedToken(
    firstString(
      data.bounce_type,
      data.bounceType,
      data.bounce,
      bounce.type,
      data.severity,
      data.type,
    ),
  );
  if (["hard", "hard-bounce"].includes(hint)) {
    return {
      eventType: "bounce",
      severity: "permanent",
      failureClass: "hard_bounce",
    };
  }
  if (["soft", "soft-bounce", "temporary", "transient"].includes(hint)) {
    return {
      eventType: "failed",
      severity: "temporary",
      failureClass: "temporary",
    };
  }
  return { eventType: "failed", severity: null, failureClass: null };
}

function explicitSeverity(
  data: Record<string, unknown>,
): "temporary" | "permanent" | null {
  const hint = normalizedToken(
    firstString(data.severity, data.error_type, data.errorType),
  );
  if (["temporary", "transient", "soft", "retryable"].includes(hint)) {
    return "temporary";
  }
  if (["permanent", "fatal", "hard", "non-retryable"].includes(hint)) {
    return "permanent";
  }
  if (data.retryable === true) return "temporary";
  if (data.retryable === false) return "permanent";
  return null;
}

function requiredProviderMessageId(
  raw: Record<string, unknown>,
  data: Record<string, unknown>,
): string {
  const value = firstDefined(
    data.email_id,
    data.emailId,
    raw.email_id,
    raw.emailId,
    data.message_id,
    data.messageId,
    raw.message_id,
    raw.messageId,
  );
  const identifier = optionalIdentifier(value);
  if (!identifier) throw new Error("provider_message_id_invalid");
  return PROVIDER_UUID_PATTERN.test(identifier)
    ? identifier.toLowerCase()
    : identifier;
}

function requiredRecipient(
  raw: Record<string, unknown>,
  data: Record<string, unknown>,
): string {
  const value = firstString(
    data.email_address,
    data.emailAddress,
    data.recipient,
    raw.email_address,
    raw.emailAddress,
    raw.recipient,
  );
  const recipient = value?.trim().toLowerCase() ?? "";
  if (
    recipient.length > 320 ||
    !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/u.test(recipient)
  ) {
    throw new Error("recipient_invalid");
  }
  return recipient;
}

function requiredTimestamp(value: unknown): string {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) throw new Error("timestamp_invalid");
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return validDate(milliseconds);
  }
  if (typeof value !== "string" || value.length > 64) {
    throw new Error("timestamp_invalid");
  }
  const candidate = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}T/u.test(candidate)) {
    throw new Error("timestamp_invalid");
  }
  return validDate(candidate);
}

function validDate(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) throw new Error("timestamp_invalid");
  return date.toISOString();
}

function optionalIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("identifier_invalid");
  const identifier = value.trim();
  if (
    !identifier ||
    identifier.length > MAX_IDENTIFIER_LENGTH ||
    /[\u0000-\u0020\u007f]/u.test(identifier)
  ) {
    throw new Error("identifier_invalid");
  }
  return identifier;
}

function safeDescription(value: string | null): string | null {
  if (!value) return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+/gu, "[email]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH);
  return normalized || null;
}

function safeDimensions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (!DIMENSION_PATTERN.test(normalized) || result.includes(normalized)) continue;
    result.push(normalized);
    if (result.length === MAX_DIMENSION_COUNT) break;
  }
  return result;
}

function normalizedDomain(value: string | null): string | null {
  const domain = value?.trim().toLowerCase().replace(/\.$/u, "") ?? "";
  return domain.length <= 253 && DOMAIN_PATTERN.test(domain) ? domain : null;
}

function domainFromAddress(value: string | null): string | null {
  if (!value?.includes("@")) return null;
  return value.slice(value.lastIndexOf("@") + 1);
}

function normalizedIp(value: string | null): string | null {
  const ip = value?.trim().toLowerCase() ?? "";
  if (ip.length < 3 || ip.length > 45) return null;
  if (IPV4_PATTERN.test(ip)) {
    return ip.split(".").every((part) => Number(part) <= 255) ? ip : null;
  }
  return IPV6_LIKE_PATTERN.test(ip) && ip.includes(":") ? ip : null;
}

function enhancedStatusCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[245]\.\d{1,3}\.\d{1,3}$/u.test(normalized) ? normalized : null;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value.trim())
        ? Number(value)
        : Number.NaN;
  return Number.isInteger(numeric) && numeric >= minimum && numeric <= maximum
    ? numeric
    : null;
}

function decodeSha256Base64(value: string | null | undefined): Uint8Array | null {
  const candidate = value?.trim() ?? "";
  if (!/^[a-zA-Z0-9+/]{43}=?$/u.test(candidate)) return null;
  const padded = candidate.length === 43 ? `${candidate}=` : candidate;
  try {
    const decoded = atob(padded);
    if (decoded.length !== 32) return null;
    return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

function parsedObject(value: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("payload_invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("payload_invalid");
  }
  return parsed as Record<string, unknown>;
}

function decodeBody(value: Uint8Array): string {
  try {
    return decoder.decode(value);
  } catch {
    throw new Error("payload_encoding_invalid");
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function boundedRequiredString(
  value: unknown,
  maximumLength: number,
  errorCode: string,
): string {
  if (typeof value !== "string") throw new Error(errorCode);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) throw new Error(errorCode);
  return normalized;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function normalizedEventName(value: string): string {
  return value.trim().toLowerCase().replace(/[_\s]+/gu, "-");
}

function normalizedToken(value: string | null): string {
  return (value ?? "").trim().toLowerCase().replace(/[_\s]+/gu, "-");
}

async function sha256Hex(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bufferSource(value));
  return bytesToHex(new Uint8Array(digest));
}

function bufferSource(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}
