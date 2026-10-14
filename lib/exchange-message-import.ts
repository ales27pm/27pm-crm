import "server-only";

import { changedRows, type CrmDatabase } from "./d1";
import type { ExchangeGraphFolder, ExchangeGraphMessage } from "./exchange-graph";
import type {
  ExchangeMailGuard,
  ExchangeMailScope,
  ExchangeMessageClassification,
} from "./exchange-mail-store";
import {
  CRM_MAILBOXES,
  mailboxForAddress,
  mailboxFromRecipients,
  normalizeEmailAddress,
  type CrmMailbox,
} from "./mailboxes";

export type ExchangeMessageProjection = {
  mailboxId: string | null;
  crmMessageId: string | null;
  classification: ExchangeMessageClassification;
};

type ProjectionFence = { scope: ExchangeMailScope; guard: ExchangeMailGuard; now: Date };
type ContactPlan = { id: string; email: string };
type ConversationPlan = { id: string; threadKey: string; create: boolean };

const ACTIVE_LEASE = `EXISTS (SELECT 1 FROM exchange_connections WHERE id='alexis'
  AND tenant_id=? AND mailbox_id=? AND lease_owner=? AND generation=?
  AND status='connected'
  AND lease_expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/**
 * Projects one immutable Graph item into CRM history. RFC Message-IDs are only
 * scoped threading hints; Graph identity remains the provider dedupe key.
 */
export async function projectExchangeMessage(
  db: CrmDatabase,
  folder: ExchangeGraphFolder,
  message: ExchangeGraphMessage,
  fence?: ProjectionFence,
): Promise<ExchangeMessageProjection> {
  const existing = await db.prepare(`SELECT id,mailbox_id AS mailboxId,direction,
      EXISTS (SELECT 1 FROM json_each(messages.tags_json) WHERE value='external-history') AS externalHistory
    FROM messages
    WHERE transport_provider='exchange' AND provider_message_id=? LIMIT 1`)
    .bind(message.id).first<{ id: string; mailboxId: string; direction: string; externalHistory: number }>();
  if (existing) {
    return {
      mailboxId: existing.mailboxId,
      crmMessageId: existing.id,
      classification: existing.direction === "outbound" && existing.externalHistory === 1 ? "external_sent" : "mapped",
    };
  }

  // Junk is retained in the scoped Exchange mirror for operator review, but it
  // must never manufacture CRM contacts, active conversations, unread work, or
  // sales deals from provider-classified spam.
  if (folder === "junkemail") {
    return { mailboxId: null, crmMessageId: null, classification: "unclassified" };
  }

  if (message.isDraft) return { mailboxId: null, crmMessageId: null, classification: "draft" };
  const outbound = folder === "sentitems";
  const mailbox = outbound
    ? mailboxForAddress(message.from?.address ?? message.sender?.address ?? "")
    : mailboxFromRecipients([
        ...(message.toRecipients ?? []).map((entry) => entry.address),
        ...(message.ccRecipients ?? []).map((entry) => entry.address),
      ]);
  if (!mailbox) return { mailboxId: null, crmMessageId: null, classification: "ambiguous" };

  const counterparty = outbound
    ? singleExternalRecipient(message)
    : normalized(message.from?.address ?? message.sender?.address);
  if (!counterparty) {
    return { mailboxId: mailbox.id, crmMessageId: null, classification: outbound ? "external_sent" : "ambiguous" };
  }

  const occurredAt = eventTime(message, outbound);
  if (!occurredAt) return { mailboxId: mailbox.id, crmMessageId: null, classification: "ambiguous" };
  const subject = boundedSubject(message.subject);
  const contact = await planContact(db, counterparty);
  const conversation = await planConversation(db, {
    mailbox,
    contactId: contact.id,
    counterparty,
    graphConversationId: message.conversationId ?? message.id,
    subject,
    occurredAt,
    references: referencedMessageIds(message),
  });

  const crmMessageId = `exchange:${await sha256(`${mailbox.id}\u0000${message.id}`)}`;
  const messageValues = [
    crmMessageId,
    conversation.id,
    mailbox.id,
    outbound ? "outbound" : "inbound",
    message.id,
    outbound ? mailbox.address : counterparty,
    JSON.stringify((message.toRecipients ?? []).map((entry) => entry.address)),
    JSON.stringify((message.ccRecipients ?? []).map((entry) => entry.address)),
    normalized(message.replyTo?.[0]?.address),
    subject,
    message.text ?? null,
    JSON.stringify(headerRecord(message)),
    JSON.stringify(outbound ? ["source-exchange", "external-history"] : ["source-exchange"]),
    outbound ? "accepted" : "received",
    occurredAt,
  ];
  const contactWrite = db.prepare(fence
    ? `INSERT INTO contacts (id,email,display_name)
      SELECT ?,?,? WHERE ${ACTIVE_LEASE}
      ON CONFLICT(email) DO UPDATE SET display_name=CASE
        WHEN contacts.validated_at IS NULL AND (contacts.display_name IS NULL OR trim(contacts.display_name)='')
        THEN excluded.display_name ELSE contacts.display_name END,updated_at=CURRENT_TIMESTAMP`
    : `INSERT INTO contacts (id,email,display_name) VALUES (?,?,?)
      ON CONFLICT(email) DO UPDATE SET display_name=CASE
        WHEN contacts.validated_at IS NULL AND (contacts.display_name IS NULL OR trim(contacts.display_name)='')
        THEN excluded.display_name ELSE contacts.display_name END,updated_at=CURRENT_TIMESTAMP`)
    .bind(contact.id, contact.email, outbound ? null : message.from?.name ?? message.sender?.name ?? null,
      ...fenceIdentityValues(fence));
  const writes = [contactWrite];

  if (conversation.create) {
    writes.push(db.prepare(`INSERT OR IGNORE INTO conversations
      (id,mailbox_id,contact_id,subject,normalized_subject,thread_key,is_unread,last_message_at)
      SELECT ?,?,(SELECT id FROM contacts WHERE email=? LIMIT 1),?,lower(trim(?)),?,0,?
      ${fence ? `WHERE ${ACTIVE_LEASE}` : ""}`)
      .bind(conversation.id, mailbox.id, contact.email, subject, subject, conversation.threadKey, occurredAt,
        ...fenceIdentityValues(fence)));
  }

  if (!outbound && mailbox.purpose === "sales") {
    writes.push(db.prepare(`INSERT OR IGNORE INTO deals (id,conversation_id,contact_id,stage)
      SELECT ?,?,(SELECT id FROM contacts WHERE email=? LIMIT 1),'new'
      ${fence ? `WHERE ${ACTIVE_LEASE}` : ""}`)
      .bind(crypto.randomUUID(), conversation.id, contact.email, ...fenceIdentityValues(fence)));
  }

  const insertMessage = db.prepare(`INSERT OR IGNORE INTO messages
    (id,conversation_id,mailbox_id,direction,transport_provider,provider_message_id,
     external_message_id,sender,recipients_json,cc_json,reply_to,subject,text_body,
     html_body,headers_json,traffic_type,tags_json,status,occurred_at)
    ${fence
      ? `SELECT ?,?,?,?,'exchange',?,NULL,?,?,?,?,?,?,NULL,?,'unclassified',?,?,?
        WHERE ${ACTIVE_LEASE}`
      : "VALUES (?,?,?,?,'exchange',?,NULL,?,?,?,?,?,?,NULL,?,'unclassified',?,?,?)"}`)
    .bind(...messageValues, ...fenceIdentityValues(fence));

  // Keep the message projection and its conversation summary in one D1 batch.
  // A cursor page is replayed after any exception, so committing only the first
  // write would otherwise leave a permanently incomplete unread/last-message
  // projection. The per-connection sync lease makes this first-seen branch
  // single-writer; completed replays return above and never undo an operator read.
  const updateConversation = db.prepare(`UPDATE conversations SET
      is_unread=CASE WHEN ?=1 AND ?=1 THEN 1 ELSE is_unread END,
      last_message_at=CASE WHEN last_message_at<? THEN ? ELSE last_message_at END,
      updated_at=CURRENT_TIMESTAMP WHERE id=?${fence ? ` AND ${ACTIVE_LEASE}` : ""}`)
    .bind(Number(!outbound), Number(message.isRead === false), occurredAt, occurredAt, conversation.id,
      ...fenceIdentityValues(fence));
  writes.push(insertMessage, updateConversation);

  // D1 batch is transactional. The final statement re-reads wall-clock time in
  // SQLite and deliberately raises on an expired/replaced lease, rolling back
  // every first-seen side effect (contact, conversation, deal, message and
  // summary) instead of merely noticing the loss after a partial commit.
  if (fence) {
    writes.push(db.prepare(`SELECT CASE WHEN ${ACTIVE_LEASE}
      THEN 1 ELSE json_extract('exchange-lease-expired','$') END AS active`)
      .bind(...fenceIdentityValues(fence)));
  }
  let results: Awaited<ReturnType<CrmDatabase["batch"]>>;
  try {
    results = await db.batch(writes);
  } catch {
    // Includes the deliberate final lease assertion. Keep SQL/provider details
    // private while guaranteeing that D1 rolls the complete projection back.
    throw new Error("exchange_message_persistence_failed");
  }
  const inserted = results.at(fence ? -3 : -2)!;
  const conversationUpdated = results.at(fence ? -2 : -1)!;

  const created = changedRows(inserted) === 1;
  const stored = created ? { id: crmMessageId } : await db.prepare(`SELECT id FROM messages
    WHERE transport_provider='exchange' AND provider_message_id=? LIMIT 1`)
    .bind(message.id).first<{ id: string }>();
  if (!stored) throw new Error("exchange_message_persistence_failed");
  if (changedRows(conversationUpdated) !== 1) throw new Error("exchange_conversation_projection_failed");

  return {
    mailboxId: mailbox.id,
    crmMessageId: stored.id,
    classification: outbound ? "external_sent" : "mapped",
  };
}

async function planContact(db: CrmDatabase, email: string): Promise<ContactPlan> {
  const row = await db.prepare("SELECT id FROM contacts WHERE email=? LIMIT 1")
    .bind(email).first<{ id: string }>();
  return { id: row?.id ?? crypto.randomUUID(), email };
}

async function planConversation(db: CrmDatabase, input: {
  mailbox: CrmMailbox;
  contactId: string;
  counterparty: string;
  graphConversationId: string;
  subject: string;
  occurredAt: string;
  references: string[];
}): Promise<ConversationPlan> {
  const referenced = await referencedConversation(db, input);
  if (referenced) return { id: referenced, threadKey: "", create: false };
  const threadKey = `exchange:${await sha256(`${input.graphConversationId}\u0000${input.counterparty}`)}`;
  const existing = await db.prepare(`SELECT id,contact_id AS contactId FROM conversations
    WHERE mailbox_id=? AND thread_key=? LIMIT 1`).bind(input.mailbox.id, threadKey)
    .first<{ id: string; contactId: string | null }>();
  if (existing && existing.contactId !== input.contactId) throw new Error("exchange_conversation_upsert_failed");
  return existing
    ? { id: existing.id, threadKey, create: false }
    : { id: crypto.randomUUID(), threadKey, create: true };
}

async function referencedConversation(db: CrmDatabase, input: {
  mailbox: CrmMailbox; contactId: string; counterparty: string; references: string[];
}): Promise<string | null> {
  if (!input.references.length) return null;
  const references = input.references.map((value) => value.slice(1, -1).toLowerCase());
  const placeholders = references.map(() => "?").join(",");
  const result = await db.prepare(`SELECT DISTINCT conversation.id
    FROM messages message
    JOIN conversations conversation ON conversation.id=message.conversation_id
    JOIN contacts contact ON contact.id=conversation.contact_id
    LEFT JOIN exchange_message_links exchange_link
      ON exchange_link.crm_message_id=message.id
     AND exchange_link.logical_mailbox_id=conversation.mailbox_id
     AND exchange_link.classification='mapped'
    WHERE (lower(trim(message.external_message_id, '<> ')) IN (${placeholders})
      OR lower(trim(exchange_link.internet_message_id, '<> ')) IN (${placeholders}))
      AND conversation.mailbox_id=? AND conversation.contact_id=? AND contact.email=?
    LIMIT 2`).bind(...references, ...references, input.mailbox.id, input.contactId, input.counterparty)
    .all<{ id: string }>();
  return result.success && result.results.length === 1 ? result.results[0].id : null;
}

function singleExternalRecipient(message: ExchangeGraphMessage): string | null {
  const own = new Set<string>(CRM_MAILBOXES.map((mailbox) => mailbox.address));
  const recipients = [...new Set([...(message.toRecipients ?? []), ...(message.ccRecipients ?? [])]
    .map((entry) => normalized(entry.address))
    .filter((entry): entry is string => entry !== null && !own.has(entry)))];
  return recipients.length === 1 ? recipients[0] : null;
}

function referencedMessageIds(message: ExchangeGraphMessage): string[] {
  const values = (message.headers ?? [])
    .filter((header) => header.name === "in-reply-to" || header.name === "references")
    .flatMap((header) => header.value.match(/<[^\s<>]+@[^\s<>]+>/gu) ?? []);
  return [...new Set(values)].slice(0, 50);
}

function headerRecord(message: ExchangeGraphMessage): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const header of message.headers ?? []) (result[header.name] ??= []).push(header.value);
  return result;
}

function eventTime(message: ExchangeGraphMessage, outbound: boolean): string | null {
  const value = outbound ? message.sentDateTime ?? message.lastModifiedDateTime : message.receivedDateTime ?? message.lastModifiedDateTime;
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function boundedSubject(value: string | undefined): string {
  const subject = value?.trim() || "(Sans objet)";
  return Array.from(subject).slice(0, 500).join("");
}

function normalized(value: string | null | undefined): string | null {
  return value ? normalizeEmailAddress(value) : null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fenceIdentityValues(fence: ProjectionFence | undefined): unknown[] {
  return fence ? [
    fence.scope.tenantId,
    fence.scope.mailboxId,
    fence.guard.owner,
    fence.guard.generation,
  ] : [];
}
