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

  return { messageId: message.id, linkedEvents, status };
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
