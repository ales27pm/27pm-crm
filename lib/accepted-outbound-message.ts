import type { CrmDatabase } from "./d1";

const CRM_PROSPECTING_TAGS = ["source-crm", "traffic-prospecting"] as const;
const CRM_ADMINISTRATIVE_TAGS = ["source-crm", "traffic-administrative"] as const;

type AcceptedOutboundProvider = "mailgun" | "cakemail";

type AcceptedOutboundMailbox = {
  id: string;
  address: string;
  purpose: "sales" | "operations";
};

export type AcceptedOutboundMessage = {
  commandId: string;
  contactId: string;
  provider: AcceptedOutboundProvider;
  providerMessageId: string;
  externalMessageId: string;
  mailbox: AcceptedOutboundMailbox;
  recipient: string;
  subject: string;
  text: string | null;
  html: string | null;
  actorEmail: string;
  conversationId?: string | null;
  occurredAt: string;
};

type StoredMessage = {
  conversationId: string;
  externalMessageId: string | null;
};

type Contact = {
  id: string;
  organizationId: string | null;
};

type Conversation = {
  id: string;
  mailboxId: string;
  contactId: string | null;
  contactEmail: string | null;
  organizationId: string | null;
};

/**
 * Repairs the local CRM side of a provider-accepted send. Provider dispatch
 * must already be complete; this helper never contacts the outbound provider.
 */
