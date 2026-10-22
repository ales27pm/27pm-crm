CREATE TABLE `integration_documents` (
	`id` text PRIMARY KEY NOT NULL,
	`deal_id` text NOT NULL,
	`title` text NOT NULL,
	`content` text NOT NULL,
	`media_type` text DEFAULT 'text/markdown' NOT NULL,
	`status` text DEFAULT 'prepared' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "integration_documents_media_type_check" CHECK("integration_documents"."media_type"='text/markdown'),
	CONSTRAINT "integration_documents_status_check" CHECK("integration_documents"."status"='prepared')
);
--> statement-breakpoint
CREATE INDEX `integration_documents_deal_idx` ON `integration_documents` (`deal_id`);--> statement-breakpoint
CREATE TABLE `integration_operations` (
	`id` text PRIMARY KEY NOT NULL,
	`subject` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`request_hash` text NOT NULL,
	`response_json` text NOT NULL,
	`valid` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "integration_operations_valid_check" CHECK("integration_operations"."valid"=1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `integration_operations_subject_key_unique` ON `integration_operations` (`subject`,`idempotency_key`);