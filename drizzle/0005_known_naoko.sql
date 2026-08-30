CREATE TABLE `intake_rate_limits` (
	`bucket_key` text PRIMARY KEY NOT NULL,
	`requester_hash` text NOT NULL,
	`count` integer DEFAULT 1 NOT NULL,
	`expires_at` text NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "intake_rate_limits_count_check" CHECK("intake_rate_limits"."count" > 0 and "intake_rate_limits"."count" <= 5)
);
--> statement-breakpoint
CREATE INDEX `intake_rate_limits_expiry_idx` ON `intake_rate_limits` (`expires_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text,
	`deal_id` text,
	`title` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`due_at` text,
	`completed_at` text,
	`contact_action` integer DEFAULT true NOT NULL,
	`contact_channel` text DEFAULT 'internal' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tasks_status_check" CHECK("__new_tasks"."status" in ('open', 'done', 'cancelled')),
	CONSTRAINT "tasks_parent_check" CHECK("__new_tasks"."conversation_id" is not null or "__new_tasks"."deal_id" is not null),
	CONSTRAINT "tasks_contact_channel_check" CHECK("__new_tasks"."contact_channel" in ('internal', 'email', 'phone'))
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "conversation_id", "deal_id", "title", "status", "due_at", "completed_at", "contact_action", "contact_channel", "created_at", "updated_at") SELECT "id", "conversation_id", "deal_id", "title", "status", "due_at", "completed_at", "contact_action", CASE WHEN "contact_action" = 1 THEN 'email' ELSE 'internal' END, "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tasks_status_due_idx` ON `tasks` (`status`,`due_at`);