export async function recordAcceptedOutboundMessage(
  db: CrmDatabase,
  input: AcceptedOutboundMessage,
): Promise<string> {
  const stored = await storedProviderMessage(db, input);
  if (stored) {
    if (stored.externalMessageId !== input.externalMessageId) {
      throw new Error("accepted_message_provider_identity_conflict");
    }
    return stored.conversationId;
  }

  const recipient = input.recipient.trim().toLowerCase();
  const contact = await authorizedContact(db, input.contactId);
  if (!contact) throw new Error("accepted_message_contact_not_found");
  const trafficType = input.mailbox.purpose === "operations"
    ? "administrative"
    : "prospecting";
  const tags = input.mailbox.purpose === "operations"
    ? CRM_ADMINISTRATIVE_TAGS
    : CRM_PROSPECTING_TAGS;

  const conversation = input.conversationId
    ? await existingConversation(db, input.conversationId)
    : await findOrCreateConversation(db, input, contact);
  assertConversationMatches(
    conversation,
    input.mailbox.id,
    contact.id,
  );

  if (input.mailbox.purpose === "sales") {
    await ensureSalesDeal(db, conversation);
  }

  const recordDigest = await sha256Hex(
    `${input.provider}\u0000${input.providerMessageId}`,
  );
  const messageId = `accepted-message:${recordDigest}`;
  const auditId = `accepted-message-audit:${recordDigest}`;

  await db.batch([
    db
      .prepare(
        `INSERT OR IGNORE INTO messages
          (id, conversation_id, mailbox_id, direction, transport_provider,
           provider_message_id, external_message_id, sender, recipients_json,
           subject, text_body, html_body, traffic_type, tags_json, status,
           occurred_at)
         VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 ?, 'accepted', ?)`,
      )
      .bind(
        messageId,
        conversation.id,
        input.mailbox.id,
        input.provider,
        input.providerMessageId,
        input.externalMessageId,
        input.mailbox.address,
        JSON.stringify([recipient]),
        input.subject,
        input.text,
        input.html,
        trafficType,
        JSON.stringify(tags),
        input.occurredAt,
      ),
    db
      .prepare(
        `UPDATE conversations
         SET is_unread = 0,
             last_message_at = CASE
               WHEN last_message_at < ? THEN ? ELSE last_message_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(input.occurredAt, input.occurredAt, conversation.id),
    db
      .prepare(
        `UPDATE send_commands
         SET conversation_id = ?, failure_code = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND transport_provider = ?
           AND provider_message_id = ? AND status = 'sent'`,
      )
      .bind(
        conversation.id,
        input.commandId,
        input.provider,
        input.providerMessageId,
      ),
    db
      .prepare(
        `INSERT OR IGNORE INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'message.sent', 'conversation', ?, ?)`,
      )
      .bind(
        auditId,
        input.actorEmail,
        conversation.id,
        JSON.stringify({
          mailboxId: input.mailbox.id,
          trafficType,
          tags,
          provider: input.provider,
          providerMessageId: input.providerMessageId,
          externalMessageId: input.externalMessageId,
        }),
      ),
    db
      .prepare(
        `UPDATE contacts
         SET last_contact_at = CASE
               WHEN last_contact_at IS NULL OR last_contact_at < ? THEN ?
               ELSE last_contact_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(input.occurredAt, input.occurredAt, conversation.contactId),
    db
      .prepare(
        `UPDATE organizations
         SET last_contact_at = CASE
               WHEN last_contact_at IS NULL OR last_contact_at < ? THEN ?
               ELSE last_contact_at END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .bind(input.occurredAt, input.occurredAt, conversation.organizationId),
  ]);

  const recorded = await storedProviderMessage(db, input);
  if (!recorded) throw new Error("accepted_message_persistence_failed");
  return recorded.conversationId;
}

async function storedProviderMessage(
  db: CrmDatabase,
  input: Pick<AcceptedOutboundMessage, "provider" | "providerMessageId">,
): Promise<StoredMessage | null> {
  return db
    .prepare(
      `SELECT conversation_id AS conversationId,
              external_message_id AS externalMessageId
       FROM messages
       WHERE direction = 'outbound' AND transport_provider = ?
         AND provider_message_id = ?
       LIMIT 1`,
    )
    .bind(input.provider, input.providerMessageId)
    .first<StoredMessage>();
}

async function authorizedContact(
  db: CrmDatabase,
  contactId: string,
): Promise<Contact | null> {
  return db
    .prepare(
      `SELECT id, organization_id AS organizationId
       FROM contacts
       WHERE id = ?
       LIMIT 1`,
    )
    .bind(contactId)
    .first<Contact>();
}

async function existingConversation(
  db: CrmDatabase,
  conversationId: string,
): Promise<Conversation> {
  const conversation = await loadConversation(db, "c.id = ?", conversationId);
  if (!conversation) throw new Error("accepted_message_conversation_not_found");
  return conversation;
}

async function findOrCreateConversation(
  db: CrmDatabase,
  input: AcceptedOutboundMessage,
  contact: Contact,
): Promise<Conversation> {
  const threadKey = `message:${input.externalMessageId}`;
  const conversationDigest = await sha256Hex(
    `${input.mailbox.id}\u0000${threadKey}`,
  );
  await db
    .prepare(
      `INSERT OR IGNORE INTO conversations
        (id, mailbox_id, contact_id, subject, normalized_subject, thread_key,
         is_unread, last_message_at)
       VALUES (?, ?, ?, ?, lower(trim(?)), ?, 0, ?)`,
    )
    .bind(
      `accepted-conversation:${conversationDigest}`,
      input.mailbox.id,
      contact.id,
      input.subject,
      input.subject,
      threadKey,
      input.occurredAt,
    )
    .run();

  const conversation = await loadConversation(
    db,
    "c.mailbox_id = ? AND c.thread_key = ?",
    input.mailbox.id,
    threadKey,
  );
  if (!conversation) throw new Error("accepted_message_conversation_create_failed");
  return conversation;
}

async function loadConversation(
  db: CrmDatabase,
  condition: string,
  ...bindings: unknown[]
): Promise<Conversation | null> {
  return db
    .prepare(
      `SELECT c.id, c.mailbox_id AS mailboxId, c.contact_id AS contactId,
              contact.email AS contactEmail,
              COALESCE(deal.organization_id, contact.organization_id) AS organizationId
       FROM conversations c
       LEFT JOIN contacts contact ON contact.id = c.contact_id
       LEFT JOIN deals deal ON deal.conversation_id = c.id
       WHERE ${condition}
       LIMIT 1`,
    )
    .bind(...bindings)
    .first<Conversation>();
}

function assertConversationMatches(
  conversation: Conversation,
  mailboxId: string,
  contactId: string,
): void {
  if (conversation.mailboxId !== mailboxId) {
    throw new Error("accepted_message_conversation_mailbox_mismatch");
  }
  if (conversation.contactId !== contactId) {
    throw new Error("accepted_message_conversation_recipient_mismatch");
  }
}

async function ensureSalesDeal(
  db: CrmDatabase,
  conversation: Conversation,
): Promise<void> {
  const dealDigest = await sha256Hex(conversation.id);
  await db
    .prepare(
      `INSERT OR IGNORE INTO deals
        (id, conversation_id, organization_id, contact_id, stage)
       VALUES (?, ?, ?, ?, 'new')`,
    )
    .bind(
      `accepted-deal:${dealDigest}`,
      conversation.id,
      conversation.organizationId,
      conversation.contactId,
    )
    .run();

  const stored = await db
    .prepare("SELECT id FROM deals WHERE conversation_id = ? LIMIT 1")
    .bind(conversation.id)
    .first<{ id: string }>();
  if (!stored) throw new Error("accepted_message_deal_create_failed");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
