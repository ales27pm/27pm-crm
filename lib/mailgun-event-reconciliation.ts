import type { CrmDatabase, PreparedQuery } from "./d1";
import { normalizeMessageId } from "./mailgun";
import {
  mailgunDeliveryState,
  mailgunRecipientSuppression,
  mailgunReasonFromPayloadJson,
  type MailgunRecipientSuppression,
  type OutboundDeliveryState,
} from "./mailgun-lifecycle";

export type MailgunEventReconciliation = {
  messageId: string | null;
  linkedEvents: number;
  status: OutboundDeliveryState | null;
};

export async function reconcileMailgunEventsBestEffort(
  db: CrmDatabase,
  externalMessageId: string | null | undefined,
): Promise<MailgunEventReconciliation | null> {
  if (!externalMessageId) return null;
  try {
    return await reconcileMailgunEventsForMessage(db, externalMessageId);
  } catch {
    // Delivery tracking must never turn an already accepted provider send into
    // a client-visible failure that could prompt a duplicate retry.
    return null;
  }
}

/**
 * Links callbacks that raced ahead of the outbound message insert, then derives
 * the message's state from provider time and callback insertion order.
 */
export async function reconcileMailgunEventsForMessage(
  db: CrmDatabase,
  externalMessageId: string,
): Promise<MailgunEventReconciliation> {
  const normalizedMessageId = normalizeMessageId(externalMessageId);
  if (!normalizedMessageId) {
    return emptyReconciliation();
  }

  const messageId = await outboundMessageId(db, normalizedMessageId);
  if (!messageId) return emptyReconciliation();

  const linkedEvents = await linkUnmatchedEvents(
    db,
    messageId,
    normalizedMessageId,
  );
  const status = await refreshDeliveryStatus(db, messageId);
  await applyLatestRecipientSuppression(db, messageId);

  return { messageId, linkedEvents, status };
}

function emptyReconciliation(): MailgunEventReconciliation {
  return { messageId: null, linkedEvents: 0, status: null };
}

async function outboundMessageId(
  db: CrmDatabase,
  normalizedMessageId: string,
): Promise<string | null> {
  const message = await db
    .prepare(
      `SELECT id
       FROM messages
       WHERE external_message_id = ? AND direction = 'outbound'
       LIMIT 1`,
    )
    .bind(normalizedMessageId)
    .first<{ id: string }>();
  return message?.id ?? null;
}

async function linkUnmatchedEvents(
  db: CrmDatabase,
  messageId: string,
  normalizedMessageId: string,
): Promise<number> {
  const unmatchedEvents = await db
    .prepare(
      `SELECT id, payload_json AS payloadJson
       FROM message_events
       WHERE message_id IS NULL
       ORDER BY rowid`,
    )
    .all<{ id: string; payloadJson: string }>();

  let linkedEvents = 0;
  for (const event of unmatchedEvents.results) {
    if (
      mailgunMessageIdFromPayloadJson(event.payloadJson) !== normalizedMessageId
    ) {
      continue;
    }
    const result = await db
      .prepare(
        `UPDATE message_events
         SET message_id = ?
         WHERE id = ? AND message_id IS NULL`,
      )
      .bind(messageId, event.id)
      .run();
    linkedEvents += result.meta.changes ?? 0;
  }
  return linkedEvents;
}

async function applyLatestRecipientSuppression(
  db: CrmDatabase,
  messageId: string,
): Promise<void> {
  const recipientSuppression = await latestRecipientSuppression(db, messageId);
  if (!recipientSuppression) return;
  await suppressRecipient(db, messageId, recipientSuppression);
}

type RecipientSuppressionSignal = {
  kind: MailgunRecipientSuppression;
  occurredAt: string;
};

type SuppressionRecipient = {
  contactId: string | null;
  contactEmail: string | null;
  recipientsJson: string | null;
  eventRecipient: string | null;
};

type SuppressionProfile = {
  contactStatus: "bounced" | "unsubscribed";
  reason: "provider_bounce" | "provider_complaint" | "provider_unsubscribe";
  unsubscribeFlag: 0 | 1;
};

type SuppressionContext = SuppressionProfile & {
  address: string;
  contactId: string | null;
  effectiveAt: string;
};

const SUPPRESSION_PROFILES: Record<
  MailgunRecipientSuppression,
  SuppressionProfile
> = {
  bounce: {
    contactStatus: "bounced",
    reason: "provider_bounce",
    unsubscribeFlag: 0,
  },
  complaint: {
    contactStatus: "unsubscribed",
    reason: "provider_complaint",
    unsubscribeFlag: 1,
  },
  unsubscribe: {
    contactStatus: "unsubscribed",
    reason: "provider_unsubscribe",
    unsubscribeFlag: 1,
  },
};

const SUPPRESSION_PRIORITY: Record<MailgunRecipientSuppression, number> = {
  bounce: 1,
  complaint: 2,
  unsubscribe: 3,
};

async function suppressRecipient(
  db: CrmDatabase,
  messageId: string,
  suppression: RecipientSuppressionSignal,
) {
  const recipient = await suppressionRecipient(db, messageId);
  const context = suppressionContext(recipient, suppression);
  if (!context) return;
  await db.batch(suppressionStatements(db, messageId, suppression, context));
}

