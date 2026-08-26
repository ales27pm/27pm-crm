CREATE TABLE `credential_handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`key_fingerprint` text NOT NULL,
	`ciphertext` text NOT NULL,
	`submitted_by` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "credential_handoffs_purpose_check" CHECK("credential_handoffs"."purpose" in ('mailgun_bootstrap'))
);
--> statement-breakpoint
CREATE INDEX `credential_handoffs_purpose_created_idx` ON `credential_handoffs` (`purpose`,`created_at`);