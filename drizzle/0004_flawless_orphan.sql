CREATE TABLE `account_imports` (
	`id` text PRIMARY KEY NOT NULL,
	`import_key` text NOT NULL,
	`source_label` text NOT NULL,
	`source_url` text,
	`source_date` text,
	`record_count` integer NOT NULL,
	`actor_email` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_imports_key_unique` ON `account_imports` (`import_key`);--> statement-breakpoint
CREATE TABLE `intake_submissions` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`requester_hash` text NOT NULL,
	`origin` text NOT NULL,
	`organization_name` text NOT NULL,
	`contact_name` text NOT NULL,
	`contact_email` text NOT NULL,
	`project_type` text,
	`message` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reviewed_by` text,
	`reviewed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "intake_submissions_status_check" CHECK("intake_submissions"."status" in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `intake_submissions_idempotency_unique` ON `intake_submissions` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `intake_submissions_rate_idx` ON `intake_submissions` (`requester_hash`,`created_at`);--> statement-breakpoint
CREATE INDEX `intake_submissions_status_created_idx` ON `intake_submissions` (`status`,`created_at`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`external_key` text NOT NULL,
	`name` text NOT NULL,
	`website` text,
	`source_label` text NOT NULL,
	`source_url` text,
	`source_date` text,
	`score` integer,
	`priority` text DEFAULT 'normal' NOT NULL,
	`budget_min_cents` integer,
	`budget_max_cents` integer,
	`budget_is_hypothesis` integer DEFAULT true NOT NULL,
	`owner_email` text,
	`do_not_contact` integer DEFAULT false NOT NULL,
	`last_contact_at` text,
	`next_follow_up_at` text,
	`next_step` text,
	`notes` text DEFAULT '' NOT NULL,
	`sort_order` integer DEFAULT 1000 NOT NULL,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	CONSTRAINT "organizations_score_check" CHECK("organizations"."score" is null or ("organizations"."score" >= 0 and "organizations"."score" <= 100)),
	CONSTRAINT "organizations_priority_check" CHECK("organizations"."priority" in ('very_high', 'high', 'normal', 'low')),
	CONSTRAINT "organizations_budget_check" CHECK(("organizations"."budget_min_cents" is null or "organizations"."budget_min_cents" >= 0)
          and ("organizations"."budget_max_cents" is null or "organizations"."budget_max_cents" >= 0)
          and ("organizations"."budget_min_cents" is null or "organizations"."budget_max_cents" is null
               or "organizations"."budget_max_cents" >= "organizations"."budget_min_cents"))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_external_key_unique` ON `organizations` (`external_key`);--> statement-breakpoint
CREATE INDEX `organizations_score_priority_idx` ON `organizations` (`score`,`priority`);--> statement-breakpoint
CREATE INDEX `organizations_follow_up_idx` ON `organizations` (`do_not_contact`,`next_follow_up_at`);--> statement-breakpoint
INSERT OR IGNORE INTO `organizations`
  (`id`, `external_key`, `name`, `source_label`, `priority`, `sort_order`)
SELECT
  'legacy-org-' || lower(hex(lower(trim(`organization`)))),
  'legacy:' || lower(hex(lower(trim(`organization`)))),
  trim(`organization`),
  'Données CRM antérieures',
  'normal',
  900
FROM `contacts`
WHERE `organization` IS NOT NULL AND trim(`organization`) <> ''
GROUP BY lower(trim(`organization`));--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_interactions` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text,
	`contact_id` text,
	`deal_id` text,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`occurred_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`deal_id`) REFERENCES `deals`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "interactions_parent_check" CHECK("__new_interactions"."organization_id" is not null or "__new_interactions"."contact_id" is not null),
	CONSTRAINT "interactions_kind_check" CHECK("__new_interactions"."kind" in ('call', 'email', 'meeting', 'note', 'other'))
);
--> statement-breakpoint
INSERT INTO `__new_interactions`
  ("id", "organization_id", "contact_id", "deal_id", "kind", "summary", "occurred_at", "created_by", "created_at")
SELECT
  i."id",
  (SELECT 'legacy-org-' || lower(hex(lower(trim(c."organization"))))
     FROM `contacts` c WHERE c."id" = i."contact_id"
       AND c."organization" IS NOT NULL AND trim(c."organization") <> ''),
  i."contact_id", i."deal_id", i."kind", i."summary", i."occurred_at",
  i."created_by", i."created_at"
