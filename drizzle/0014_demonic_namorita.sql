ALTER TABLE `message_events` ADD `transport_provider` text DEFAULT 'mailgun' NOT NULL CONSTRAINT `message_events_transport_provider_check` CHECK (`transport_provider` in ('mailgun', 'cakemail'));--> statement-breakpoint
ALTER TABLE `message_events` ADD `provider_message_id` text;--> statement-breakpoint
DROP INDEX `message_events_provider_event_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `message_events_provider_event_unique` ON `message_events` (`transport_provider`,`provider_event_id`);--> statement-breakpoint
CREATE INDEX `message_events_provider_message_idx` ON `message_events` (`transport_provider`,`provider_message_id`,`message_id`);--> statement-breakpoint
ALTER TABLE `send_commands` ADD `transport_provider` text DEFAULT 'mailgun' NOT NULL CONSTRAINT `send_commands_transport_provider_check` CHECK (`transport_provider` in ('mailgun', 'cakemail'));--> statement-breakpoint
ALTER TABLE `send_commands` ADD `external_message_id` text;--> statement-breakpoint
ALTER TABLE `send_commands` ADD `message_snapshot_json` text;--> statement-breakpoint
UPDATE `send_commands` SET `external_message_id` = `provider_message_id` WHERE `external_message_id` IS NULL;--> statement-breakpoint
DROP INDEX `send_commands_provider_message_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `send_commands_provider_message_unique` ON `send_commands` (`transport_provider`,`provider_message_id`);--> statement-breakpoint
ALTER TABLE `messages` ADD `transport_provider` text DEFAULT 'mailgun' NOT NULL CONSTRAINT `messages_transport_provider_check` CHECK (`transport_provider` in ('mailgun', 'cakemail'));--> statement-breakpoint
ALTER TABLE `messages` ADD `provider_message_id` text;--> statement-breakpoint
UPDATE `messages` SET `provider_message_id` = `external_message_id` WHERE `provider_message_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `messages_provider_message_unique` ON `messages` (`transport_provider`,`provider_message_id`);--> statement-breakpoint
ALTER TABLE `webhook_receipts` ADD `transport_provider` text DEFAULT 'mailgun' NOT NULL CONSTRAINT `webhook_receipts_transport_provider_check` CHECK (`transport_provider` in ('mailgun', 'cakemail'));
