import {
  extractDisplayName,
  extractEmailAddress,
  mailboxFromRecipients,
  parseAddressList,
  type CrmMailbox,
} from "./mailboxes";

export type MailgunSignature = {
  timestamp: string;
  token: string;
  signature: string;
};

export type SignatureVerification =
  | { ok: true; timestamp: number; token: string }
  | {
      ok: false;
      reason:
        | "missing_secret"
        | "malformed"
        | "expired"
        | "future_timestamp"
        | "invalid_signature"
        | "replayed";
    };

export type InboundAttachment = {
  fieldName: string;
  file: File;
};

export type ParsedInboundMessage = {
  signature: MailgunSignature;
  mailbox: CrmMailbox;
  sender: string;
  senderName: string | null;
  recipients: string[];
  cc: string[];
  replyTo: string | null;
  subject: string;
  textBody: string | null;
  htmlBody: string | null;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  headers: Record<string, string>;
  occurredAt: string;
  providerStorageKey: string | null;
  attachments: InboundAttachment[];
};

export type ParsedMailgunEvent = {
  signature: MailgunSignature;
  eventId: string | null;
  eventType: string;
  severity: string | null;
  reason: string | null;
  recipient: string | null;
  messageId: string | null;
  eventTimestamp: string;
  raw: Record<string, unknown>;
};

type VerifyOptions = {
  secret: string | null | undefined;
  nowMs?: number;
  maxAgeSeconds?: number;
  futureToleranceSeconds?: number;
  isReplay?: (token: string) => boolean | Promise<boolean>;
};

const encoder = new TextEncoder();

