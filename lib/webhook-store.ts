import "server-only";

import type { CrmDatabase } from "./d1";
import { changedRows, isUniqueConstraintError } from "./d1";
import {
  deriveThreadKey,
  normalizeSubject,
  referenceLookupOrder,
  sha256Hex,
  type InboundAttachment,
  type ParsedInboundMessage,
  type ParsedMailgunEvent,
} from "./mailgun";
import { reconcileMailgunEventsBestEffort } from "./mailgun-event-reconciliation";
import type { PrivateObjectBucket } from "./runtime";

export type WebhookReservation = "accepted" | "duplicate" | "replay";

export async function hasWebhookToken(
  db: CrmDatabase,
  token: string,
): Promise<boolean> {
  return Boolean(
    await db
      .prepare("SELECT 1 AS present FROM webhook_receipts WHERE signature_token = ? LIMIT 1")
      .bind(token)
      .first(),
  );
}

export async function reserveWebhook(
  db: CrmDatabase,
  input: {
    kind: "inbound" | "event";
    token: string;
    signatureTimestamp: number;
    callbackKey: string;
  },
): Promise<WebhookReservation> {
  try {
    await db
      .prepare(
        `INSERT INTO webhook_receipts
          (kind, signature_token, signature_timestamp, callback_key)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(input.kind, input.token, input.signatureTimestamp, input.callbackKey)
      .run();
    return "accepted";
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;

    const replay = await db
      .prepare("SELECT 1 AS present FROM webhook_receipts WHERE signature_token = ? LIMIT 1")
      .bind(input.token)
      .first();
    if (replay) return "replay";

    const duplicate = await db
      .prepare("SELECT 1 AS present FROM webhook_receipts WHERE callback_key = ? LIMIT 1")
      .bind(input.callbackKey)
      .first();
    if (duplicate) return "duplicate";
    throw error;
  }
}

export async function recordInboundMessage(
  db: CrmDatabase,
  inbound: ParsedInboundMessage,
): Promise<{
  messageId: string;
  conversationId: string;
  created: boolean;
}> {
  const existingMessage = inbound.messageId
    ? await db
        .prepare(
          "SELECT id, conversation_id AS conversationId FROM messages WHERE external_message_id = ? LIMIT 1",
        )
        .bind(inbound.messageId)
        .first<{ id: string; conversationId: string }>()
    : null;
  if (existingMessage) {
    return {
      messageId: existingMessage.id,
      conversationId: existingMessage.conversationId,
      created: false,
    };
  }

  const contactCandidateId = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO contacts (id, email, display_name)
       VALUES (?, ?, ?)
       ON CONFLICT(email) DO UPDATE SET
         display_name = COALESCE(excluded.display_name, contacts.display_name),
         updated_at = CURRENT_TIMESTAMP`,
    )
    .bind(contactCandidateId, inbound.sender, inbound.senderName)
    .run();
  const contact = await db
    .prepare("SELECT id FROM contacts WHERE email = ? LIMIT 1")
    .bind(inbound.sender)
    .first<{ id: string }>();
  if (!contact) throw new Error("contact_upsert_failed");

  let conversationId: string | null = null;
  for (const reference of referenceLookupOrder(
    inbound.inReplyTo,
    inbound.references,
  )) {
    const referenced = await db
      .prepare(
        "SELECT conversation_id AS conversationId FROM messages WHERE external_message_id = ? LIMIT 1",
      )
      .bind(reference)
      .first<{ conversationId: string }>();
    if (referenced) {
      conversationId = referenced.conversationId;
      break;
    }
  }

  const threadKey = await deriveThreadKey({
    mailboxId: inbound.mailbox.id,
    counterparty: inbound.sender,
    subject: inbound.subject,
    messageId: inbound.messageId,
    inReplyTo: inbound.inReplyTo,
    references: inbound.references,
  });
  if (!conversationId) {
    const existingConversation = await db
      .prepare(
        "SELECT id FROM conversations WHERE mailbox_id = ? AND thread_key = ? LIMIT 1",
      )
      .bind(inbound.mailbox.id, threadKey)
      .first<{ id: string }>();
    conversationId = existingConversation?.id ?? null;
  }

  if (!conversationId) {
    const candidateId = crypto.randomUUID();
    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO conversations
          (id, mailbox_id, contact_id, subject, normalized_subject, thread_key,
           is_unread, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        candidateId,
        inbound.mailbox.id,
        contact.id,
        inbound.subject,
        normalizeSubject(inbound.subject),
        threadKey,
        inbound.occurredAt,
      )
      .run();
    if (changedRows(inserted) > 0) {
      conversationId = candidateId;
      if (inbound.mailbox.purpose === "sales") {
        await db
          .prepare(
            `INSERT OR IGNORE INTO deals
              (id, conversation_id, stage)
             VALUES (?, ?, 'new')`,
          )
          .bind(crypto.randomUUID(), conversationId)
          .run();
      }
    } else {
      const racedConversation = await db
        .prepare(
          "SELECT id FROM conversations WHERE mailbox_id = ? AND thread_key = ? LIMIT 1",
        )
        .bind(inbound.mailbox.id, threadKey)
        .first<{ id: string }>();
      conversationId = racedConversation?.id ?? null;
    }
  }
  if (!conversationId) throw new Error("conversation_upsert_failed");

  const messageRecordId = crypto.randomUUID();
  const insertedMessage = await db
    .prepare(
      `INSERT OR IGNORE INTO messages
        (id, conversation_id, mailbox_id, direction, external_message_id,
         provider_storage_key, sender, recipients_json, cc_json, reply_to,
         subject, text_body, html_body, headers_json, status, occurred_at)
       VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'received', ?)`,
    )
    .bind(
      messageRecordId,
      conversationId,
      inbound.mailbox.id,
      inbound.messageId,
      inbound.providerStorageKey,
      inbound.sender,
      JSON.stringify(inbound.recipients),
      JSON.stringify(inbound.cc),
      inbound.replyTo,
      inbound.subject,
      inbound.textBody,
      inbound.htmlBody,
      JSON.stringify(inbound.headers),
      inbound.occurredAt,
    )
    .run();

  const created = changedRows(insertedMessage) > 0;
  let finalMessageId = messageRecordId;
  if (!created && inbound.messageId) {
    const racedMessage = await db
      .prepare("SELECT id FROM messages WHERE external_message_id = ? LIMIT 1")
      .bind(inbound.messageId)
      .first<{ id: string }>();
    if (!racedMessage) throw new Error("message_upsert_failed");
    finalMessageId = racedMessage.id;
  }

  await db
    .prepare(
      `UPDATE conversations
       SET is_unread = 1,
           last_message_at = CASE WHEN last_message_at < ? THEN ? ELSE last_message_at END,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .bind(inbound.occurredAt, inbound.occurredAt, conversationId)
    .run();

  return { messageId: finalMessageId, conversationId, created };
}

export async function storeInboundAttachments(
  db: CrmDatabase,
  bucket: PrivateObjectBucket,
  messageId: string,
  attachments: readonly InboundAttachment[],
): Promise<number> {
  let stored = 0;
  for (const attachment of attachments) {
    const data = await attachment.file.arrayBuffer();
    const digest = await sha256Hex(data);
    const attachmentIdentity = await sha256Hex(
      `${messageId}\u0000${attachment.fieldName}\u0000${digest}`,
    );
    const attachmentId = `att_${attachmentIdentity.slice(0, 32)}`;
    const fileName = safeFileName(attachment.file.name || attachment.fieldName);
    const r2Key = `mail/${messageId}/${attachmentId}/${fileName}`;

    await bucket.put(r2Key, data, {
      httpMetadata: {
        contentType: attachment.file.type || "application/octet-stream",
      },
      customMetadata: {
        messageId,
        scanStatus: "unscanned",
        sha256: digest,
      },
    });
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO attachments
          (id, message_id, r2_key, file_name, content_type, size_bytes, sha256, scan_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'unscanned')`,
      )
      .bind(
        attachmentId,
        messageId,
        r2Key,
        fileName,
        attachment.file.type || "application/octet-stream",
        data.byteLength,
        digest,
      )
      .run();
    stored += changedRows(result);
  }
  return stored;
}

