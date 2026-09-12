import type { CrmDatabase } from "./d1";
import { normalizeMessageId } from "./mailgun";
import {
  mailgunDeliveryState,
  mailgunReasonFromPayloadJson,
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
    return { messageId: null, linkedEvents: 0, status: null };
  }

  const message = await db
    .prepare(
      `SELECT id
       FROM messages
       WHERE external_message_id = ? AND direction = 'outbound'
       LIMIT 1`,
    )
    .bind(normalizedMessageId)
    .first<{ id: string }>();
  if (!message) {
    return { messageId: null, linkedEvents: 0, status: null };
  }

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
    if (mailgunMessageIdFromPayloadJson(event.payloadJson) !== normalizedMessageId) {
      continue;
    }
    const result = await db
      .prepare(
        `UPDATE message_events
         SET message_id = ?
         WHERE id = ? AND message_id IS NULL`,
      )
      .bind(message.id, event.id)
      .run();
    linkedEvents += result.meta.changes ?? 0;
  }

  const status = await refreshDeliveryStatus(db, message.id);
  if (status === "complained" || status === "bounced" || status === "permanent-failure") {
    await suppressFailedRecipient(db, message.id, status);
  }

  return { messageId: message.id, linkedEvents, status };
}

async function suppressFailedRecipient(
  db: CrmDatabase,
  messageId: string,
  status: "complained" | "bounced" | "permanent-failure",
) {
  const recipient = await db.prepare(`SELECT contact.id AS contactId, contact.email AS contactEmail,
      message.recipients_json AS recipientsJson,
      (SELECT event.recipient FROM message_events event WHERE event.message_id=message.id AND event.recipient IS NOT NULL ORDER BY event.rowid DESC LIMIT 1) AS eventRecipient
    FROM messages message
    JOIN conversations conversation ON conversation.id=message.conversation_id
    LEFT JOIN contacts contact ON contact.id=conversation.contact_id
    WHERE message.id=? LIMIT 1`).bind(messageId).first<{ contactId: string | null; contactEmail: string | null; recipientsJson: string | null; eventRecipient: string | null }>();
  const historicalAddress = firstRecipient(recipient?.recipientsJson) ?? normalizedRecipient(recipient?.eventRecipient);
  if (!historicalAddress) return;
  const contactMatches = Boolean(recipient?.contactId && recipient.contactEmail?.toLowerCase() === historicalAddress);
  const now = new Date().toISOString();
  const reason = status === "complained" ? "provider_complaint" : status === "bounced" ? "provider_bounce" : "provider_permanent_failure";
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO contact_suppressions
      (id, channel, address_normalized, scope, category, reason, evidence_ref,
       requested_at, effective_at, created_by)
      VALUES (?, 'email', ?, 'global', 'all', ?, ?, ?, ?, 'mailgun:webhook')`)
      .bind(`provider-suppression:${messageId}`, historicalAddress, reason, `message:${messageId}`, now, now),
    ...(contactMatches && recipient?.contactId ? [
      db.prepare(`UPDATE contact_channel_compliance SET status=?, updated_at=CURRENT_TIMESTAMP
      WHERE contact_id=? AND channel='email'`).bind(status === "complained" ? "unsubscribed" : "bounced", recipient.contactId),
      db.prepare(`UPDATE contacts SET
      compliance_version=compliance_version + CASE WHEN do_not_contact=0 OR email_status<>? THEN 1 ELSE 0 END,
      email_status=?, unsubscribed_at=CASE WHEN ?='complained' THEN COALESCE(unsubscribed_at, ?) ELSE unsubscribed_at END,
      do_not_contact=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .bind(status === "complained" ? "unsubscribed" : "bounced", status === "complained" ? "unsubscribed" : "bounced", status, now, recipient.contactId),
      db.prepare(`UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP
      WHERE contact_action=1 AND status='open'
        AND (conversation_id IN (SELECT id FROM conversations WHERE contact_id=?)
          OR deal_id IN (SELECT id FROM deals WHERE contact_id=?))`).bind(recipient.contactId, recipient.contactId),
      db.prepare(`UPDATE send_commands SET status='cancelled', failure_code=?, updated_at=CURRENT_TIMESTAMP
      WHERE contact_id=? AND status IN ('pending','authorized')`).bind(reason, recipient.contactId),
    ] : []),
    db.prepare(`INSERT OR IGNORE INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json)
      VALUES (?, 'mailgun:webhook', 'contact.provider_suppressed', ?, ?, ?)`)
      .bind(`provider-audit:${messageId}:${status}`, contactMatches ? "contact" : "message", contactMatches && recipient?.contactId ? recipient.contactId : messageId, JSON.stringify({ status, messageId, addressNormalized: historicalAddress, contactMatches })),
  ];
  await db.batch(statements);
}

function firstRecipient(recipientsJson: string | null | undefined): string | null {
  try {
    const recipients = JSON.parse(recipientsJson ?? "null") as unknown;
    if (!Array.isArray(recipients) || recipients.length !== 1 || typeof recipients[0] !== "string") return null;
    return normalizedRecipient(recipients[0]);
  } catch {
    return null;
  }
}

function normalizedRecipient(value: string | null | undefined): string | null {
  const address = value?.trim().toLowerCase() ?? "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(address) ? address : null;
}

export function mailgunMessageIdFromPayloadJson(
  payloadJson: string | null | undefined,
): string | null {
  if (!payloadJson) return null;
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!isRecord(payload)) return null;
    const message = payload.message;
    if (!isRecord(message)) return null;
    const headers = message.headers;
    if (!isRecord(headers)) return null;
    const rawMessageId = headers["message-id"] ?? headers.messageId;
    return typeof rawMessageId === "string"
      ? normalizeMessageId(rawMessageId)
      : null;
  } catch {
    return null;
  }
}

async function refreshDeliveryStatus(
  db: CrmDatabase,
  messageId: string,
): Promise<OutboundDeliveryState | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await latestDeliverySnapshot(db, messageId);
    if (!snapshot.status) return null;

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
    if ((updated.meta.changes ?? 0) > 0) return snapshot.status;
  }
  return null;
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
