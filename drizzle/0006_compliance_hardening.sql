CREATE TABLE `compliance_configuration` (
	`id` text PRIMARY KEY NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`sender_name` text DEFAULT '' NOT NULL,
	`organization_name` text DEFAULT '' NOT NULL,
	`postal_address` text DEFAULT '' NOT NULL,
	`contact_method` text DEFAULT '' NOT NULL,
	`identity_valid_until` text,
	`unsubscribe_mechanism_validated_at` text,
	`unsubscribe_mechanism_valid_until` text,
	`dncl_registration_confirmed` integer DEFAULT false NOT NULL,
	`dncl_registration_verified_at` text,
	`dncl_registration_evidence_ref` text DEFAULT '' NOT NULL,
	`business_number_confirmed` integer DEFAULT false NOT NULL,
	`business_number` text DEFAULT '' NOT NULL,
	`business_number_evidence_ref` text DEFAULT '' NOT NULL,
	`caller_identity` text DEFAULT '' NOT NULL,
	`caller_display_number` text DEFAULT '' NOT NULL,
	`automated_dialer_disabled` integer DEFAULT true NOT NULL,
	`prerecorded_calls_disabled` integer DEFAULT true NOT NULL,
	`sequential_dialing_disabled` integer DEFAULT true NOT NULL,
	`cross_border_efvp_confirmed` integer DEFAULT false NOT NULL,
	`cross_border_contract_confirmed` integer DEFAULT false NOT NULL,
	`cross_border_legal_validation_confirmed` integer DEFAULT false NOT NULL,
	`automated_qualification_legal_validation_confirmed` integer DEFAULT false NOT NULL,
	`updated_by` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "compliance_configuration_singleton" CHECK("compliance_configuration"."id" = 'default')
);
--> statement-breakpoint
CREATE TABLE `contact_channel_compliance` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`channel` text NOT NULL,
	`address_normalized` text NOT NULL,
	`provenance_type` text DEFAULT 'unknown' NOT NULL,
	`source_url` text,
	`captured_at` text,
	`evidence_ref` text,
	`lawful_basis` text DEFAULT 'none' NOT NULL,
	`basis_verified_by` text,
	`basis_verified_at` text,
	`basis_evidence_ref` text,
	`basis_expires_at` text,
	`publication_by_recipient` integer DEFAULT false NOT NULL,
	`publication_no_restriction` integer DEFAULT false NOT NULL,
	`publication_role_relevance` text DEFAULT '' NOT NULL,
	`direct_disclosure_no_restriction` integer DEFAULT false NOT NULL,
	`b2b_relationship_evidence` text DEFAULT '' NOT NULL,
	`b2b_message_relevance` text DEFAULT '' NOT NULL,
	`dncl_status` text DEFAULT 'not_checked' NOT NULL,
	`dncl_checked_at` text,
	`dncl_evidence_ref` text,
	`recipient_timezone` text,
	`status` text DEFAULT 'unknown' NOT NULL,
	`validated_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "contact_channel_type_check" CHECK("contact_channel_compliance"."channel" in ('email', 'phone')),
	CONSTRAINT "contact_channel_provenance_check" CHECK("contact_channel_compliance"."provenance_type" in ('first_party_inbound', 'recipient_published', 'authorized_publication', 'direct_disclosure', 'existing_relationship', 'third_party', 'unknown')),
	CONSTRAINT "contact_channel_basis_check" CHECK("contact_channel_compliance"."lawful_basis" in ('explicit_consent', 'existing_business_relationship', 'conspicuous_publication', 'direct_disclosure', 'b2b_exemption', 'requested_response', 'none')),
	CONSTRAINT "contact_channel_status_check" CHECK("contact_channel_compliance"."status" in ('unknown', 'valid', 'bounced', 'invalid', 'unsubscribed')),
	CONSTRAINT "contact_channel_dncl_check" CHECK("contact_channel_compliance"."dncl_status" in ('not_checked', 'not_listed', 'listed', 'not_applicable'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_channel_address_unique` ON `contact_channel_compliance` (`channel`,`address_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `contact_channel_contact_unique` ON `contact_channel_compliance` (`contact_id`,`channel`);--> statement-breakpoint
CREATE INDEX `contact_channel_contact_idx` ON `contact_channel_compliance` (`contact_id`);--> statement-breakpoint
CREATE TABLE `contact_suppressions` (
	`id` text PRIMARY KEY NOT NULL,
	`channel` text NOT NULL,
	`address_normalized` text NOT NULL,
	`scope` text DEFAULT 'global' NOT NULL,
	`category` text DEFAULT 'all' NOT NULL,
	`reason` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`requested_at` text NOT NULL,
	`effective_at` text NOT NULL,
	`retain_until` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "contact_suppression_channel_check" CHECK("contact_suppressions"."channel" in ('email', 'phone')),
	CONSTRAINT "contact_suppression_scope_check" CHECK("contact_suppressions"."scope" in ('global', 'category'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contact_suppression_identity_unique` ON `contact_suppressions` (`channel`,`address_normalized`,`scope`,`category`);--> statement-breakpoint
CREATE INDEX `contact_suppression_lookup_idx` ON `contact_suppressions` (`channel`,`address_normalized`);--> statement-breakpoint
CREATE TABLE `privacy_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text,
	`request_type` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`requester_reference` text NOT NULL,
	`requested_at` text NOT NULL,
	`due_at` text,
	`handled_by` text,
	`resolution_note` text DEFAULT '' NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "privacy_requests_type_check" CHECK("privacy_requests"."request_type" in ('access', 'rectification', 'withdrawal', 'destruction', 'structured_export')),
	CONSTRAINT "privacy_requests_status_check" CHECK("privacy_requests"."status" in ('received', 'identity_pending', 'in_progress', 'completed', 'refused'))
);
--> statement-breakpoint
CREATE INDEX `privacy_requests_status_due_idx` ON `privacy_requests` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `__new_send_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`conversation_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`contact_id` text,
	`contact_compliance_version` integer,
	`configuration_version` integer,
	`authorized_at` text,
	`dispatched_at` text,
	`operator_confirmed_at` text,
	`compliance_snapshot_json` text,
	`provider_message_id` text,
	`response_status` integer,
	`failure_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "send_commands_status_check" CHECK("__new_send_commands"."status" in ('pending', 'authorized', 'dispatching', 'sent', 'failed', 'cancelled'))
);
--> statement-breakpoint
INSERT INTO `__new_send_commands`("id", "idempotency_key", "request_hash", "mailbox_id", "conversation_id", "status", "contact_id", "contact_compliance_version", "configuration_version", "authorized_at", "dispatched_at", "operator_confirmed_at", "compliance_snapshot_json", "provider_message_id", "response_status", "failure_code", "created_at", "updated_at") SELECT "id", "idempotency_key", "request_hash", "mailbox_id", "conversation_id", "status", NULL, NULL, NULL, NULL, NULL, NULL, NULL, "provider_message_id", "response_status", "failure_code", "created_at", "updated_at" FROM `send_commands`;--> statement-breakpoint
DROP TABLE `send_commands`;--> statement-breakpoint
ALTER TABLE `__new_send_commands` RENAME TO `send_commands`;--> statement-breakpoint
CREATE UNIQUE INDEX `send_commands_idempotency_key_unique` ON `send_commands` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `send_commands_provider_message_id_unique` ON `send_commands` (`provider_message_id`);--> statement-breakpoint
ALTER TABLE `contacts` ADD `role_relevance_detail` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `personal_data_category` text DEFAULT 'work_contact' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `qualification_mode` text DEFAULT 'manual' NOT NULL;--> statement-breakpoint
ALTER TABLE `contacts` ADD `compliance_version` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE TRIGGER `contacts_personal_data_category_insert_check`
BEFORE INSERT ON `contacts`
WHEN NEW.personal_data_category NOT IN ('work_contact', 'other_personal')
BEGIN
  SELECT RAISE(ABORT, 'contacts_personal_data_category_check');
