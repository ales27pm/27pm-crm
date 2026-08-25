import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const timestamp = (name: string) =>
  text(name).notNull().default(sql`CURRENT_TIMESTAMP`);

export const mailboxes = sqliteTable(
  "mailboxes",
  {
    id: text("id").primaryKey(),
    address: text("address").notNull(),
    localPart: text("local_part").notNull(),
    displayName: text("display_name").notNull(),
    purpose: text("purpose").notNull(),
    isActive: integer("is_active", { mode: "boolean" })
      .notNull()
      .default(true),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("mailboxes_address_unique").on(table.address),
    uniqueIndex("mailboxes_local_part_unique").on(table.localPart),
    check(
      "mailboxes_purpose_check",
      sql`${table.purpose} in ('sales', 'operations')`,
    ),
  ],
);

export const contacts = sqliteTable(
  "contacts",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    organization: text("organization"),
    phone: text("phone"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [uniqueIndex("contacts_email_unique").on(table.email)],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: text("id").primaryKey(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "restrict" }),
    contactId: text("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    subject: text("subject").notNull().default("(Sans objet)"),
    normalizedSubject: text("normalized_subject").notNull().default(""),
    threadKey: text("thread_key").notNull(),
    isUnread: integer("is_unread", { mode: "boolean" })
      .notNull()
      .default(true),
    followUpState: text("follow_up_state").notNull().default("none"),
    followUpAt: text("follow_up_at"),
    lastMessageAt: text("last_message_at").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("conversations_mailbox_thread_unique").on(
      table.mailboxId,
      table.threadKey,
    ),
    index("conversations_mailbox_last_message_idx").on(
      table.mailboxId,
      table.lastMessageAt,
    ),
    index("conversations_follow_up_idx").on(
      table.followUpState,
      table.followUpAt,
    ),
    check(
      "conversations_follow_up_state_check",
      sql`${table.followUpState} in ('none', 'pending', 'waiting', 'done')`,
    ),
  ],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "restrict" }),
    direction: text("direction").notNull(),
    externalMessageId: text("external_message_id"),
    providerStorageKey: text("provider_storage_key"),
    sender: text("sender").notNull(),
    recipientsJson: text("recipients_json").notNull().default("[]"),
    ccJson: text("cc_json").notNull().default("[]"),
    replyTo: text("reply_to"),
    subject: text("subject").notNull().default("(Sans objet)"),
    textBody: text("text_body"),
    htmlBody: text("html_body"),
    headersJson: text("headers_json").notNull().default("{}"),
    status: text("status").notNull().default("received"),
    occurredAt: text("occurred_at").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("messages_external_message_id_unique").on(
      table.externalMessageId,
    ),
    index("messages_conversation_occurred_idx").on(
      table.conversationId,
      table.occurredAt,
    ),
    check(
      "messages_direction_check",
      sql`${table.direction} in ('inbound', 'outbound')`,
    ),
    check(
      "messages_status_check",
      sql`${table.status} in ('received', 'queued', 'accepted', 'delivered', 'temporary-failure', 'permanent-failure', 'bounced', 'complained')`,
    ),
  ],
);

export const attachments = sqliteTable(
  "attachments",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    r2Key: text("r2_key").notNull(),
    fileName: text("file_name").notNull(),
    contentType: text("content_type")
      .notNull()
      .default("application/octet-stream"),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256"),
    scanStatus: text("scan_status").notNull().default("unscanned"),
    scanDetail: text("scan_detail"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("attachments_r2_key_unique").on(table.r2Key),
    index("attachments_message_idx").on(table.messageId),
    check(
      "attachments_scan_status_check",
      sql`${table.scanStatus} in ('unscanned', 'clean', 'infected', 'rejected')`,
    ),
    check("attachments_size_check", sql`${table.sizeBytes} >= 0`),
  ],
);

export const deals = sqliteTable(
  "deals",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    stage: text("stage").notNull().default("new"),
    projectType: text("project_type"),
    nextAction: text("next_action"),
    nextActionAt: text("next_action_at"),
    note: text("note").notNull().default(""),
    estimatedValueCents: integer("estimated_value_cents"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("deals_conversation_unique").on(table.conversationId),
    index("deals_stage_next_action_idx").on(table.stage, table.nextActionAt),
    check(
      "deals_stage_check",
      sql`${table.stage} in ('new', 'qualified', 'discovery', 'proposal', 'won', 'lost', 'archived')`,
    ),
    check(
      "deals_estimated_value_check",
      sql`${table.estimatedValueCents} is null or ${table.estimatedValueCents} >= 0`,
    ),
  ],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id").references(
      () => conversations.id,
      { onDelete: "cascade" },
    ),
    dealId: text("deal_id").references(() => deals.id, {
      onDelete: "cascade",
    }),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"),
    dueAt: text("due_at"),
    completedAt: text("completed_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("tasks_status_due_idx").on(table.status, table.dueAt),
    check(
      "tasks_status_check",
      sql`${table.status} in ('open', 'done', 'cancelled')`,
    ),
    check(
      "tasks_parent_check",
      sql`${table.conversationId} is not null or ${table.dealId} is not null`,
    ),
  ],
);

export const webhookReceipts = sqliteTable(
  "webhook_receipts",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    kind: text("kind").notNull(),
    signatureToken: text("signature_token").notNull(),
    signatureTimestamp: integer("signature_timestamp").notNull(),
    callbackKey: text("callback_key").notNull(),
    receivedAt: timestamp("received_at"),
  },
  (table) => [
    uniqueIndex("webhook_receipts_signature_token_unique").on(
      table.signatureToken,
    ),
    uniqueIndex("webhook_receipts_callback_key_unique").on(table.callbackKey),
    check(
      "webhook_receipts_kind_check",
      sql`${table.kind} in ('inbound', 'event')`,
    ),
  ],
);

export const messageEvents = sqliteTable(
  "message_events",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id").references(() => messages.id, {
      onDelete: "set null",
    }),
    providerEventId: text("provider_event_id"),
    callbackKey: text("callback_key").notNull(),
    eventType: text("event_type").notNull(),
    severity: text("severity"),
    recipient: text("recipient"),
    eventTimestamp: text("event_timestamp").notNull(),
    payloadJson: text("payload_json").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("message_events_provider_event_id_unique").on(
      table.providerEventId,
    ),
    uniqueIndex("message_events_callback_key_unique").on(table.callbackKey),
    index("message_events_message_timestamp_idx").on(
      table.messageId,
      table.eventTimestamp,
    ),
  ],
);

export const sendCommands = sqliteTable(
  "send_commands",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    mailboxId: text("mailbox_id")
      .notNull()
      .references(() => mailboxes.id, { onDelete: "restrict" }),
    conversationId: text("conversation_id").references(
      () => conversations.id,
      { onDelete: "set null" },
    ),
    status: text("status").notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    responseStatus: integer("response_status"),
    failureCode: text("failure_code"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("send_commands_idempotency_key_unique").on(
      table.idempotencyKey,
    ),
    uniqueIndex("send_commands_provider_message_id_unique").on(
      table.providerMessageId,
    ),
    check(
      "send_commands_status_check",
      sql`${table.status} in ('pending', 'sent', 'failed')`,
    ),
  ],
);

export const auditEntries = sqliteTable(
  "audit_entries",
  {
    id: text("id").primaryKey(),
    actorEmail: text("actor_email").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    detailsJson: text("details_json").notNull().default("{}"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("audit_entries_entity_created_idx").on(
      table.entityType,
      table.entityId,
      table.createdAt,
    ),
  ],
);
