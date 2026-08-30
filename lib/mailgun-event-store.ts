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
  const message = event.messageId
    ? await db.prepare("SELECT id FROM messages WHERE external_message_id=? LIMIT 1")
        .bind(event.messageId).first<{ id: string }>()
    : null;

  await db.prepare(`INSERT OR IGNORE INTO message_events
    (id, message_id, provider_event_id, callback_key, event_type, severity,
     recipient, event_timestamp, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    crypto.randomUUID(), message?.id ?? null, event.eventId, callbackKey,
    event.eventType, event.severity, event.recipient, event.eventTimestamp,
    JSON.stringify(event.raw),
  ).run();

  if (event.messageId) {
    // Strict on the webhook path: a failure leaves the receipt reserved so the
    // same verified callback can retry every suppression side effect.
    await reconcile(db, event.messageId);
  }
}