END;
--> statement-breakpoint
CREATE TRIGGER `contacts_personal_data_category_update_check`
BEFORE UPDATE OF `personal_data_category` ON `contacts`
WHEN NEW.personal_data_category NOT IN ('work_contact', 'other_personal')
BEGIN
  SELECT RAISE(ABORT, 'contacts_personal_data_category_check');
END;
--> statement-breakpoint
CREATE TRIGGER `contacts_qualification_mode_insert_check`
BEFORE INSERT ON `contacts`
WHEN NEW.qualification_mode NOT IN ('manual', 'assisted', 'fully_automated')
BEGIN
  SELECT RAISE(ABORT, 'contacts_qualification_mode_check');
END;
--> statement-breakpoint
CREATE TRIGGER `contacts_qualification_mode_update_check`
BEFORE UPDATE OF `qualification_mode` ON `contacts`
WHEN NEW.qualification_mode NOT IN ('manual', 'assisted', 'fully_automated')
BEGIN
  SELECT RAISE(ABORT, 'contacts_qualification_mode_check');
END;
--> statement-breakpoint
UPDATE contacts SET phone = CASE
  WHEN replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '') LIKE '+%'
    AND substr(replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), 2) NOT GLOB '*[^0-9]*'
    AND length(replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')) BETWEEN 9 AND 16
    THEN replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')
  WHEN replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '') NOT GLOB '*[^0-9]*'
    AND length(replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')) = 10
    THEN '+1' || replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')
  WHEN replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '') NOT GLOB '*[^0-9]*'
    AND length(replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')) = 11
    AND substr(replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), 1, 1) = '1'
    THEN '+' || replace(replace(replace(replace(replace(trim(phone), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')
  ELSE phone END
WHERE phone IS NOT NULL AND trim(phone) <> '';
--> statement-breakpoint
INSERT INTO `compliance_configuration` (`id`) VALUES ('default');
--> statement-breakpoint
INSERT INTO `contact_channel_compliance`
  (`id`, `contact_id`, `channel`, `address_normalized`, `provenance_type`, `source_url`, `captured_at`, `evidence_ref`, `lawful_basis`, `status`, `validated_at`, `dncl_status`, `dncl_checked_at`)
SELECT 'email:' || id, id, 'email', lower(trim(email)), 'unknown', source_url, source_date,
       NULL, 'none', email_status, validated_at, 'not_applicable', NULL
FROM contacts;
--> statement-breakpoint
INSERT INTO `contact_channel_compliance`
  (`id`, `contact_id`, `channel`, `address_normalized`, `provenance_type`, `source_url`, `captured_at`, `evidence_ref`, `lawful_basis`, `status`, `validated_at`, `dncl_status`, `dncl_checked_at`)
SELECT 'phone:' || id, id, 'phone', trim(phone), 'unknown', source_url, source_date,
       NULL, 'none', 'valid', validated_at, dncl_status, dncl_checked_at
FROM contacts
WHERE phone IS NOT NULL AND trim(phone) <> ''
  AND id = (SELECT min(owner.id) FROM contacts owner WHERE trim(owner.phone)=trim(contacts.phone));
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_suppressions`
  (`id`, `channel`, `address_normalized`, `scope`, `category`, `reason`, `evidence_ref`, `requested_at`, `effective_at`, `retain_until`, `created_by`)
SELECT 'legacy-email:' || id, 'email', lower(trim(email)), 'global', 'all',
       CASE WHEN unsubscribed_at IS NOT NULL THEN 'unsubscribe' ELSE 'do_not_contact' END,
       'legacy-contact:' || id, COALESCE(unsubscribed_at, updated_at),
       COALESCE(unsubscribed_at, updated_at), NULL, 'migration:0006'
FROM contacts WHERE unsubscribed_at IS NOT NULL OR do_not_contact = 1 OR deleted_at IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `contact_suppressions`
  (`id`, `channel`, `address_normalized`, `scope`, `category`, `reason`, `evidence_ref`, `requested_at`, `effective_at`, `retain_until`, `created_by`)
SELECT 'legacy-phone:' || id, 'phone', trim(phone), 'global', 'all', 'do_not_call',
       'legacy-contact:' || id, updated_at, updated_at,
       datetime(updated_at, '+3 years', '+14 days'), 'migration:0006'
FROM contacts WHERE phone IS NOT NULL AND trim(phone) <> '' AND (do_not_call = 1 OR do_not_contact = 1 OR deleted_at IS NOT NULL);
--> statement-breakpoint
CREATE TRIGGER `audit_entries_no_update`
BEFORE UPDATE ON `audit_entries`
BEGIN
  SELECT RAISE(ABORT, 'audit_entries_are_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_entries_no_delete`
BEFORE DELETE ON `audit_entries`
BEGIN
  SELECT RAISE(ABORT, 'audit_entries_are_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `contact_suppressions_no_update`
BEFORE UPDATE ON `contact_suppressions`
BEGIN
  SELECT RAISE(ABORT, 'contact_suppressions_are_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `contact_suppressions_no_delete`
BEFORE DELETE ON `contact_suppressions`
BEGIN
  SELECT RAISE(ABORT, 'contact_suppressions_are_immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `contact_channel_reimport_guard`
BEFORE INSERT ON `contact_channel_compliance`
WHEN EXISTS (
  SELECT 1 FROM contact_suppressions suppression
  WHERE suppression.channel = NEW.channel
    AND suppression.address_normalized = NEW.address_normalized
)
BEGIN
  SELECT RAISE(ABORT, 'suppressed_channel_reimport_blocked');
END;
--> statement-breakpoint
CREATE TRIGGER `contact_channel_identity_change_guard`
BEFORE UPDATE OF `address_normalized` ON `contact_channel_compliance`
WHEN NEW.address_normalized <> OLD.address_normalized AND EXISTS (
  SELECT 1 FROM contact_suppressions suppression
  WHERE suppression.channel = NEW.channel
    AND suppression.address_normalized IN (OLD.address_normalized, NEW.address_normalized)
)
BEGIN
  SELECT RAISE(ABORT, 'suppressed_channel_reimport_blocked');
END;
