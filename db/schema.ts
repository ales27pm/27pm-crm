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

export const organizations = sqliteTable(
  "organizations",
  {
    id: text("id").primaryKey(),
    externalKey: text("external_key").notNull(),
    name: text("name").notNull(),
    website: text("website"),
    sourceLabel: text("source_label").notNull(),
    sourceUrl: text("source_url"),
    sourceDate: text("source_date"),
    score: integer("score"),
    priority: text("priority").notNull().default("normal"),
    budgetMinCents: integer("budget_min_cents"),
    budgetMaxCents: integer("budget_max_cents"),
    budgetIsHypothesis: integer("budget_is_hypothesis", { mode: "boolean" })
      .notNull()
      .default(true),
    ownerEmail: text("owner_email"),
    doNotContact: integer("do_not_contact", { mode: "boolean" })
      .notNull()
      .default(false),
    lastContactAt: text("last_contact_at"),
    nextFollowUpAt: text("next_follow_up_at"),
    nextStep: text("next_step"),
    notes: text("notes").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(1000),
    deletedAt: text("deleted_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("organizations_external_key_unique").on(table.externalKey),
    index("organizations_score_priority_idx").on(table.score, table.priority),
    index("organizations_follow_up_idx").on(
      table.doNotContact,
      table.nextFollowUpAt,
    ),
    check(
      "organizations_score_check",
      sql`${table.score} is null or (${table.score} >= 0 and ${table.score} <= 100)`,
    ),
    check(
      "organizations_priority_check",
      sql`${table.priority} in ('very_high', 'high', 'normal', 'low')`,
    ),
    check(
      "organizations_budget_check",
      sql`(${table.budgetMinCents} is null or ${table.budgetMinCents} >= 0)
          and (${table.budgetMaxCents} is null or ${table.budgetMaxCents} >= 0)
          and (${table.budgetMinCents} is null or ${table.budgetMaxCents} is null
               or ${table.budgetMaxCents} >= ${table.budgetMinCents})`,
    ),
  ],
);

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
    source: text("source").notNull().default("Courriel"),
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    role: text("role"),
    roleRelevanceDetail: text("role_relevance_detail").notNull().default(""),
    personalDataCategory: text("personal_data_category")
      .notNull()
      .default("work_contact"),
    qualificationMode: text("qualification_mode").notNull().default("manual"),
    complianceVersion: integer("compliance_version").notNull().default(1),
    sourceUrl: text("source_url"),
    sourceDate: text("source_date"),
    contactBasis: text("contact_basis").notNull().default("unknown"),
    roleRelevance: text("role_relevance").notNull().default("unknown"),
    dnclStatus: text("dncl_status").notNull().default("not_checked"),
    dnclCheckedAt: text("dncl_checked_at"),
    emailStatus: text("email_status").notNull().default("unknown"),
    unsubscribedAt: text("unsubscribed_at"),
    doNotCall: integer("do_not_call", { mode: "boolean" })
      .notNull()
      .default(false),
    doNotContact: integer("do_not_contact", { mode: "boolean" })
      .notNull()
      .default(false),
    lastContactAt: text("last_contact_at"),
    nextFollowUpAt: text("next_follow_up_at"),
    validatedAt: text("validated_at"),
    deletedAt: text("deleted_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("contacts_email_unique").on(table.email),
    index("contacts_organization_idx").on(table.organizationId),
    index("contacts_contactability_idx").on(
      table.doNotContact,
      table.unsubscribedAt,
      table.deletedAt,
    ),
    check(
      "contacts_basis_check",
      sql`${table.contactBasis} in ('unknown', 'inbound_request', 'explicit_consent', 'legitimate_interest', 'existing_client')`,
    ),
    check(
      "contacts_role_relevance_check",
      sql`${table.roleRelevance} in ('unknown', 'relevant', 'not_relevant')`,
    ),
    check(
      "contacts_dncl_status_check",
      sql`${table.dnclStatus} in ('not_checked', 'not_listed', 'listed', 'not_applicable')`,
    ),
    check(
      "contacts_email_status_check",
      sql`${table.emailStatus} in ('unknown', 'valid', 'bounced', 'invalid', 'unsubscribed')`,
    ),
    check(
      "contacts_personal_data_category_check",
      sql`${table.personalDataCategory} in ('work_contact', 'other_personal')`,
    ),
    check(
      "contacts_qualification_mode_check",
      sql`${table.qualificationMode} in ('manual', 'assisted', 'fully_automated')`,
    ),
  ],
);

