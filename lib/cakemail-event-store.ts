import type { CrmDatabase } from "./d1";
import type { ParsedCakemailEvent } from "./cakemail-webhook";
import {
  reconcileMailgunEventsForMessage,
  type MailgunEventReconciliation,
} from "./mailgun-event-reconciliation";

type ReconcileEvent = typeof reconcileMailgunEventsForMessage;

type LinkedMessage = {
  id: string;
  externalMessageId: string | null;
};

export async function recordCakemailEvent(
  db: CrmDatabase,
  event: ParsedCakemailEvent,
  callbackKey: string,
  reconcile: ReconcileEvent = reconcileMailgunEventsForMessage,
): Promise<void> {
  assertCakemailKey(callbackKey);
  const message = await linkedMessage(db, event.providerMessageId);
  await insertCakemailEvent(db, event, callbackKey, message?.id ?? null);
  if (message?.externalMessageId) {
    // Also relink any earlier callback that arrived before the message row.
    // A later correlated callback therefore repairs a transient first attempt.
    // This path is deliberately strict: the webhook receipt must remain
    // reserved when delivery-state or suppression reconciliation fails so an
    // exact provider retry can complete every local side effect.
    await reconcileCakemailEventsForMessage(
      db,
      event.providerMessageId,
      message.externalMessageId,
      reconcile,
    );
  }
}

/**
 * Links callbacks that arrived before the outbound message row. This is best
 * effort because provider acceptance must never become client-retryable after
 * the network boundary has been crossed.
 */
export async function reconcileCakemailEventsBestEffort(
  db: CrmDatabase,
  providerMessageId: string | null | undefined,
  externalMessageId: string | null | undefined,
  reconcile: ReconcileEvent = reconcileMailgunEventsForMessage,
): Promise<MailgunEventReconciliation | null> {
  try {
    return await reconcileCakemailEventsForMessage(
      db,
      providerMessageId,
      externalMessageId,
      reconcile,
    );
  } catch {
    return null;
  }
}

/**
 * Strict Cakemail reconciliation for the verified webhook path. Callers that
 * acknowledge the callback must let failures escape and leave its receipt in
 * the reserved state for an exact retry.
 */
async function reconcileCakemailEventsForMessage(
  db: CrmDatabase,
  providerMessageId: string | null | undefined,
  externalMessageId: string | null | undefined,
  reconcile: ReconcileEvent = reconcileMailgunEventsForMessage,
): Promise<MailgunEventReconciliation | null> {
  if (!providerMessageId || !externalMessageId) return null;
  const message = await linkedMessage(db, providerMessageId);
  if (!message || message.externalMessageId !== externalMessageId) return null;
  const linkedEvents = await linkUnmatchedCakemailEvents(
    db,
    message.id,
    providerMessageId,
  );
  const result = await reconcile(db, externalMessageId, "cakemail");
  return { ...result, linkedEvents: result.linkedEvents + linkedEvents };
}

async function linkedMessage(
  db: CrmDatabase,
  providerMessageId: string,
): Promise<LinkedMessage | null> {
  return db
    .prepare(
      `SELECT id, external_message_id AS externalMessageId
       FROM messages
       WHERE transport_provider = 'cakemail'
         AND provider_message_id = ?
         AND direction = 'outbound'
       LIMIT 1`,
    )
    .bind(providerMessageId)
    .first<LinkedMessage>();
}

async function linkUnmatchedCakemailEvents(
  db: CrmDatabase,
  messageId: string,
  providerMessageId: string,
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE message_events
       SET message_id = ?
       WHERE transport_provider = 'cakemail'
         AND provider_message_id = ?
         AND message_id IS NULL`,
    )
    .bind(messageId, providerMessageId)
    .run();
  return result.meta.changes ?? 0;
}

async function insertCakemailEvent(
  db: CrmDatabase,
  event: ParsedCakemailEvent,
  callbackKey: string,
  messageId: string | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO message_events
        (id, transport_provider, provider_message_id, message_id,
         provider_event_id, callback_key, event_type, severity, reason,
         recipient, sending_domain,
         recipient_domain, mailbox_provider, sending_ip, failure_class,
         smtp_code, enhanced_status_code, smtp_description, attempt_no,
         tags_json, campaigns_json, event_timestamp, payload_json)
       VALUES (?, 'cakemail', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      event.providerMessageId,
      messageId,
      prefixedProviderEventId(event.providerEventId),
      callbackKey,
      event.eventType,
      event.severity,
      event.reason,
      event.recipient,
      event.sendingDomain,
      event.recipientDomain,
      event.mailboxProvider,
      event.sendingIp,
      event.failureClass,
      event.smtpCode,
      event.enhancedStatusCode,
      event.smtpDescription,
      event.attemptNo,
      JSON.stringify(event.tags),
      JSON.stringify(event.campaigns),
      event.eventTimestamp,
      event.rawBody,
    )
    .run();
}

function prefixedProviderEventId(value: string | null): string | null {
  if (!value) return null;
  return value.startsWith("cakemail:") ? value : `cakemail:${value}`;
}

function assertCakemailKey(value: string): void {
  if (!value.startsWith("cakemail:") || value.length > 600) {
    throw new Error("cakemail_callback_key_invalid");
  }
}
