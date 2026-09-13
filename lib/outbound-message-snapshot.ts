import { normalizeEmailAddress } from "./mailboxes";
import type { OutboundProvider } from "./outbound-runtime";

export type OutboundMessageSnapshot = {
  version: 1;
  requestHash: string;
  provider: OutboundProvider;
  contactId: string;
  mailbox: {
    id: string;
    address: string;
    purpose: "sales" | "operations";
  };
  recipient: string;
  subject: string;
  contentMode: "multipart" | "html" | "text";
  text: string | null;
  html: string | null;
  actorEmail: string;
  conversationId: string | null;
  occurredAt: string;
};

const REQUEST_HASH = /^[a-f0-9]{64}$/u;
const IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/u;
const MAX_BODY_LENGTH = 2_010_000;

export function outboundMessageSnapshotJson(
  snapshot: OutboundMessageSnapshot,
): string {
  if (!isOutboundMessageSnapshot(snapshot)) {
    throw new Error("outbound_message_snapshot_invalid");
  }
  return JSON.stringify(snapshot);
}

export function parseOutboundMessageSnapshot(
  value: string | null | undefined,
): OutboundMessageSnapshot | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isOutboundMessageSnapshot(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isOutboundMessageSnapshot(
  value: unknown,
): value is OutboundMessageSnapshot {
  if (!record(value) || !record(value.mailbox)) return false;
  const mailbox = value.mailbox;

  return SNAPSHOT_RULES.every((rule) => rule(value, mailbox));
}

type SnapshotRule = (
  value: Record<string, unknown>,
  mailbox: Record<string, unknown>,
) => boolean;

const SNAPSHOT_RULES: readonly SnapshotRule[] = [
  validSnapshotIdentity,
  validSnapshotMailbox,
  validSnapshotRecipient,
  validSnapshotContentFields,
  validSnapshotActor,
  validSnapshotConversation,
  validSnapshotTimestamp,
];

function validSnapshotIdentity(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
    validRequestHash(value.requestHash) &&
    validOutboundProvider(value.provider) &&
    validIdentifier(value.contactId)
  );
}

function validSnapshotMailbox(
  _value: Record<string, unknown>,
  mailbox: Record<string, unknown>,
): boolean {
  return (
    validIdentifier(mailbox.id) &&
    validNormalizedEmail(mailbox.address) &&
    validMailboxPurpose(mailbox.purpose)
  );
}

function validSnapshotRecipient(value: Record<string, unknown>): boolean {
  return (
    validNormalizedEmail(value.recipient) &&
    boundedText(value.subject, 1, 500)
  );
}

function validSnapshotContentFields(value: Record<string, unknown>): boolean {
  return validSnapshotContent(
    value.provider,
    value.contentMode,
    value.text,
    value.html,
  );
}

function validSnapshotActor(value: Record<string, unknown>): boolean {
  return validNormalizedEmail(value.actorEmail);
}

function validSnapshotConversation(value: Record<string, unknown>): boolean {
  return (
    value.conversationId === null ||
    validIdentifier(value.conversationId)
  );
}

function validSnapshotTimestamp(value: Record<string, unknown>): boolean {
  return (
    typeof value.occurredAt === "string" &&
    canonicalTimestamp(value.occurredAt)
  );
}

function validRequestHash(value: unknown): boolean {
  return typeof value === "string" && REQUEST_HASH.test(value);
}

function validOutboundProvider(value: unknown): boolean {
  return value === "mailgun" || value === "cakemail";
}

function validIdentifier(value: unknown): boolean {
  return typeof value === "string" && IDENTIFIER.test(value);
}

function validNormalizedEmail(value: unknown): boolean {
  return typeof value === "string" && normalizeEmailAddress(value) === value;
}

function validMailboxPurpose(value: unknown): boolean {
  return value === "sales" || value === "operations";
}

function validSnapshotContent(
  provider: unknown,
  contentMode: unknown,
  text: unknown,
  html: unknown,
): boolean {
  if (provider === "mailgun") {
    return (
      contentMode === "multipart" &&
      boundedText(text, 1, MAX_BODY_LENGTH) &&
      boundedText(html, 1, MAX_BODY_LENGTH)
    );
  }
  if (provider !== "cakemail") return false;
  if (contentMode === "html") {
    return text === null && boundedText(html, 1, MAX_BODY_LENGTH);
  }
  return (
    contentMode === "text" &&
    boundedText(text, 1, MAX_BODY_LENGTH) &&
    html === null
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedText(
  value: unknown,
  minimum: number,
  maximum: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum
  );
}

function canonicalTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === value;
}
