ALTER TABLE `account_imports` ADD `request_hash` text;--> statement-breakpoint
ALTER TABLE `compliance_configuration` ADD `cross_border_evidence_ref` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `compliance_configuration` ADD `automated_qualification_evidence_ref` text DEFAULT '' NOT NULL;