FROM `interactions` i;--> statement-breakpoint
DROP TABLE `interactions`;--> statement-breakpoint
ALTER TABLE `__new_interactions` RENAME TO `interactions`;--> statement-breakpoint
CREATE INDEX `interactions_contact_occurred_idx` ON `interactions` (`contact_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `interactions_deal_occurred_idx` ON `interactions` (`deal_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `interactions_organization_occurred_idx` ON `interactions` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `__new_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`display_name` text,
	`organization` text,
	`phone` text,
	`source` text DEFAULT 'Courriel' NOT NULL,
	`organization_id` text,
	`role` text,
	`source_url` text,
	`source_date` text,
	`contact_basis` text DEFAULT 'unknown' NOT NULL,
	`role_relevance` text DEFAULT 'unknown' NOT NULL,
	`dncl_status` text DEFAULT 'not_checked' NOT NULL,
	`dncl_checked_at` text,
	`email_status` text DEFAULT 'unknown' NOT NULL,
	`unsubscribed_at` text,
	`do_not_call` integer DEFAULT false NOT NULL,
	`do_not_contact` integer DEFAULT false NOT NULL,
	`last_contact_at` text,
	`next_follow_up_at` text,
	`validated_at` text,
	`deleted_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "contacts_basis_check" CHECK("__new_contacts"."contact_basis" in ('unknown', 'inbound_request', 'explicit_consent', 'legitimate_interest', 'existing_client')),
	CONSTRAINT "contacts_role_relevance_check" CHECK("__new_contacts"."role_relevance" in ('unknown', 'relevant', 'not_relevant')),
	CONSTRAINT "contacts_dncl_status_check" CHECK("__new_contacts"."dncl_status" in ('not_checked', 'not_listed', 'listed', 'not_applicable')),
	CONSTRAINT "contacts_email_status_check" CHECK("__new_contacts"."email_status" in ('unknown', 'valid', 'bounced', 'invalid', 'unsubscribed'))
);
--> statement-breakpoint
INSERT INTO `__new_contacts`
  ("id", "email", "display_name", "organization", "phone", "source",
   "organization_id", "contact_basis", "created_at", "updated_at")
SELECT
  "id", "email", "display_name", "organization", "phone", "source",
  CASE WHEN "organization" IS NOT NULL AND trim("organization") <> ''
    THEN 'legacy-org-' || lower(hex(lower(trim("organization")))) ELSE NULL END,
  CASE WHEN "source" = 'Courriel' THEN 'inbound_request' ELSE 'unknown' END,
  "created_at", "updated_at"