export async function verifyMailgunSignature(
  input: MailgunSignature,
  options: VerifyOptions,
): Promise<SignatureVerification> {
  const secret = options.secret?.trim();
  if (!secret) return { ok: false, reason: "missing_secret" };

  if (
    !/^\d{1,16}$/u.test(input.timestamp) ||
    !/^[a-zA-Z0-9_-]{8,256}$/u.test(input.token) ||
    !/^[a-fA-F0-9]{64}$/u.test(input.signature)
  ) {
    return { ok: false, reason: "malformed" };
  }

  const timestamp = Number(input.timestamp);
  const nowSeconds = Math.floor((options.nowMs ?? Date.now()) / 1000);
  const maxAgeSeconds = options.maxAgeSeconds ?? 900;
  const futureToleranceSeconds = options.futureToleranceSeconds ?? 60;
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return { ok: false, reason: "malformed" };
  }
  if (timestamp < nowSeconds - maxAgeSeconds) {
    return { ok: false, reason: "expired" };
  }
  if (timestamp > nowSeconds + futureToleranceSeconds) {
    return { ok: false, reason: "future_timestamp" };
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${input.timestamp}${input.token}`),
  );
  if (!constantTimeHexEqual(bytesToHex(new Uint8Array(digest)), input.signature)) {
    return { ok: false, reason: "invalid_signature" };
  }

  if (options.isReplay && (await options.isReplay(input.token))) {
    return { ok: false, reason: "replayed" };
  }
  return { ok: true, timestamp, token: input.token };
}

export function parseInboundForm(form: FormData): ParsedInboundMessage {
  const signature = signatureFromForm(form);
  const recipientHeader = formString(form, "recipient") ?? formString(form, "To");
  const recipients = parseAddressList(recipientHeader);
  const mailbox = mailboxFromRecipients(recipients);
  if (!mailbox) throw new Error("mailbox_recipient_invalid");

  const from = formString(form, "from") ?? formString(form, "sender") ?? "";
  const sender = extractEmailAddress(formString(form, "sender") ?? from);
  if (!sender) throw new Error("sender_invalid");

  const headers = parseMessageHeaders(formString(form, "message-headers"));
  const messageId = normalizeMessageId(
    formString(form, "Message-Id") ?? headers["message-id"],
  );
  const inReplyTo = normalizeMessageId(
    formString(form, "In-Reply-To") ?? headers["in-reply-to"],
  );
  const references = messageIdsFromHeader(
    formString(form, "References") ?? headers.references,
  );
  const occurredAt = parseDate(
    formString(form, "Date") ?? headers.date,
    Date.now(),
  );

  const attachments: InboundAttachment[] = [];
  for (const [fieldName, value] of form.entries()) {
    if (!fieldName.toLowerCase().startsWith("attachment-")) continue;
    if (typeof value !== "string") attachments.push({ fieldName, file: value });
  }

  return {
    signature,
    mailbox,
    sender,
    senderName: extractDisplayName(from),
    recipients,
    cc: parseAddressList(formString(form, "Cc")),
    replyTo: extractEmailAddress(formString(form, "Reply-To") ?? ""),
    subject: formString(form, "subject")?.trim() || "(Sans objet)",
    textBody:
      formString(form, "stripped-text") ?? formString(form, "body-plain"),
    htmlBody:
      formString(form, "stripped-html") ?? formString(form, "body-html"),
    messageId,
    inReplyTo,
    references,
    headers,
    occurredAt,
    providerStorageKey:
      formString(form, "storage-key") ?? formString(form, "storage.key"),
    attachments,
  };
}

export function parseMailgunEventJson(value: unknown): ParsedMailgunEvent {
  const root = asObject(value);
  const signatureObject = asObject(root.signature);
  const eventData = asObject(root["event-data"] ?? root.eventData);
  return parsedEvent(
    {
      timestamp: requiredString(signatureObject.timestamp),
      token: requiredString(signatureObject.token),
      signature: requiredString(signatureObject.signature),
    },
    eventData,
  );
}

export function parseMailgunEventForm(form: FormData): ParsedMailgunEvent {
  const eventDataValue = formString(form, "event-data");
  let eventData: Record<string, unknown>;
  if (eventDataValue) {
    eventData = asObject(JSON.parse(eventDataValue));
  } else {
    eventData = Object.fromEntries(
      [...form.entries()].filter(([, value]) => typeof value === "string"),
    );
  }
  return parsedEvent(signatureFromForm(form), eventData);
}

function parsedEvent(
  signature: MailgunSignature,
  eventData: Record<string, unknown>,
): ParsedMailgunEvent {
  const message = asObject(eventData.message);
  const headers = asObject(message.headers);
  const eventType = requiredString(eventData.event).trim().toLowerCase();
  if (!eventType || eventType.length > 80) throw new Error("event_type_invalid");

  const rawTimestamp = eventData.timestamp;
  const timestamp =
    typeof rawTimestamp === "number"
      ? rawTimestamp
      : Number(typeof rawTimestamp === "string" ? rawTimestamp : NaN);

  return {
    signature,
    eventId: optionalString(eventData.id),
    eventType,
    severity: optionalString(eventData.severity),
    reason: optionalString(eventData.reason),
    recipient: extractEmailAddress(optionalString(eventData.recipient) ?? ""),
    messageId: normalizeMessageId(
      optionalString(headers["message-id"] ?? headers.messageId),
    ),
    eventTimestamp: Number.isFinite(timestamp)
      ? new Date(timestamp * 1000).toISOString()
      : new Date().toISOString(),
    raw: eventData,
  };
}

export function normalizeMessageId(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const candidate = trimmed.match(/<([^<>]+)>/u)?.[1] ?? trimmed;
  const normalized = candidate.trim().toLowerCase();
  if (!normalized || normalized.length > 512 || /\s/u.test(normalized)) return null;
  return normalized;
}

export function messageIdsFromHeader(value: string | null | undefined): string[] {
  if (!value) return [];
  const angleMatches = [...value.matchAll(/<([^<>]+)>/gu)].map((match) => match[1]);
  const candidates = angleMatches.length > 0 ? angleMatches : value.split(/\s+/u);
  return [...new Set(candidates.map(normalizeMessageId).filter(isString))];
}

export function referenceLookupOrder(
  inReplyTo: string | null | undefined,
  references: readonly string[],
): string[] {
  const ordered = [
    normalizeMessageId(inReplyTo),
    ...[...references].reverse().map(normalizeMessageId),
  ].filter(isString);
  return [...new Set(ordered)];
}

export function normalizeSubject(value: string): string {
  let subject = value.trim().normalize("NFKC");
  const prefix = /^\s*(?:(?:re|fw|fwd|tr|réf?)\s*:\s*)+/iu;
  subject = subject.replace(prefix, "").replace(/\s+/gu, " ").trim();
  return subject.toLocaleLowerCase("fr-CA");
}

export async function deriveThreadKey(input: {
  mailboxId: string;
  counterparty: string;
  subject: string;
  messageId?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[];
}): Promise<string> {
  const references = (input.references ?? [])
    .map(normalizeMessageId)
    .filter(isString);
  const root =
    references[0] ??
    normalizeMessageId(input.inReplyTo) ??
    normalizeMessageId(input.messageId);
  if (root) return `message:${root}`;

  return `fallback:${await sha256Hex(
    stableStringify({
      mailboxId: input.mailboxId,
      counterparty: input.counterparty.toLowerCase(),
      subject: normalizeSubject(input.subject),
    }),
  )}`;
}

export async function inboundCallbackKey(
  message: Pick<
    ParsedInboundMessage,
    "mailbox" | "sender" | "subject" | "textBody" | "occurredAt" | "messageId"
  >,
): Promise<string> {
  if (message.messageId) return `inbound:${message.messageId}`;
  return `inbound:${await sha256Hex(
    stableStringify({
      mailbox: message.mailbox.id,
      sender: message.sender,
      subject: normalizeSubject(message.subject),
      textBody: message.textBody ?? "",
      occurredAt: message.occurredAt,
    }),
  )}`;
}

export async function eventCallbackKey(event: ParsedMailgunEvent): Promise<string> {
  if (event.eventId) return `event:${event.eventId}`;
  return `event:${await sha256Hex(
    stableStringify({
      eventType: event.eventType,
      messageId: event.messageId,
      recipient: event.recipient,
      eventTimestamp: event.eventTimestamp,
    }),
  )}`;
}

export function normalizeCommandIdempotencyKey(
  value: string | null | undefined,
): string | null {
  const normalized = value?.trim() ?? "";
  return /^[a-zA-Z0-9._:-]{8,128}$/u.test(normalized) ? normalized : null;
}

export async function requestFingerprint(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export async function sha256Hex(value: string | ArrayBuffer): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToHex(new Uint8Array(digest));
}

function signatureFromForm(form: FormData): MailgunSignature {
  return {
    timestamp: formString(form, "timestamp") ?? "",
    token: formString(form, "token") ?? "",
    signature: formString(form, "signature") ?? "",
  };
}

function formString(form: FormData, name: string): string | null {
  const value = form.get(name);
  return typeof value === "string" ? value : null;
}

function parseMessageHeaders(value: string | null): Record<string, string> {
  if (!value) return {};
  try {
    const entries: unknown = JSON.parse(value);
    if (!Array.isArray(entries)) return {};
    const headers: Record<string, string> = {};
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length < 2) continue;
      if (typeof entry[0] !== "string" || typeof entry[1] !== "string") continue;
      headers[entry[0].toLowerCase()] = entry[1];
    }
    return headers;
  } catch {
    return {};
  }
}

function parseDate(value: string | null | undefined, fallbackMs: number): string {
  const date = value ? new Date(value) : new Date(fallbackMs);
  return Number.isNaN(date.valueOf())
    ? new Date(fallbackMs).toISOString()
    : date.toISOString();
}

function requiredString(value: unknown): string {
  if (typeof value !== "string") throw new Error("required_string_missing");
  return value;
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("object_expected");
  }
  return value as Record<string, unknown>;
}

function isString(value: string | null): value is string {
  return value !== null;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeHexEqual(expected: string, actual: string): boolean {
  if (expected.length !== actual.length) return false;
  let difference = 0;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
  }
  return difference === 0;
}
