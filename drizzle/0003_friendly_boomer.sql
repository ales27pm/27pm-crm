CREATE TABLE `interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`contact_id` text NOT NULL,
	`deal_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interactions_kind_check" CHECK("interactions"."kind" in ('call', 'email', 'meeting', 'note', 'other'))
);
--> statement-breakpoint
CREATE INDEX `interactions_contact_occurred_idx` ON `interactions` (`contact_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `interactions_deal_occurred_idx` ON `interactions` (`deal_id`,`occurred_at`);--> statement-breakpoint
ALTER TABLE `contacts` ADD `source` text DEFAULT 'Courriel' NOT NULL;