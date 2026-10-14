CREATE TABLE `exchange_message_links` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`physical_mailbox_id` text NOT NULL,
	`graph_message_id` text NOT NULL,
	`crm_message_id` text,
	`logical_mailbox_id` text,
	`internet_message_id` text,
	`folder_id` text,
	`classification` text DEFAULT 'unclassified' NOT NULL,
	`message_json` text DEFAULT '{}' NOT NULL,
	`remote_removed` integer DEFAULT false NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `exchange_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`crm_message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`logical_mailbox_id`) REFERENCES `mailboxes`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "exchange_message_links_classification_check" CHECK("exchange_message_links"."classification" in ('unclassified','mapped','ambiguous','external_sent','draft')),
	CONSTRAINT "exchange_message_links_json_check" CHECK(json_valid("exchange_message_links"."message_json") and json_type("exchange_message_links"."message_json") = 'object')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_message_links_scope_unique` ON `exchange_message_links` (`tenant_id`,`physical_mailbox_id`,`graph_message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_message_links_crm_message_unique` ON `exchange_message_links` (`crm_message_id`);--> statement-breakpoint
CREATE INDEX `exchange_message_links_classification_idx` ON `exchange_message_links` (`classification`,`updated_at`);--> statement-breakpoint
CREATE INDEX `exchange_message_links_internet_id_idx` ON `exchange_message_links` (`internet_message_id`);--> statement-breakpoint
CREATE TABLE `exchange_send_state` (
	`command_id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`physical_mailbox_id` text NOT NULL,
	`correlation_id` text NOT NULL,
	`graph_message_id` text,
	`phase` text DEFAULT 'prepared' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`command_id`) REFERENCES `send_commands`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`connection_id`) REFERENCES `exchange_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "exchange_send_state_phase_check" CHECK("exchange_send_state"."phase" in ('prepared','drafted','send_requested','accepted','unknown','manual_review','rejected')),
	CONSTRAINT "exchange_send_state_version_check" CHECK("exchange_send_state"."version" >= 0),
	CONSTRAINT "exchange_send_state_draft_check" CHECK("exchange_send_state"."phase" not in ('drafted','send_requested','accepted') or "exchange_send_state"."graph_message_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_send_state_correlation_unique` ON `exchange_send_state` (`correlation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_send_state_graph_id_unique` ON `exchange_send_state` (`tenant_id`,`physical_mailbox_id`,`graph_message_id`);--> statement-breakpoint
CREATE TABLE `exchange_sync_cursors` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`tenant_id` text NOT NULL,
	`physical_mailbox_id` text NOT NULL,
	`folder_id` text NOT NULL,
	`generation` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`next_link` text,
	`delta_link` text,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `exchange_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "exchange_sync_cursors_version_check" CHECK("exchange_sync_cursors"."generation" >= 0 and "exchange_sync_cursors"."version" >= 0),
	CONSTRAINT "exchange_sync_cursors_pointer_check" CHECK(("exchange_sync_cursors"."next_link" is null) != ("exchange_sync_cursors"."delta_link" is null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_sync_cursors_scope_unique` ON `exchange_sync_cursors` (`tenant_id`,`physical_mailbox_id`,`folder_id`);--> statement-breakpoint
-- Widen the inline provider constraints without rebuilding parent tables.
-- DROP TABLE with foreign keys enabled can cascade-delete attachments or null
-- event links even with deferred foreign keys. Column replacement retains rowids,
-- all unrelated indexes/triggers, children, and sqlite_sequence.
ALTER TABLE `messages` ADD COLUMN `exchange_provider_stage` text DEFAULT 'mailgun' NOT NULL CONSTRAINT `messages_transport_provider_exchange_check` CHECK (`exchange_provider_stage` in ('mailgun','cakemail','exchange'));
--> statement-breakpoint
UPDATE `messages` SET `exchange_provider_stage` = `transport_provider`;
--> statement-breakpoint
DROP INDEX `messages_provider_message_unique`;
--> statement-breakpoint
ALTER TABLE `messages` DROP COLUMN `transport_provider`;
--> statement-breakpoint
ALTER TABLE `messages` RENAME COLUMN `exchange_provider_stage` TO `transport_provider`;
--> statement-breakpoint
CREATE UNIQUE INDEX `messages_provider_message_unique` ON `messages` (`transport_provider`,`provider_message_id`);
--> statement-breakpoint
ALTER TABLE `send_commands` ADD COLUMN `exchange_provider_stage` text DEFAULT 'mailgun' NOT NULL CONSTRAINT `send_commands_transport_provider_exchange_check` CHECK (`exchange_provider_stage` in ('mailgun','cakemail','exchange'));
--> statement-breakpoint
UPDATE `send_commands` SET `exchange_provider_stage` = `transport_provider`;
--> statement-breakpoint
DROP INDEX `send_commands_provider_message_unique`;
--> statement-breakpoint
ALTER TABLE `send_commands` DROP COLUMN `transport_provider`;
--> statement-breakpoint
ALTER TABLE `send_commands` RENAME COLUMN `exchange_provider_stage` TO `transport_provider`;
--> statement-breakpoint
CREATE UNIQUE INDEX `send_commands_provider_message_unique` ON `send_commands` (`transport_provider`,`provider_message_id`);
