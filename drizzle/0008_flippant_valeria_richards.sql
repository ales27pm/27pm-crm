ALTER TABLE `webhook_receipts` ADD `status` text DEFAULT 'reserved' NOT NULL;--> statement-breakpoint
ALTER TABLE `webhook_receipts` ADD `processed_at` text;--> statement-breakpoint
UPDATE `webhook_receipts` SET `status`='processed', `processed_at`=COALESCE(`received_at`, CURRENT_TIMESTAMP);--> statement-breakpoint
CREATE TRIGGER `webhook_receipts_status_insert_check`
BEFORE INSERT ON `webhook_receipts`
WHEN NEW.status NOT IN ('reserved', 'processed')
BEGIN
  SELECT RAISE(ABORT, 'webhook_receipts_status_check');
END;
--> statement-breakpoint
CREATE TRIGGER `webhook_receipts_status_update_check`
BEFORE UPDATE OF `status` ON `webhook_receipts`
WHEN NEW.status NOT IN ('reserved', 'processed')
BEGIN
  SELECT RAISE(ABORT, 'webhook_receipts_status_check');
END;
