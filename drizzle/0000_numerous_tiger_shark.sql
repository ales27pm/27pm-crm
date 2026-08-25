CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text DEFAULT 'application/octet-stream' NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text,
	`scan_status` text DEFAULT 'unscanned' NOT NULL,
	`scan_detail` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "attachments_scan_status_check" CHECK("attachments"."scan_status" in ('unscanned', 'clean', 'infected', 'rejected')),
	CONSTRAINT "attachments_size_check" CHECK("attachments"."size_bytes" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attachments_r2_key_unique` ON `attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `attachments_message_idx` ON `attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `audit_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_email` text NOT NULL,
	`action` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`details_json` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_entries_entity_created_idx` ON `audit_entries` (`entity_type`,`entity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`organization` text,
	`phone` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_unique` ON `contacts` (`email`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`mailbox_id` text NOT NULL,
	`contact_id` text,
	`subject` text DEFAULT '(Sans objet)' NOT NULL,
	`normalized_subject` text DEFAULT '' NOT NULL,
	`thread_key` text NOT NULL,
	`is_unread` integer DEFAULT true NOT NULL,
	`follow_up_state` text DEFAULT 'none' NOT NULL,
	`follow_up_at` text,
	`last_message_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "conversations_follow_up_state_check" CHECK("conversations"."follow_up_state" in ('none', 'pending', 'waiting', 'done'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_mailbox_thread_unique` ON `conversations` (`mailbox_id`,`thread_key`);--> statement-breakpoint
CREATE INDEX `conversations_mailbox_last_message_idx` ON `conversations` (`mailbox_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_follow_up_idx` ON `conversations` (`follow_up_state`,`follow_up_at`);--> statement-breakpoint
CREATE TABLE `deals` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`stage` text DEFAULT 'new' NOT NULL,
	`project_type` text,
	`next_action` text,
	`next_action_at` text,
	`estimated_value_cents` integer,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "deals_stage_check" CHECK("deals"."stage" in ('new', 'qualified', 'discovery', 'proposal', 'won', 'lost', 'archived')),
	CONSTRAINT "deals_estimated_value_check" CHECK("deals"."estimated_value_cents" is null or "deals"."estimated_value_cents" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `deals_conversation_unique` ON `deals` (`conversation_id`);--> statement-breakpoint
CREATE INDEX `deals_stage_next_action_idx` ON `deals` (`stage`,`next_action_at`);--> statement-breakpoint
CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`address` text NOT NULL,
	`local_part` text NOT NULL,
	`display_name` text NOT NULL,
	`purpose` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "mailboxes_purpose_check" CHECK("mailboxes"."purpose" in ('sales', 'operations'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_address_unique` ON `mailboxes` (`address`);--> statement-breakpoint
CREATE UNIQUE INDEX `mailboxes_local_part_unique` ON `mailboxes` (`local_part`);--> statement-breakpoint
CREATE TABLE `message_events` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text,
	`provider_event_id` text,
	`callback_key` text NOT NULL,
	`event_type` text NOT NULL,
	`severity` text,
	`recipient` text,
	`event_timestamp` text NOT NULL,
	`payload_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_events_provider_event_id_unique` ON `message_events` (`provider_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_events_callback_key_unique` ON `message_events` (`callback_key`);--> statement-breakpoint
CREATE INDEX `message_events_message_timestamp_idx` ON `message_events` (`message_id`,`event_timestamp`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`direction` text NOT NULL,
	`external_message_id` text,
	`provider_storage_key` text,
	`sender` text NOT NULL,
	`recipients_json` text DEFAULT '[]' NOT NULL,
	`cc_json` text DEFAULT '[]' NOT NULL,
	`reply_to` text,
	`subject` text DEFAULT '(Sans objet)' NOT NULL,
	`text_body` text,
	`html_body` text,
	`headers_json` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`occurred_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "messages_direction_check" CHECK("messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_status_check" CHECK("messages"."status" in ('received', 'queued', 'accepted', 'delivered', 'temporary-failure', 'permanent-failure', 'bounced', 'complained'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_external_message_id_unique` ON `messages` (`external_message_id`);--> statement-breakpoint
CREATE INDEX `messages_conversation_occurred_idx` ON `messages` (`conversation_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `send_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`conversation_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`provider_message_id` text,
	`response_status` integer,
	`failure_code` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "send_commands_status_check" CHECK("send_commands"."status" in ('pending', 'sent', 'failed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `send_commands_idempotency_key_unique` ON `send_commands` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `send_commands_provider_message_id_unique` ON `send_commands` (`provider_message_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`deal_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` text,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status_check" CHECK("tasks"."status" in ('open', 'done', 'cancelled')),
	CONSTRAINT "tasks_parent_check" CHECK("tasks"."conversation_id" is not null or "tasks"."deal_id" is not null)
);
--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`status`,`due_at`);--> statement-breakpoint
CREATE TABLE `webhook_receipts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`signature_token` text NOT NULL,
	`signature_timestamp` integer NOT NULL,
	`callback_key` text NOT NULL,
	`received_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "webhook_receipts_kind_check" CHECK("webhook_receipts"."kind" in ('inbound', 'event'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_receipts_signature_token_unique` ON `webhook_receipts` (`signature_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_receipts_callback_key_unique` ON `webhook_receipts` (`callback_key`);--> statement-breakpoint
INSERT OR IGNORE INTO `mailboxes` (`id`, `address`, `local_part`, `display_name`, `purpose`, `is_active`)
VALUES
	('mailbox_bonjour', 'bonjour@27pm.org', 'bonjour', '27PM — Bonjour', 'sales', 1),
	('mailbox_admin', 'admin@27pm.org', 'admin', '27PM — Administration', 'operations', 1);
