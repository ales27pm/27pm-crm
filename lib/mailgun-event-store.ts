import type { CrmDatabase } from "./d1";
import type { ParsedMailgunEvent } from "./mailgun";
import { reconcileMailgunEventsForMessage } from "./mailgun-event-reconciliation";

type ReconcileEvent = typeof reconcileMailgunEventsForMessage;

export async function recordMailgunEvent(
  db: CrmDatabase,
  event: ParsedMailgunEvent,
  callbackKey: string,
  reconcile: ReconcileEvent = reconcileMailgunEventsForMessage,
): Promise<void> {
  const messageId = await linkedMessageId(db, event.messageId);
  await insertMailgunEvent(db, event, callbackKey, messageId);
  await reconcileRecordedEvent(db, event.messageId, reconcile);
}

async function linkedMessageId(
  db: CrmDatabase,
  externalMessageId: string | null,
): Promise<string | null> {
  if (!externalMessageId) return null;
  const message = await db
    .prepare(
      `SELECT id FROM messages
       WHERE transport_provider='mailgun' AND direction='outbound'
         AND external_message_id=?
       LIMIT 1`,
    )
    .bind(externalMessageId)
    .first<{ id: string }>();
  return nullableValue(message?.id);
}

async function insertMailgunEvent(
  db: CrmDatabase,
  event: ParsedMailgunEvent,
  callbackKey: string,
  messageId: string | null,
): Promise<void> {
  await db.prepare(`INSERT OR IGNORE INTO message_events
    (id, transport_provider, message_id, provider_event_id, callback_key, event_type, severity,
     reason, recipient, sending_domain, recipient_domain, mailbox_provider, sending_ip,
     failure_class, smtp_code, enhanced_status_code, smtp_description,
     attempt_no, tags_json, campaigns_json, event_timestamp, payload_json)
    VALUES (?, 'mailgun', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), messageId, event.eventId, callbackKey,
    event.eventType, nullableValue(event.severity), nullableValue(event.reason),
    nullableValue(event.recipient), nullableValue(event.sendingDomain),
    nullableValue(event.recipientDomain),
    valueOrDefault(event.mailboxProvider, "other"),
    nullableValue(event.sendingIp), nullableValue(event.failureClass),
    nullableValue(event.smtpCode), nullableValue(event.enhancedStatusCode),
    nullableValue(event.smtpDescription), nullableValue(event.attemptNo),
    serializedList(event.tags), serializedList(event.campaigns),
    event.eventTimestamp,
    JSON.stringify(event.raw),
  ).run();
}

async function reconcileRecordedEvent(
  db: CrmDatabase,
  externalMessageId: string | null,
  reconcile: ReconcileEvent,
): Promise<void> {
  if (!externalMessageId) return;
  // Strict on the webhook path: a failure leaves the receipt reserved so the
  // same verified callback can retry every suppression side effect.
  await reconcile(db, externalMessageId);
}

function nullableValue<T>(value: T | null | undefined): T | null {
  return value ?? null;
}

function valueOrDefault<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

function serializedList(value: readonly string[] | null | undefined): string {
  return JSON.stringify(value ?? []);
}