async function suppressionRecipient(
  db: CrmDatabase,
  messageId: string,
): Promise<SuppressionRecipient | null> {
  return db
    .prepare(`SELECT contact.id AS contactId, contact.email AS contactEmail,
      message.recipients_json AS recipientsJson,
      (SELECT event.recipient FROM message_events event WHERE event.message_id=message.id AND event.recipient IS NOT NULL ORDER BY event.rowid DESC LIMIT 1) AS eventRecipient
    FROM messages message
    JOIN conversations conversation ON conversation.id=message.conversation_id
    LEFT JOIN contacts contact ON contact.id=conversation.contact_id
    WHERE message.id=? LIMIT 1`)
    .bind(messageId)
    .first<SuppressionRecipient>();
}

function suppressionContext(
  recipient: SuppressionRecipient | null,
  suppression: RecipientSuppressionSignal,
): SuppressionContext | null {
  const address = historicalRecipient(recipient);
  if (!address) return null;
  return {
    ...SUPPRESSION_PROFILES[suppression.kind],
    address,
    contactId: matchingContactId(recipient, address),
    effectiveAt: normalizedTimestamp(suppression.occurredAt),
  };
}

function historicalRecipient(
  recipient: SuppressionRecipient | null,
): string | null {
  return (
    firstRecipient(recipient?.recipientsJson) ??
    normalizedRecipient(recipient?.eventRecipient)
  );
}

function matchingContactId(
  recipient: SuppressionRecipient | null,
  historicalAddress: string,
): string | null {
  if (!recipient?.contactId) return null;
  return recipient.contactEmail?.toLowerCase() === historicalAddress
    ? recipient.contactId
    : null;
}

function suppressionStatements(
  db: CrmDatabase,
  messageId: string,
  suppression: RecipientSuppressionSignal,
  context: SuppressionContext,
): PreparedQuery[] {
  return [
    suppressionInsert(db, messageId, context),
    ...contactSuppressionUpdates(db, context),
    suppressionAuditInsert(db, messageId, suppression, context),
  ];
}

function suppressionInsert(
  db: CrmDatabase,
  messageId: string,
  context: SuppressionContext,
): PreparedQuery {
  return db.prepare(`INSERT OR IGNORE INTO contact_suppressions
    (id, channel, address_normalized, scope, category, reason, evidence_ref,
     requested_at, effective_at, created_by)
    VALUES (?, 'email', ?, 'global', 'all', ?, ?, ?, ?, 'mailgun:webhook')`)
    .bind(
      `provider-suppression:${messageId}`,
      context.address,
      context.reason,
      `message:${messageId}`,
      context.effectiveAt,
      context.effectiveAt,
    );
}

