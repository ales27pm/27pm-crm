CREATE TABLE `mobile_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`file_name` text NOT NULL,
	`content_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`created_by` text NOT NULL,
	`deleted_at` text,
	CONSTRAINT "mobile_attachments_owner_check" CHECK("mobile_attachments"."owner_kind" in ('account', 'deal', 'conversation')),
	CONSTRAINT "mobile_attachments_size_check" CHECK("mobile_attachments"."byte_size" > 0 and "mobile_attachments"."byte_size" <= 20971520)
);
--> statement-breakpoint
CREATE INDEX `mobile_attachments_owner_idx` ON `mobile_attachments` (`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_attachments_active_dedup_unique` ON `mobile_attachments` (`owner_kind`,`owner_id`,`sha256`) WHERE "mobile_attachments"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_attachments_storage_unique` ON `mobile_attachments` (`storage_key`);--> statement-breakpoint
ALTER TABLE `organizations` ADD `address` text;--> statement-breakpoint
ALTER TABLE `organizations` ADD `city` text;