CREATE TABLE `mobile_authorization_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`operator_email` text NOT NULL,
	`client_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`scopes` text NOT NULL,
	`device_name` text,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`consumed_session_id` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "mobile_authorization_grants_code_hash_check" CHECK(length("mobile_authorization_grants"."code_hash") = 64 and "mobile_authorization_grants"."code_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "mobile_authorization_grants_challenge_check" CHECK(length("mobile_authorization_grants"."code_challenge") = 43 and "mobile_authorization_grants"."code_challenge" not glob '*[^A-Za-z0-9_-]*'),
	CONSTRAINT "mobile_authorization_grants_scope_check" CHECK("mobile_authorization_grants"."scopes" = 'crm:dashboard:read crm:work')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_authorization_grants_code_hash_unique` ON `mobile_authorization_grants` (`code_hash`);--> statement-breakpoint
CREATE INDEX `mobile_authorization_grants_expiry_idx` ON `mobile_authorization_grants` (`expires_at`);--> statement-breakpoint
CREATE INDEX `mobile_authorization_grants_operator_idx` ON `mobile_authorization_grants` (`operator_email`,`created_at`);--> statement-breakpoint
CREATE TABLE `mobile_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`authorization_grant_id` text NOT NULL,
	`operator_email` text NOT NULL,
	`client_id` text NOT NULL,
	`device_name` text,
	`scopes` text NOT NULL,
	`refresh_token_hash` text NOT NULL,
	`expires_at` text NOT NULL,
	`last_refreshed_at` text NOT NULL,
	`revoked_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`authorization_grant_id`) REFERENCES `mobile_authorization_grants`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "mobile_sessions_refresh_hash_check" CHECK(length("mobile_sessions"."refresh_token_hash") = 64 and "mobile_sessions"."refresh_token_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "mobile_sessions_scope_check" CHECK("mobile_sessions"."scopes" = 'crm:dashboard:read crm:work')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_sessions_grant_unique` ON `mobile_sessions` (`authorization_grant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `mobile_sessions_refresh_hash_unique` ON `mobile_sessions` (`refresh_token_hash`);--> statement-breakpoint
CREATE INDEX `mobile_sessions_operator_idx` ON `mobile_sessions` (`operator_email`,`created_at`);--> statement-breakpoint
CREATE INDEX `mobile_sessions_expiry_idx` ON `mobile_sessions` (`expires_at`,`revoked_at`);