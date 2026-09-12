ALTER TABLE `message_events` ADD `sending_domain` text;--> statement-breakpoint
ALTER TABLE `message_events` ADD `recipient_domain` text;--> statement-breakpoint
ALTER TABLE `message_events` ADD `mailbox_provider` text;--> statement-breakpoint
ALTER TABLE `message_events` ADD `sending_ip` text;--> statement-breakpoint
ALTER TABLE `message_events` ADD `failure_class` text;--> statement-breakpoint
ALTER TABLE `message_events` ADD `smtp_code` integer;--> statement-breakpoint
ALTER TABLE `message_events` ADD `enhanced_status_code` text;--> statement-breakpoint
ALTER TABLE `message_events` ADD `smtp_description` text;--> statement-breakpoint
ALTER TABLE `message_events` ADD `attempt_no` integer;--> statement-breakpoint
ALTER TABLE `message_events` ADD `tags_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `message_events` ADD `campaigns_json` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX `message_events_provider_timestamp_idx` ON `message_events` (`mailbox_provider`,`event_timestamp`);--> statement-breakpoint
CREATE INDEX `message_events_ip_timestamp_idx` ON `message_events` (`sending_ip`,`event_timestamp`);--> statement-breakpoint
CREATE INDEX `message_events_failure_timestamp_idx` ON `message_events` (`failure_class`,`event_timestamp`);--> statement-breakpoint
ALTER TABLE `messages` ADD `traffic_type` text DEFAULT 'unclassified' NOT NULL CONSTRAINT `messages_traffic_type_check` CHECK (`traffic_type` in ('unclassified', 'administrative', 'transactional', 'prospecting', 'marketing'));--> statement-breakpoint
ALTER TABLE `messages` ADD `tags_json` text DEFAULT '[]' NOT NULL;