FROM `contacts`;--> statement-breakpoint
DROP TABLE `contacts`;--> statement-breakpoint
ALTER TABLE `__new_contacts` RENAME TO `contacts`;--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_email_unique` ON `contacts` (`email`);--> statement-breakpoint
CREATE INDEX `contacts_organization_idx` ON `contacts` (`organization_id`);--> statement-breakpoint
CREATE INDEX `contacts_contactability_idx` ON `contacts` (`do_not_contact`,`unsubscribed_at`,`deleted_at`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `deals` ADD `organization_id` text REFERENCES organizations(id);--> statement-breakpoint
ALTER TABLE `deals` ADD `contact_id` text REFERENCES contacts(id);--> statement-breakpoint
UPDATE `deals`
SET `contact_id` = (
      SELECT c.`contact_id` FROM `conversations` c
      WHERE c.`id` = `deals`.`conversation_id`
    ),
    `organization_id` = (
      SELECT contact.`organization_id`
      FROM `conversations` c
      JOIN `contacts` contact ON contact.`id` = c.`contact_id`
      WHERE c.`id` = `deals`.`conversation_id`
    );--> statement-breakpoint
ALTER TABLE `tasks` ADD `contact_action` integer DEFAULT true NOT NULL;--> statement-breakpoint
INSERT OR IGNORE INTO `organizations`
  (`id`, `external_key`, `name`, `source_label`, `score`, `priority`,
   `budget_min_cents`, `budget_max_cents`, `budget_is_hypothesis`,
   `next_step`, `notes`, `sort_order`)
VALUES
  ('org-cohort-s-huot', 'initial-cohort:s-huot', 'S.Huot',
   'Document utilisateur — cohorte initiale', 96, 'very_high', 2000000, 3500000, 1,
   'Valider le compte et identifier un rôle professionnel pertinent',
   'Hypothèse de prospection à valider; enveloppe indicative non confirmée.', 1),
  ('org-cohort-jamec', 'initial-cohort:jamec', 'JAMEC',
   'Document utilisateur — cohorte initiale', 94, 'very_high', 2500000, 4000000, 1,
   'Valider le compte et identifier un rôle professionnel pertinent',
   'Hypothèse de prospection à valider; enveloppe indicative non confirmée.', 2),
  ('org-cohort-vallee', 'initial-cohort:vallee', 'Vallée',
   'Document utilisateur — cohorte initiale', 92, 'high', 2500000, 4000000, 1,
   'Valider le compte et identifier un rôle professionnel pertinent',
   'Hypothèse de prospection à valider; enveloppe indicative non confirmée.', 3),
  ('org-cohort-pronovost', 'initial-cohort:machineries-pronovost', 'Machineries Pronovost',
   'Document utilisateur — cohorte initiale', 89, 'high', 3000000, 5000000, 1,
   'Valider le compte et identifier un rôle professionnel pertinent',
   'Hypothèse de prospection à valider; enveloppe indicative non confirmée.', 4),
  ('org-cohort-gii', 'initial-cohort:groupe-industriel-interprovincial', 'Groupe Industriel Interprovincial',
   'Document utilisateur — cohorte initiale', 83, 'high', 1200000, 2200000, 1,
   'Valider le compte et identifier un rôle professionnel pertinent',
   'Hypothèse de prospection à valider; ticket indicatif inférieur et non confirmé.', 5);--> statement-breakpoint
INSERT OR IGNORE INTO `conversations`
  (`id`, `mailbox_id`, `contact_id`, `subject`, `normalized_subject`,
   `thread_key`, `is_unread`, `follow_up_state`, `last_message_at`)
VALUES
  ('conversation-cohort-s-huot', 'mailbox_bonjour', NULL, 'S.Huot', 's.huot', 'account:initial-cohort:s-huot', 0, 'none', CURRENT_TIMESTAMP),
  ('conversation-cohort-jamec', 'mailbox_bonjour', NULL, 'JAMEC', 'jamec', 'account:initial-cohort:jamec', 0, 'none', CURRENT_TIMESTAMP),
  ('conversation-cohort-vallee', 'mailbox_bonjour', NULL, 'Vallée', 'vallée', 'account:initial-cohort:vallee', 0, 'none', CURRENT_TIMESTAMP),
  ('conversation-cohort-pronovost', 'mailbox_bonjour', NULL, 'Machineries Pronovost', 'machineries pronovost', 'account:initial-cohort:machineries-pronovost', 0, 'none', CURRENT_TIMESTAMP),
  ('conversation-cohort-gii', 'mailbox_bonjour', NULL, 'Groupe Industriel Interprovincial', 'groupe industriel interprovincial', 'account:initial-cohort:groupe-industriel-interprovincial', 0, 'none', CURRENT_TIMESTAMP);--> statement-breakpoint
INSERT OR IGNORE INTO `deals`
  (`id`, `conversation_id`, `organization_id`, `contact_id`, `stage`,
   `next_action`, `note`)
VALUES
  ('deal-cohort-s-huot', 'conversation-cohort-s-huot', 'org-cohort-s-huot', NULL, 'new', 'Valider les données publiques du compte', 'Aucun contact personnel préchargé.'),
  ('deal-cohort-jamec', 'conversation-cohort-jamec', 'org-cohort-jamec', NULL, 'new', 'Valider les données publiques du compte', 'Aucun contact personnel préchargé.'),
  ('deal-cohort-vallee', 'conversation-cohort-vallee', 'org-cohort-vallee', NULL, 'new', 'Valider les données publiques du compte', 'Aucun contact personnel préchargé.'),
  ('deal-cohort-pronovost', 'conversation-cohort-pronovost', 'org-cohort-pronovost', NULL, 'new', 'Valider les données publiques du compte', 'Aucun contact personnel préchargé.'),
  ('deal-cohort-gii', 'conversation-cohort-gii', 'org-cohort-gii', NULL, 'new', 'Valider les données publiques du compte', 'Aucun contact personnel préchargé.');--> statement-breakpoint
INSERT OR IGNORE INTO `tasks`
  (`id`, `conversation_id`, `deal_id`, `title`, `status`, `due_at`, `contact_action`)
VALUES
  ('task-cohort-s-huot', 'conversation-cohort-s-huot', 'deal-cohort-s-huot', 'Valider les données publiques de S.Huot', 'open', NULL, 0),
  ('task-cohort-jamec', 'conversation-cohort-jamec', 'deal-cohort-jamec', 'Valider les données publiques de JAMEC', 'open', NULL, 0),
  ('task-cohort-vallee', 'conversation-cohort-vallee', 'deal-cohort-vallee', 'Valider les données publiques de Vallée', 'open', NULL, 0),
  ('task-cohort-pronovost', 'conversation-cohort-pronovost', 'deal-cohort-pronovost', 'Valider les données publiques de Machineries Pronovost', 'open', NULL, 0),
  ('task-cohort-gii', 'conversation-cohort-gii', 'deal-cohort-gii', 'Valider les données publiques de Groupe Industriel Interprovincial', 'open', NULL, 0);--> statement-breakpoint
INSERT OR IGNORE INTO `account_imports`
  (`id`, `import_key`, `source_label`, `source_url`, `source_date`,
   `record_count`, `actor_email`)
VALUES
  ('import-initial-cohort-v1', 'initial-cohort:v1',
   'Document utilisateur — cohorte initiale', NULL, NULL, 5, 'system:migration');
