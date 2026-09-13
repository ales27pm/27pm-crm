import type { CrmDatabase, PreparedQuery } from "./d1";
import { normalizeMessageId } from "./mailgun";
import {
  mailgunRecipientSuppression,
  mailgunReasonFromPayloadJson,
  type MailgunRecipientSuppression,
  type OutboundDeliveryState,
} from "./mailgun-lifecycle";
import {
  providerDeliveryState,
  type EventTransportProvider,
  type StoredProviderDeliveryEvent,
} from "./outbound-delivery-state";

export type MailgunEventReconciliation = {
  messageId: string | null;
  linkedEvents: number;
  status: OutboundDeliveryState | null;
};

type StoredProviderEvent = Required<StoredProviderDeliveryEvent>;

export async function reconcileMailgunEventsBestEffort(
  db: CrmDatabase,
  externalMessageId: string | null | undefined,
): Promise<MailgunEventReconciliation | null> {
  if (!externalMessageId) return null;
  try {
    return await reconcileMailgunEventsForMessage(
      db,
      externalMessageId,
      "mailgun",
    );
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
  expectedProvider: EventTransportProvider = "mailgun",
): Promise<MailgunEventReconciliation> {
  const normalizedMessageId = normalizeMessageId(externalMessageId);
  if (!normalizedMessageId) {
    return emptyReconciliation();
  }

  const messageId = await outboundMessageId(
    db,
    normalizedMessageId,
    expectedProvider,
  );
  if (!messageId) return emptyReconciliation();

  const linkedEvents =
    expectedProvider === "mailgun"
      ? await linkUnmatchedEvents(db, messageId, normalizedMessageId)
      : 0;
  const status = await refreshDeliveryStatus(db, messageId, expectedProvider);
  await applyLatestRecipientSuppression(db, messageId, expectedProvider);

  return { messageId, linkedEvents, status };
}

function emptyReconciliation(): MailgunEventReconciliation {
  return { messageId: null, linkedEvents: 0, status: null };
}

async function outboundMessageId(
  db: CrmDatabase,
  normalizedMessageId: string,
  expectedProvider: EventTransportProvider,
): Promise<string | null> {
  const message = await db
    .prepare(
      `SELECT id
       FROM messages
       WHERE external_message_id = ? AND direction = 'outbound'
         AND transport_provider = ?
       LIMIT 1`,
    )
    .bind(normalizedMessageId, expectedProvider)
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
       WHERE transport_provider = 'mailgun' AND message_id IS NULL
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
         WHERE id = ? AND transport_provider = 'mailgun'
           AND message_id IS NULL`,
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
  expectedProvider: EventTransportProvider,
): Promise<void> {
  const recipientSuppression = await latestRecipientSuppression(
    db,
    messageId,
    expectedProvider,
  );
  if (!recipientSuppression) return;
  await suppressRecipient(
    db,
    messageId,
    expectedProvider,
    recipientSuppression,
  );
}

type RecipientSuppressionSignal = {
  provider: "mailgun" | "cakemail";
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
  expectedProvider: EventTransportProvider,
  suppression: RecipientSuppressionSignal,
) {
  const recipient = await suppressionRecipient(
    db,
    messageId,
    expectedProvider,
  );
  const context = suppressionContext(recipient, suppression);
  if (!context) return;
  await db.batch(suppressionStatements(db, messageId, suppression, context));
}

async function suppressionRecipient(
  db: CrmDatabase,
  messageId: string,
  expectedProvider: EventTransportProvider,
): Promise<SuppressionRecipient | null> {
  return db
    .prepare(`SELECT contact.id AS contactId, contact.email AS contactEmail,
      message.recipients_json AS recipientsJson,
      (SELECT event.recipient FROM message_events event
        WHERE event.message_id=message.id
          AND event.transport_provider=?
          AND event.recipient IS NOT NULL
        ORDER BY event.rowid DESC LIMIT 1) AS eventRecipient
    FROM messages message
    JOIN conversations conversation ON conversation.id=message.conversation_id
    LEFT JOIN contacts contact ON contact.id=conversation.contact_id
    WHERE message.id=? AND message.transport_provider=? LIMIT 1`)
    .bind(expectedProvider, messageId, expectedProvider)
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
    suppressionInsert(db, messageId, suppression, context),
    ...contactSuppressionUpdates(db, context),
    suppressionAuditInsert(db, messageId, suppression, context),
  ];
}

function suppressionInsert(
  db: CrmDatabase,
  messageId: string,
  suppression: RecipientSuppressionSignal,
  context: SuppressionContext,
): PreparedQuery {
  return db.prepare(`INSERT OR IGNORE INTO contact_suppressions
    (id, channel, address_normalized, scope, category, reason, evidence_ref,
     requested_at, effective_at, created_by)
    VALUES (?, 'email', ?, 'global', 'all', ?, ?, ?, ?, ?)`)
    .bind(
      `provider-suppression:${messageId}`,
      context.address,
      context.reason,
      `message:${messageId}`,
      context.effectiveAt,
      context.effectiveAt,
      `${suppression.provider}:webhook`,
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
    VALUES (?, ?, 'contact.provider_suppressed', ?, ?, ?)`)
    .bind(
      `provider-audit:${messageId}:${suppression.kind}`,
      `${suppression.provider}:webhook`,
      entityType,
      entityId,
      JSON.stringify({
        provider: suppression.provider,
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
  expectedProvider: EventTransportProvider,
): Promise<RecipientSuppressionSignal | null> {
  const events = await db
    .prepare(
      `SELECT transport_provider AS provider, event_type AS eventType,
              severity, reason, failure_class AS failureClass,
              payload_json AS payloadJson,
              event_timestamp AS occurredAt
       FROM message_events
       WHERE message_id = ? AND transport_provider = ?
       ORDER BY event_timestamp DESC, rowid DESC`,
    )
    .bind(messageId, expectedProvider)
    .all<{
      provider: "mailgun" | "cakemail";
      eventType: string;
      severity: string | null;
      reason: string | null;
      failureClass: string | null;
      payloadJson: string;
      occurredAt: string;
    }>();

  let selected: RecipientSuppressionSignal | null = null;
  for (const event of events.results) {
    const kind = providerRecipientSuppression(event.provider, event);
    if (!kind) continue;
    selected = preferredSuppression(selected, {
      provider: event.provider,
      kind,
      occurredAt: event.occurredAt,
    });
  }
  return selected;
}

function providerRecipientSuppression(
  provider: EventTransportProvider,
  event: StoredProviderEvent,
): MailgunRecipientSuppression | null {
  if (provider === "mailgun") {
    return mailgunRecipientSuppression({
      eventType: event.eventType,
      severity: event.severity,
      reason: event.reason ?? mailgunReasonFromPayloadJson(event.payloadJson),
    });
  }

  // Cakemail's free-form reason is not a Mailgun suppression token. Trust only
  // the failure class produced by the authenticated Cakemail parser.
  if (event.failureClass === "hard_bounce") return "bounce";
  if (event.failureClass === "complaint") return "complaint";
  if (event.failureClass === "unsubscribe") return "unsubscribe";
  return null;
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
  expectedProvider: EventTransportProvider,
): Promise<OutboundDeliveryState | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await persistLatestDeliverySnapshot(
      db,
      messageId,
      expectedProvider,
    );
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
  expectedProvider: EventTransportProvider,
): Promise<DeliverySnapshotPersistence> {
  const snapshot = await latestDeliverySnapshot(
    db,
    messageId,
    expectedProvider,
  );
  if (!snapshot.status) return { retry: false, status: null };

  const updated = await db
    .prepare(
      `UPDATE messages
       SET status = ?
       WHERE id = ?
         AND transport_provider = ?
         AND ? = (
           SELECT COUNT(*) FROM message_events
           WHERE message_id = ? AND transport_provider = ?
         )
         AND ? = COALESCE((
           SELECT MAX(rowid) FROM message_events
           WHERE message_id = ? AND transport_provider = ?
         ), 0)`,
    )
    .bind(
      snapshot.status,
      messageId,
      expectedProvider,
      snapshot.eventCount,
      messageId,
      expectedProvider,
      snapshot.maxSequence,
      messageId,
      expectedProvider,
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
  expectedProvider: EventTransportProvider,
): Promise<{
  status: OutboundDeliveryState | null;
  eventCount: number;
  maxSequence: number;
}> {
  const events = await db
    .prepare(
      `SELECT event_type AS eventType, severity, reason,
              failure_class AS failureClass,
              payload_json AS payloadJson,
              rowid AS sequence
       FROM message_events
       WHERE message_id = ? AND transport_provider = ?
       ORDER BY event_timestamp DESC, rowid DESC`,
    )
    .bind(messageId, expectedProvider)
    .all<{
      eventType: string;
      severity: string | null;
      reason: string | null;
      failureClass: string | null;
      payloadJson: string;
      sequence: number;
    }>();

  let status: OutboundDeliveryState | null = null;
  let maxSequence = 0;
  for (const event of events.results) {
    maxSequence = Math.max(maxSequence, event.sequence);
    if (status) continue;
    status = providerDeliveryState(expectedProvider, {
      eventType: event.eventType,
      severity: event.severity,
      reason: event.reason,
      failureClass: event.failureClass,
      payloadJson: event.payloadJson,
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