function contactSuppressionUpdates(
  db: CrmDatabase,
  context: SuppressionContext,
): PreparedQuery[] {
  if (!context.contactId) return [];
  const contactId = context.contactId;
  return [
    db.prepare(`UPDATE contact_channel_compliance SET status=?, updated_at=CURRENT_TIMESTAMP
      WHERE contact_id=? AND channel='email'`)
      .bind(context.contactStatus, contactId),
    db.prepare(`UPDATE contacts SET
      compliance_version=compliance_version + CASE WHEN do_not_contact=0 OR email_status<>? THEN 1 ELSE 0 END,
      email_status=?, unsubscribed_at=CASE WHEN ?=1 THEN COALESCE(unsubscribed_at, ?) ELSE unsubscribed_at END,
      do_not_contact=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(
        context.contactStatus,
        context.contactStatus,
        context.unsubscribeFlag,
        context.effectiveAt,
        contactId,
      ),
    db.prepare(`UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP
      WHERE contact_action=1 AND status='open'
        AND (conversation_id IN (SELECT id FROM conversations WHERE contact_id=?)
          OR deal_id IN (SELECT id FROM deals WHERE contact_id=?))`)
      .bind(contactId, contactId),
    db.prepare(`UPDATE send_commands SET status='cancelled', failure_code=?, updated_at=CURRENT_TIMESTAMP
      WHERE contact_id=? AND status IN ('pending','authorized')`)
      .bind(context.reason, contactId),
  ];
}

function suppressionAuditInsert(
  db: CrmDatabase,
  messageId: string,
  suppression: RecipientSuppressionSignal,
  context: SuppressionContext,
): PreparedQuery {
  const contactMatches = context.contactId !== null;
  const entityType = contactMatches ? "contact" : "message";
  const entityId = context.contactId ?? messageId;
  return db.prepare(`INSERT OR IGNORE INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json)
    VALUES (?, 'mailgun:webhook', 'contact.provider_suppressed', ?, ?, ?)`)
    .bind(
      `provider-audit:${messageId}:${suppression.kind}`,
      entityType,
      entityId,
      JSON.stringify({
        suppression: suppression.kind,
        messageId,
        addressNormalized: context.address,
        contactMatches,
        occurredAt: context.effectiveAt,
      }),
    );
}

async function latestRecipientSuppression(
  db: CrmDatabase,
  messageId: string,
): Promise<RecipientSuppressionSignal | null> {
  const events = await db
    .prepare(
      `SELECT event_type AS eventType, severity, payload_json AS payloadJson,
              event_timestamp AS occurredAt
       FROM message_events
       WHERE message_id = ?
       ORDER BY event_timestamp DESC, rowid DESC`,
    )
    .bind(messageId)
    .all<{
      eventType: string;
      severity: string | null;
      payloadJson: string;
      occurredAt: string;
    }>();

  let selected: RecipientSuppressionSignal | null = null;
  for (const event of events.results) {
    const kind = mailgunRecipientSuppression({
      eventType: event.eventType,
      severity: event.severity,
      reason: mailgunReasonFromPayloadJson(event.payloadJson),
    });
    if (!kind) continue;
    selected = preferredSuppression(selected, {
      kind,
      occurredAt: event.occurredAt,
    });
  }
  return selected;
}

function preferredSuppression(
  selected: RecipientSuppressionSignal | null,
  candidate: RecipientSuppressionSignal,
): RecipientSuppressionSignal {
  if (!selected) return candidate;
  return SUPPRESSION_PRIORITY[candidate.kind] >
    SUPPRESSION_PRIORITY[selected.kind]
    ? candidate
    : selected;
}

function normalizedTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp)
    ? new Date().toISOString()
    : new Date(timestamp).toISOString();
}

function firstRecipient(recipientsJson: string | null | undefined): string | null {
  const recipients = parsedJson(recipientsJson ?? "null");
  const recipient = singleString(recipients);
  return normalizedRecipient(recipient);
}

function normalizedRecipient(value: string | null | undefined): string | null {
  const address = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address) ? address : null;
}

export function mailgunMessageIdFromPayloadJson(
  payloadJson: string | null | undefined,
): string | null {
  if (!payloadJson) return null;
  return messageIdFromHeaders(mailgunHeadersFromPayloadJson(payloadJson));
}

function mailgunHeadersFromPayloadJson(
  payloadJson: string,
): Record<string, unknown> | null {
  const payload = recordValue(parsedJson(payloadJson));
  if (!payload) return null;
  const message = recordValue(payload.message);
  if (!message) return null;
  return recordValue(message.headers);
}

function messageIdFromHeaders(
  headers: Record<string, unknown> | null,
): string | null {
  if (!headers) return null;
  const rawMessageId = nullishValue(headers["message-id"], headers.messageId);
  return typeof rawMessageId === "string"
    ? normalizeMessageId(rawMessageId)
    : null;
}

function nullishValue<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

async function refreshDeliveryStatus(
  db: CrmDatabase,
  messageId: string,
): Promise<OutboundDeliveryState | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await persistLatestDeliverySnapshot(db, messageId);
    if (!result.retry) return result.status;
  }
  return null;
}

type DeliverySnapshotPersistence =
  | { retry: true; status: null }
  | { retry: false; status: OutboundDeliveryState | null };

async function persistLatestDeliverySnapshot(
  db: CrmDatabase,
  messageId: string,
): Promise<DeliverySnapshotPersistence> {
  const snapshot = await latestDeliverySnapshot(db, messageId);
  if (!snapshot.status) return { retry: false, status: null };

  const updated = await db
    .prepare(
      `UPDATE messages
       SET status = ?
       WHERE id = ?
         AND ? = (
           SELECT COUNT(*) FROM message_events WHERE message_id = ?
         )
         AND ? = COALESCE((
           SELECT MAX(rowid) FROM message_events WHERE message_id = ?
         ), 0)`,
    )
    .bind(
      snapshot.status,
      messageId,
      snapshot.eventCount,
      messageId,
      snapshot.maxSequence,
      messageId,
    )
    .run();
  if ((updated.meta.changes ?? 0) > 0) {
    return { retry: false, status: snapshot.status };
  }
  return { retry: true, status: null };
}

async function latestDeliverySnapshot(
  db: CrmDatabase,
  messageId: string,
): Promise<{
  status: OutboundDeliveryState | null;
  eventCount: number;
  maxSequence: number;
}> {
  const events = await db
    .prepare(
      `SELECT event_type AS eventType, severity, payload_json AS payloadJson,
              rowid AS sequence
       FROM message_events
       WHERE message_id = ?
       ORDER BY event_timestamp DESC, rowid DESC`,
    )
    .bind(messageId)
    .all<{
      eventType: string;
      severity: string | null;
      payloadJson: string;
      sequence: number;
    }>();

  let status: OutboundDeliveryState | null = null;
  let maxSequence = 0;
  for (const event of events.results) {
    maxSequence = Math.max(maxSequence, event.sequence);
    if (status) continue;
    status = mailgunDeliveryState({
      eventType: event.eventType,
      severity: event.severity,
      reason: mailgunReasonFromPayloadJson(event.payloadJson),
    });
  }
  return { status, eventCount: events.results.length, maxSequence };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function singleString(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  if (value.length !== 1) return null;
  return typeof value[0] === "string" ? value[0] : null;
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}