export const contactChannelCompliance = sqliteTable(
  "contact_channel_compliance",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(),
    addressNormalized: text("address_normalized").notNull(),
    provenanceType: text("provenance_type").notNull().default("unknown"),
    sourceUrl: text("source_url"),
    capturedAt: text("captured_at"),
    evidenceRef: text("evidence_ref"),
    lawfulBasis: text("lawful_basis").notNull().default("none"),
    basisVerifiedBy: text("basis_verified_by"),
    basisVerifiedAt: text("basis_verified_at"),
    basisEvidenceRef: text("basis_evidence_ref"),
    basisExpiresAt: text("basis_expires_at"),
    publicationByRecipient: integer("publication_by_recipient", { mode: "boolean" })
      .notNull()
      .default(false),
    publicationNoRestriction: integer("publication_no_restriction", { mode: "boolean" })
      .notNull()
      .default(false),
    publicationRoleRelevance: text("publication_role_relevance").notNull().default(""),
    directDisclosureNoRestriction: integer("direct_disclosure_no_restriction", { mode: "boolean" })
      .notNull()
      .default(false),
    b2bRelationshipEvidence: text("b2b_relationship_evidence").notNull().default(""),
    b2bMessageRelevance: text("b2b_message_relevance").notNull().default(""),
    dnclStatus: text("dncl_status").notNull().default("not_checked"),
    dnclCheckedAt: text("dncl_checked_at"),
    dnclEvidenceRef: text("dncl_evidence_ref"),
    recipientTimezone: text("recipient_timezone"),
    status: text("status").notNull().default("unknown"),
    validatedAt: text("validated_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("contact_channel_address_unique").on(
      table.channel,
      table.addressNormalized,
    ),
    uniqueIndex("contact_channel_contact_unique").on(table.contactId, table.channel),
    index("contact_channel_contact_idx").on(table.contactId),
    check("contact_channel_type_check", sql`${table.channel} in ('email', 'phone')`),
    check(
      "contact_channel_provenance_check",
      sql`${table.provenanceType} in ('first_party_inbound', 'recipient_published', 'authorized_publication', 'direct_disclosure', 'existing_relationship', 'third_party', 'unknown')`,
    ),
    check(
      "contact_channel_basis_check",
      sql`${table.lawfulBasis} in ('explicit_consent', 'existing_business_relationship', 'conspicuous_publication', 'direct_disclosure', 'b2b_exemption', 'requested_response', 'none')`,
    ),
    check(
      "contact_channel_status_check",
      sql`${table.status} in ('unknown', 'valid', 'bounced', 'invalid', 'unsubscribed')`,
    ),
    check(
      "contact_channel_dncl_check",
      sql`${table.dnclStatus} in ('not_checked', 'not_listed', 'listed', 'not_applicable')`,
    ),
  ],
);

