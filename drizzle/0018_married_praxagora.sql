CREATE TABLE `internal_api_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "internal_api_nonces_format_check" CHECK(length("internal_api_nonces"."nonce") between 22 and 86 and "internal_api_nonces"."nonce" not glob '*[^A-Za-z0-9_-]*')
);
--> statement-breakpoint
CREATE INDEX `internal_api_nonces_expiry_idx` ON `internal_api_nonces` (`expires_at`);