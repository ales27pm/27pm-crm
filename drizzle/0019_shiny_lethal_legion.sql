CREATE TABLE `exchange_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`mailbox_id` text NOT NULL,
	`client_id` text NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'disconnected' NOT NULL,
	`credential_version` text,
	`lease_owner` text,
	`lease_expires_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "exchange_connections_singleton_check" CHECK("exchange_connections"."id" = 'alexis'),
	CONSTRAINT "exchange_connections_generation_check" CHECK("exchange_connections"."generation" >= 0 and "exchange_connections"."version" >= 0),
	CONSTRAINT "exchange_connections_status_check" CHECK("exchange_connections"."status" in ('connected', 'disconnected', 'reauth_required')),
	CONSTRAINT "exchange_connections_credential_check" CHECK(("exchange_connections"."status" != 'connected' or "exchange_connections"."credential_version" is not null) and ("exchange_connections"."status" != 'disconnected' or "exchange_connections"."credential_version" is null)),
	CONSTRAINT "exchange_connections_lease_check" CHECK(("exchange_connections"."lease_owner" is null) = ("exchange_connections"."lease_expires_at" is null))
);
--> statement-breakpoint
CREATE TABLE `exchange_oauth_flows` (
	`id` text PRIMARY KEY NOT NULL,
	`connection_id` text NOT NULL,
	`generation` integer NOT NULL,
	`state_hash` text NOT NULL,
	`binder_hash` text NOT NULL,
	`operator_email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `exchange_connections`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "exchange_oauth_flows_generation_check" CHECK("exchange_oauth_flows"."generation" >= 0),
	CONSTRAINT "exchange_oauth_flows_status_check" CHECK("exchange_oauth_flows"."status" in ('pending', 'staging', 'ready', 'consuming', 'completed', 'failed')),
	CONSTRAINT "exchange_oauth_flows_state_hash_check" CHECK(length("exchange_oauth_flows"."state_hash") = 64 and "exchange_oauth_flows"."state_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "exchange_oauth_flows_binder_hash_check" CHECK(length("exchange_oauth_flows"."binder_hash") = 64 and "exchange_oauth_flows"."binder_hash" not glob '*[^0-9a-f]*'),
	CONSTRAINT "exchange_oauth_flows_lifetime_check" CHECK(julianday("exchange_oauth_flows"."expires_at") > julianday("exchange_oauth_flows"."created_at") and julianday("exchange_oauth_flows"."expires_at") <= julianday("exchange_oauth_flows"."created_at", '+5 minutes'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_oauth_flows_state_unique` ON `exchange_oauth_flows` (`state_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `exchange_oauth_flows_active_operator_unique` ON `exchange_oauth_flows` (`operator_email`) WHERE "exchange_oauth_flows"."status" in ('pending', 'staging', 'ready', 'consuming');--> statement-breakpoint
CREATE INDEX `exchange_oauth_flows_expiry_idx` ON `exchange_oauth_flows` (`expires_at`);