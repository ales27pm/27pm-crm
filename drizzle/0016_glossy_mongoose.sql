CREATE TABLE `mobile_refresh_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`issued_at` text NOT NULL,
	`rotated_at` text,
	FOREIGN KEY (`session_id`) REFERENCES `mobile_sessions`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "mobile_refresh_tokens_hash_check" CHECK(length("mobile_refresh_tokens"."token_hash") = 64 and "mobile_refresh_tokens"."token_hash" not glob '*[^0-9a-f]*')
);
--> statement-breakpoint
CREATE INDEX `mobile_refresh_tokens_session_idx` ON `mobile_refresh_tokens` (`session_id`,`issued_at`);