export const contactSuppressions = sqliteTable(
  "contact_suppressions",
  {
    id: text("id").primaryKey(),
    channel: text("channel").notNull(),
    addressNormalized: text("address_normalized").notNull(),
    scope: text("scope").notNull().default("global"),
    category: text("category").notNull().default("all"),
    reason: text("reason").notNull(),
    evidenceRef: text("evidence_ref").notNull(),
    requestedAt: text("requested_at").notNull(),
    effectiveAt: text("effective_at").notNull(),
    retainUntil: text("retain_until"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("contact_suppression_identity_unique").on(
      table.channel,
      table.addressNormalized,
      table.scope,
      table.category,
    ),
    index("contact_suppression_lookup_idx").on(
      table.channel,
      table.addressNormalized,
    ),
    check("contact_suppression_channel_check", sql`${table.channel} in ('email', 'phone')`),
    check("contact_suppression_scope_check", sql`${table.scope} in ('global', 'category')`),
  ],
);

export const complianceConfiguration = sqliteTable(
  "compliance_configuration",
  {
    id: text("id").primaryKey(),
    version: integer("version").notNull().default(1),
    senderName: text("sender_name").notNull().default(""),
    organizationName: text("organization_name").notNull().default(""),
    postalAddress: text("postal_address").notNull().default(""),
    contactMethod: text("contact_method").notNull().default(""),
    identityValidUntil: text("identity_valid_until"),
    unsubscribeMechanismValidatedAt: text("unsubscribe_mechanism_validated_at"),
    unsubscribeMechanismValidUntil: text("unsubscribe_mechanism_valid_until"),
    dnclRegistrationConfirmed: integer("dncl_registration_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    dnclRegistrationVerifiedAt: text("dncl_registration_verified_at"),
    dnclRegistrationEvidenceRef: text("dncl_registration_evidence_ref").notNull().default(""),
    businessNumberConfirmed: integer("business_number_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    businessNumber: text("business_number").notNull().default(""),
    businessNumberEvidenceRef: text("business_number_evidence_ref").notNull().default(""),
    callerIdentity: text("caller_identity").notNull().default(""),
    callerDisplayNumber: text("caller_display_number").notNull().default(""),
    automatedDialerDisabled: integer("automated_dialer_disabled", { mode: "boolean" })
      .notNull()
      .default(true),
    prerecordedCallsDisabled: integer("prerecorded_calls_disabled", { mode: "boolean" })
      .notNull()
      .default(true),
    sequentialDialingDisabled: integer("sequential_dialing_disabled", { mode: "boolean" })
      .notNull()
      .default(true),
    crossBorderEfvpConfirmed: integer("cross_border_efvp_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    crossBorderContractConfirmed: integer("cross_border_contract_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    crossBorderLegalValidationConfirmed: integer("cross_border_legal_validation_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    crossBorderEvidenceRef: text("cross_border_evidence_ref").notNull().default(""),
    automatedQualificationLegalValidationConfirmed: integer("automated_qualification_legal_validation_confirmed", { mode: "boolean" })
      .notNull()
      .default(false),
    automatedQualificationEvidenceRef: text("automated_qualification_evidence_ref").notNull().default(""),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [check("compliance_configuration_singleton", sql`${table.id} = 'default'`)],
);

export const privacyRequests = sqliteTable(
  "privacy_requests",
  {
    id: text("id").primaryKey(),
    contactId: text("contact_id").references(() => contacts.id, { onDelete: "set null" }),
    requestType: text("request_type").notNull(),
    status: text("status").notNull().default("received"),
    requesterReference: text("requester_reference").notNull(),
    requestedAt: text("requested_at").notNull(),
    dueAt: text("due_at"),
    handledBy: text("handled_by"),
    resolutionNote: text("resolution_note").notNull().default(""),
    completedAt: text("completed_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("privacy_requests_status_due_idx").on(table.status, table.dueAt),
    check(
      "privacy_requests_type_check",
      sql`${table.requestType} in ('access', 'rectification', 'withdrawal', 'destruction', 'structured_export')`,
    ),
    check(
      "privacy_requests_status_check",
      sql`${table.status} in ('received', 'identity_pending', 'in_progress', 'completed', 'refused')`,
    ),
  ],
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
    organizationId: text("organization_id").references(() => organizations.id, {
      onDelete: "restrict",
    }),
    contactId: text("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
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

export const interactions = sqliteTable(
  "interactions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").references(
      () => organizations.id,
      { onDelete: "cascade" },
    ),
    contactId: text("contact_id").references(() => contacts.id, {
      onDelete: "cascade",
    }),
    dealId: text("deal_id").references(() => deals.id, {
      onDelete: "cascade",
    }),
    kind: text("kind").notNull(),
    summary: text("summary").notNull(),
    occurredAt: text("occurred_at").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    index("interactions_contact_occurred_idx").on(
      table.contactId,
      table.occurredAt,
    ),
    index("interactions_deal_occurred_idx").on(table.dealId, table.occurredAt),
    index("interactions_organization_occurred_idx").on(
      table.organizationId,
      table.occurredAt,
    ),
    check(
      "interactions_parent_check",
      sql`${table.organizationId} is not null or ${table.contactId} is not null`,
    ),
    check(
      "interactions_kind_check",
      sql`${table.kind} in ('call', 'email', 'meeting', 'note', 'other')`,
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
    contactAction: integer("contact_action", { mode: "boolean" })
      .notNull()
      .default(true),
    contactChannel: text("contact_channel").notNull().default("internal"),
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
    check(
      "tasks_contact_channel_check",
      sql`${table.contactChannel} in ('internal', 'email', 'phone')`,
    ),
  ],
);

export const outreachStrategies = sqliteTable(
  "outreach_strategies",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    contactId: text("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    version: integer("version").notNull().default(1),
    status: text("status").notNull().default("draft"),
    objective: text("objective").notNull(),
    targetName: text("target_name"),
    targetRole: text("target_role").notNull(),
    valueProposition: text("value_proposition").notNull(),
    openingAngle: text("opening_angle").notNull(),
    timingRationale: text("timing_rationale").notNull(),
    contactResearchNotes: text("contact_research_notes").notNull().default(""),
    recommendedStartAt: text("recommended_start_at").notNull(),
    recipientTimezone: text("recipient_timezone")
      .notNull()
      .default("America/Toronto"),
    researchSource: text("research_source").notNull().default(""),
    researchSourceUrl: text("research_source_url"),
    researchCapturedAt: text("research_captured_at"),
    createdBy: text("created_by").notNull(),
    updatedBy: text("updated_by").notNull(),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("outreach_strategies_organization_unique").on(
      table.organizationId,
    ),
    index("outreach_strategies_status_start_idx").on(
      table.status,
      table.recommendedStartAt,
    ),
    check(
      "outreach_strategies_status_check",
      sql`${table.status} in ('draft', 'ready', 'active', 'paused', 'completed', 'archived')`,
    ),
  ],
);

export const outreachSteps = sqliteTable(
  "outreach_steps",
  {
    id: text("id").primaryKey(),
    strategyId: text("strategy_id")
      .notNull()
      .references(() => outreachStrategies.id, { onDelete: "cascade" }),
    sequenceIndex: integer("sequence_index").notNull(),
    businessDayOffset: integer("business_day_offset").notNull(),
    actionType: text("action_type").notNull(),
    title: text("title").notNull(),
    purpose: text("purpose").notNull(),
    requiresContact: integer("requires_contact", { mode: "boolean" })
      .notNull()
      .default(false),
    status: text("status").notNull().default("planned"),
    scheduledAt: text("scheduled_at").notNull(),
    completedAt: text("completed_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    uniqueIndex("outreach_steps_strategy_sequence_unique").on(
      table.strategyId,
      table.sequenceIndex,
    ),
    index("outreach_steps_status_schedule_idx").on(
      table.status,
      table.scheduledAt,
    ),
    check(
      "outreach_steps_action_type_check",
      sql`${table.actionType} in ('research', 'review', 'email', 'call', 'nurture')`,
    ),
    check(
      "outreach_steps_status_check",
      sql`${table.status} in ('planned', 'ready', 'blocked', 'done', 'skipped')`,
    ),
    check(
      "outreach_steps_offset_check",
      sql`${table.businessDayOffset} >= -30 and ${table.businessDayOffset} <= 365`,
    ),
  ],
);

export const accountImports = sqliteTable(
  "account_imports",
  {
    id: text("id").primaryKey(),
    importKey: text("import_key").notNull(),
    requestHash: text("request_hash"),
    sourceLabel: text("source_label").notNull(),
    sourceUrl: text("source_url"),
    sourceDate: text("source_date"),
    recordCount: integer("record_count").notNull(),
    actorEmail: text("actor_email").notNull(),
    createdAt: timestamp("created_at"),
  },
  (table) => [uniqueIndex("account_imports_key_unique").on(table.importKey)],
);

export const intakeSubmissions = sqliteTable(
  "intake_submissions",
  {
    id: text("id").primaryKey(),
    idempotencyKey: text("idempotency_key").notNull(),
    requesterHash: text("requester_hash").notNull(),
    origin: text("origin").notNull(),
    organizationName: text("organization_name").notNull(),
    contactName: text("contact_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    projectType: text("project_type"),
    message: text("message").notNull(),
    status: text("status").notNull().default("pending"),
    reviewedBy: text("reviewed_by"),
    reviewedAt: text("reviewed_at"),
    createdAt: timestamp("created_at"),
  },
  (table) => [
    uniqueIndex("intake_submissions_idempotency_unique").on(
      table.idempotencyKey,
    ),
    index("intake_submissions_rate_idx").on(table.requesterHash, table.createdAt),
    index("intake_submissions_status_created_idx").on(table.status, table.createdAt),
    check(
      "intake_submissions_status_check",
      sql`${table.status} in ('pending', 'accepted', 'rejected')`,
    ),
  ],
);

export const intakeRateLimits = sqliteTable(
  "intake_rate_limits",
  {
    bucketKey: text("bucket_key").primaryKey(),
    requesterHash: text("requester_hash").notNull(),
    count: integer("count").notNull().default(1),
    expiresAt: text("expires_at").notNull(),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("intake_rate_limits_expiry_idx").on(table.expiresAt),
    check("intake_rate_limits_count_check", sql`${table.count} > 0 and ${table.count} <= 5`),
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
    status: text("status").notNull().default("reserved"),
    processedAt: text("processed_at"),
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
    check(
      "webhook_receipts_status_check",
      sql`${table.status} in ('reserved', 'processed')`,
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
    contactId: text("contact_id").references(() => contacts.id, {
      onDelete: "set null",
    }),
    contactComplianceVersion: integer("contact_compliance_version"),
    configurationVersion: integer("configuration_version"),
    authorizedAt: text("authorized_at"),
    dispatchedAt: text("dispatched_at"),
    operatorConfirmedAt: text("operator_confirmed_at"),
    complianceSnapshotJson: text("compliance_snapshot_json"),
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
      sql`${table.status} in ('pending', 'authorized', 'dispatching', 'sent', 'failed', 'cancelled')`,
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

export const credentialHandoffs = sqliteTable(
  "credential_handoffs",
  {
    id: text("id").primaryKey(),
    purpose: text("purpose").notNull(),
    keyFingerprint: text("key_fingerprint").notNull(),
    ciphertext: text("ciphertext").notNull(),
    submittedBy: text("submitted_by").notNull(),
    expiresAt: text("expires_at").notNull(),
    consumedAt: text("consumed_at"),
    createdAt: timestamp("created_at"),
    updatedAt: timestamp("updated_at"),
  },
  (table) => [
    index("credential_handoffs_purpose_created_idx").on(
      table.purpose,
      table.createdAt,
    ),
    check(
      "credential_handoffs_purpose_check",
      sql`${table.purpose} in ('mailgun_bootstrap')`,
    ),
  ],
);