export async function recordMailgunEvent(
  db: CrmDatabase,
  event: ParsedMailgunEvent,
  callbackKey: string,
): Promise<void> {
  const message = event.messageId
    ? await db
        .prepare("SELECT id FROM messages WHERE external_message_id = ? LIMIT 1")
        .bind(event.messageId)
        .first<{ id: string }>()
    : null;

  await db
    .prepare(
      `INSERT OR IGNORE INTO message_events
        (id, message_id, provider_event_id, callback_key, event_type, severity,
         recipient, event_timestamp, payload_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      message?.id ?? null,
      event.eventId,
      callbackKey,
      event.eventType,
      event.severity,
      event.recipient,
      event.eventTimestamp,
      JSON.stringify(event.raw),
    )
    .run();

  if (event.messageId) {
    // Re-resolve after insertion so a concurrent outbound insert cannot leave
    // this callback permanently detached from its message. The event is
    // already durable, so a secondary reconciliation error must not turn the
    // webhook response into a misleading persistence failure.
    await reconcileMailgunEventsBestEffort(db, event.messageId);
  }
}

function safeFileName(value: string): string {
  const sanitized = value
    .normalize("NFKC")
    .replace(/[\u0000-\u001f\u007f/\\]/gu, "_")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 180);
  return sanitized || "attachment.bin";
}
