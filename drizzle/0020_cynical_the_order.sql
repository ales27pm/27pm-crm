CREATE TABLE `exchange_credential_cleanup` (
	`credential_version` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "exchange_credential_cleanup_version_check" CHECK(length("exchange_credential_cleanup"."credential_version") = 36 and "exchange_credential_cleanup"."credential_version" not glob '*[^0-9a-f-]*')
);
--> statement-breakpoint
CREATE INDEX `exchange_credential_cleanup_created_idx` ON `exchange_credential_cleanup` (`created_at`);
--> statement-breakpoint
-- Keep cleanup durable in the SAME transaction as token rotation/disconnection.
-- Trigger DDL is maintained here because Drizzle's SQLite schema has no trigger API.
CREATE TRIGGER `exchange_connections_queue_old_credential`
AFTER UPDATE OF `credential_version` ON `exchange_connections`
WHEN OLD.`credential_version` IS NOT NULL
  AND NEW.`credential_version` IS NOT OLD.`credential_version`
BEGIN
  INSERT INTO `exchange_credential_cleanup` (`credential_version`)
  VALUES (OLD.`credential_version`)
  ON CONFLICT (`credential_version`) DO NOTHING;
END;
