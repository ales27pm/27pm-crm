CREATE TABLE `outreach_strategies` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`contact_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`objective` text NOT NULL,
	`target_name` text,
	`target_role` text NOT NULL,
	`value_proposition` text NOT NULL,
	`opening_angle` text NOT NULL,
	`timing_rationale` text NOT NULL,
	`contact_research_notes` text DEFAULT '' NOT NULL,
	`recommended_start_at` text NOT NULL,
	`recipient_timezone` text DEFAULT 'America/Toronto' NOT NULL,
	`research_source` text DEFAULT '' NOT NULL,
	`research_source_url` text,
	`research_captured_at` text,
	`created_by` text NOT NULL,
	`updated_by` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "outreach_strategies_status_check" CHECK("outreach_strategies"."status" in ('draft', 'ready', 'active', 'paused', 'completed', 'archived'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_strategies_organization_unique` ON `outreach_strategies` (`organization_id`);--> statement-breakpoint
CREATE INDEX `outreach_strategies_status_start_idx` ON `outreach_strategies` (`status`,`recommended_start_at`);--> statement-breakpoint
CREATE TABLE `outreach_steps` (
	`id` text PRIMARY KEY NOT NULL,
	`strategy_id` text NOT NULL,
	`sequence_index` integer NOT NULL,
	`business_day_offset` integer NOT NULL,
	`action_type` text NOT NULL,
	`title` text NOT NULL,
	`purpose` text NOT NULL,
	`requires_contact` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`scheduled_at` text NOT NULL,
	`completed_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`strategy_id`) REFERENCES `outreach_strategies`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "outreach_steps_action_type_check" CHECK("outreach_steps"."action_type" in ('research', 'review', 'email', 'call', 'nurture')),
	CONSTRAINT "outreach_steps_status_check" CHECK("outreach_steps"."status" in ('planned', 'ready', 'blocked', 'done', 'skipped')),
	CONSTRAINT "outreach_steps_offset_check" CHECK("outreach_steps"."business_day_offset" >= -30 and "outreach_steps"."business_day_offset" <= 365)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outreach_steps_strategy_sequence_unique` ON `outreach_steps` (`strategy_id`,`sequence_index`);--> statement-breakpoint
CREATE INDEX `outreach_steps_status_schedule_idx` ON `outreach_steps` (`status`,`scheduled_at`);--> statement-breakpoint
WITH candidates
  (`id`, `email`, `display_name`, `organization`, `phone`, `source`, `organization_id`, `role`,
   `role_relevance_detail`, `personal_data_category`, `qualification_mode`, `source_url`, `source_date`,
   `contact_basis`, `role_relevance`, `dncl_status`, `email_status`) AS (
VALUES
  ('contact-public-shuot-info', 'info@shuot.com', 'Boîte générale S.Huot', 'S.Huot', '+14186810291',
   'Page de contact officielle', 'org-cohort-s-huot', 'Accueil — acheminement vers Christian Matte ou la direction générale',
   'Adresse générique officielle; le décideur ciblé est documenté séparément dans la stratégie.', 'work_contact', 'assisted',
   'https://www.shuot.com/nous-joindre/', '2026-08-30', 'unknown', 'unknown', 'not_checked', 'unknown'),
  ('contact-public-jamec-info', 'info@jamec.ca', 'Boîte générale JAMEC', 'JAMEC', '+14182745525',
   'Page de contact officielle', 'org-cohort-jamec', 'Accueil — acheminement vers Éric Cloutier ou la direction générale',
   'Adresse générique officielle; aucune permission de prospection n’est présumée.', 'work_contact', 'assisted',
   'https://jamec.ca/en/contact/', '2026-08-30', 'unknown', 'unknown', 'not_checked', 'unknown'),
  ('contact-public-jamec-daniel', 'danielb@jamec.ca', 'Daniel Bilodeau', 'JAMEC', NULL,
   'Page carrières officielle JAMEC', 'org-cohort-jamec', 'Contact professionnel JAMEC — rôle actuel à confirmer',
   'Adresse nominative publiée par JAMEC dans un contexte de recrutement; pertinence commerciale et fondement LCAP non établis.', 'work_contact', 'assisted',
   'https://jamec.ca/carrieres/', '2026-08-30',
   'unknown', 'unknown', 'not_checked', 'unknown'),
  ('contact-public-vallee-info', 'info@vallee.ca', 'Boîte générale Vallée', 'Vallée', '+14182688955',
   'Page de contact officielle', 'org-cohort-vallee', 'Accueil — acheminement vers Jean-Daniel Genest ou Benoit Vohl-Darveau',
   'Adresse générique officielle; le rôle exact du destinataire doit être confirmé.', 'work_contact', 'assisted',
   'https://vallee.ca/en/contact/', '2026-08-30', 'unknown', 'unknown', 'not_checked', 'unknown'),
  ('contact-public-pronovost-info', 'info@pronovost.qc.ca', 'Boîte générale Machineries Pronovost', 'Machineries Pronovost', '+14183657551',
   'Brochure officielle 2025', 'org-cohort-pronovost', 'Accueil — acheminement vers Dave Barclay ou Simon Pronovost',
   'Adresse générique officielle; aucun courriel nominatif actuel n’a été trouvé.', 'work_contact', 'assisted',
   'https://pronovost.qc.ca/wp-content/uploads/2025/06/Pronovost_Home-use.pdf', '2026-08-30', 'unknown', 'unknown', 'not_checked', 'unknown'),
  ('contact-public-gii-project', 'projet@groupeinter.com', 'Équipe projets Groupe Inter', 'Groupe Industriel Interprovincial', '+18198684215',
   'Page de contact officielle', 'org-cohort-gii', 'Demandes de projets — acheminement vers Steve Malenfant',
   'Boîte projets officielle; aucune permission de prospection n’est présumée.', 'work_contact', 'assisted',
   'https://groupeinter.com/nous-joindre/', '2026-08-30', 'unknown', 'unknown', 'not_checked', 'unknown')
)
INSERT INTO `contacts`
  (`id`, `email`, `display_name`, `organization`, `phone`, `source`, `organization_id`, `role`,
   `role_relevance_detail`, `personal_data_category`, `qualification_mode`, `source_url`, `source_date`,
   `contact_basis`, `role_relevance`, `dncl_status`, `email_status`)
SELECT candidates.*
FROM candidates
WHERE NOT EXISTS (
  SELECT 1 FROM contacts existing WHERE lower(existing.email)=lower(candidates.email)
)
AND NOT EXISTS (
  SELECT 1 FROM contacts existing WHERE existing.id=candidates.id
);--> statement-breakpoint
WITH candidates(`email`, `organization_id`, `provenance_type`, `publication_by_recipient`) AS (
  VALUES
    ('info@shuot.com', 'org-cohort-s-huot', 'recipient_published', 1),
    ('info@jamec.ca', 'org-cohort-jamec', 'recipient_published', 1),
    ('danielb@jamec.ca', 'org-cohort-jamec', 'recipient_published', 1),
    ('info@vallee.ca', 'org-cohort-vallee', 'recipient_published', 1),
    ('info@pronovost.qc.ca', 'org-cohort-pronovost', 'recipient_published', 1),
    ('projet@groupeinter.com', 'org-cohort-gii', 'recipient_published', 1)
)
INSERT INTO `contact_channel_compliance`
  (`id`, `contact_id`, `channel`, `address_normalized`, `provenance_type`, `source_url`, `captured_at`,
   `evidence_ref`, `lawful_basis`, `publication_by_recipient`, `publication_no_restriction`,
   `publication_role_relevance`, `dncl_status`, `status`)
SELECT
  'email:' || contact.id,
  contact.id,
  'email',
  lower(contact.email),
  candidates.provenance_type,
  contact.source_url,
  '2026-08-30T16:00:00.000Z',
  'Recherche publique vérifiée le 2026-08-30; copie de la source à conserver avant toute action.',
  'none',
  candidates.publication_by_recipient,
  0,
  'Pertinence et absence de restriction à confirmer manuellement avant tout courriel.',
  'not_applicable',
  'unknown'
FROM candidates
JOIN `contacts` contact
  ON lower(contact.email)=lower(candidates.email)
  AND contact.organization_id=candidates.organization_id
  AND contact.deleted_at IS NULL
WHERE NOT EXISTS (
  SELECT 1 FROM contact_channel_compliance existing
  WHERE existing.channel='email' AND existing.address_normalized=lower(contact.email)
)
AND NOT EXISTS (
  SELECT 1 FROM contact_channel_compliance existing
  WHERE existing.id='email:' || contact.id
)
AND NOT EXISTS (
  SELECT 1 FROM contact_suppressions suppression
  WHERE suppression.channel='email' AND suppression.address_normalized=lower(contact.email)
);--> statement-breakpoint
WITH strategy_seed
  (`id`, `organization_id`, `contact_email`, `status`, `objective`, `target_name`, `target_role`,
   `value_proposition`, `opening_angle`, `timing_rationale`, `contact_research_notes`,
   `recommended_start_at`, `recipient_timezone`, `research_source`, `research_source_url`,
   `research_captured_at`, `created_by`, `updated_by`) AS (
VALUES
  ('strategy-cohort-shuot', 'org-cohort-s-huot', 'info@shuot.com', 'draft',
   'Obtenir une courte discussion sur une refonte qui reflète l’envergure industrielle réelle de S.Huot.',
   'Christian Matte ou la direction générale', 'Direction financière, présidence ou direction ventes et marketing',
   'Audit ciblé et aperçu de page d’accueil reliant capacités, secteurs et projets.',
   'Le site ne raconte pas la même histoire que l’usine et ses capacités industrielles.',
   'Commencer en premier pendant que la fonction ventes et marketing est en renforcement.',
   'Route publique: info@shuot.com. Une ancienne adresse technique nominative existe dans une source 2024, mais n’est pas importée ni considérée envoyable sans reconfirmation.',
   '2026-09-02T13:30:00.000Z', 'America/Toronto', 'Document utilisateur et pages publiques officielles',
   'https://www.shuot.com/nous-joindre/', '2026-08-30T16:00:00.000Z', 'import:27pm-research', 'import:27pm-research'),
  ('strategy-cohort-jamec', 'org-cohort-jamec', 'info@jamec.ca', 'draft',
   'Positionner 27PM comme partenaire pour transformer le catalogue technique en parcours commercial.',
   'Éric Cloutier (représentant légal); Daniel Bilodeau (rôle à confirmer)', 'Direction générale, ventes ou développement des affaires',
   'Architecture par problème d’usine, contenu produit plus démonstratif et demandes de discussion mieux qualifiées.',
   'Transformer le site en vendeur technique numérique plutôt qu’en long arbre de machines.',
   'Initier avant le Timber Processing & Energy Expo du 23 au 25 septembre 2026.',
   'info@jamec.ca est officiel. danielb@jamec.ca est publié sur la page carrières de JAMEC, mais son rôle actuel et sa pertinence commerciale restent à confirmer; le canal demeure bloqué.',
   '2026-09-03T13:30:00.000Z', 'America/Toronto', 'Document utilisateur et pages publiques officielles JAMEC',
   'https://jamec.ca/en/contact/', '2026-08-30T16:00:00.000Z', 'import:27pm-research', 'import:27pm-research'),
  ('strategy-cohort-vallee', 'org-cohort-vallee', 'info@vallee.ca', 'draft',
   'Décrocher une discussion sur une seconde génération du site, sans dénigrer l’existant.',
   'Jean-Daniel Genest ou Benoit Vohl-Darveau', 'Direction générale, ventes, marketing ou développement commercial',
   'Sélection guidée, meilleure hiérarchie des gammes et expérience de soumission nord-américaine.',
   'Faire du lancement 4DA5E et des 70 ans le point d’entrée d’une expérience plus moderne.',
   'Passer après les apprentissages de S.Huot et JAMEC; utiliser les signaux produit 2026.',
   'Route publique: info@vallee.ca. Aucun courriel nominatif actuel trouvé; demander explicitement l’acheminement vers la direction ciblée.',
   '2026-09-16T13:30:00.000Z', 'America/Toronto', 'Document utilisateur et page de contact officielle',
   'https://vallee.ca/en/contact/', '2026-08-30T16:00:00.000Z', 'import:27pm-research', 'import:27pm-research'),
  ('strategy-cohort-pronovost', 'org-cohort-pronovost', 'info@pronovost.qc.ca', 'draft',
   'Proposer une refonte qui conserve la richesse fonctionnelle tout en simplifiant la sélection.',
   'Dave Barclay ou Simon Pronovost', 'Direction générale ou direction des ventes',
   'Parcours distincts pour propriétaires, professionnels, travaux publics, agriculture et concessionnaires.',
   'Conserver la puissance du catalogue tout en rendant la sélection beaucoup plus simple et visuelle.',
   'Approcher après validation des premiers messages; projet à plus gros périmètre et cycle potentiellement plus long.',
   'Route publique: info@pronovost.qc.ca. Les noms de la direction sont officiels, mais aucun courriel nominatif actuel n’est publié.',
   '2026-09-23T13:30:00.000Z', 'America/Toronto', 'Document utilisateur, équipe et brochure officielles',
   'https://pronovost.qc.ca/fr/equipe/', '2026-08-30T16:00:00.000Z', 'import:27pm-research', 'import:27pm-research'),
  ('strategy-cohort-gii', 'org-cohort-gii', 'projet@groupeinter.com', 'draft',
   'Obtenir une discussion directe sur une présence corporate crédible Canada–États-Unis.',
   'Steve Malenfant', 'Présidence, direction générale ou développement des affaires',
   'Site corporate axé réalisations, secteurs, capacités, sécurité et appels à projet.',
   'Faire correspondre l’image Web à l’ampleur des projets industriels interprovinciaux et américains.',
   'Cinquième vague: ticket plus petit, mais accès direct à la direction et proposition facile à expliquer.',
   'Route publique recommandée: projet@groupeinter.com. Une adresse nominative plus ancienne existe dans une source 2024, mais n’est pas importée sans reconfirmation.',
   '2026-09-30T13:30:00.000Z', 'America/Toronto', 'Document utilisateur et pages publiques officielles',
   'https://groupeinter.com/nous-joindre/', '2026-08-30T16:00:00.000Z', 'import:27pm-research', 'import:27pm-research')
)
INSERT INTO `outreach_strategies`
  (`id`, `organization_id`, `contact_id`, `status`, `objective`, `target_name`, `target_role`,
   `value_proposition`, `opening_angle`, `timing_rationale`, `contact_research_notes`,
   `recommended_start_at`, `recipient_timezone`, `research_source`, `research_source_url`,
   `research_captured_at`, `created_by`, `updated_by`)
SELECT strategy_seed.id, strategy_seed.organization_id, contact.id, strategy_seed.status,
  strategy_seed.objective, strategy_seed.target_name, strategy_seed.target_role,
  strategy_seed.value_proposition, strategy_seed.opening_angle, strategy_seed.timing_rationale,
  strategy_seed.contact_research_notes, strategy_seed.recommended_start_at,
  strategy_seed.recipient_timezone, strategy_seed.research_source,
  strategy_seed.research_source_url, strategy_seed.research_captured_at,
  strategy_seed.created_by, strategy_seed.updated_by
FROM strategy_seed
LEFT JOIN contacts contact
  ON contact.organization_id=strategy_seed.organization_id
  AND lower(contact.email)=lower(strategy_seed.contact_email)
  AND contact.deleted_at IS NULL;--> statement-breakpoint
WITH cadence(sequence_index, business_day_offset, action_type, title, purpose, requires_contact) AS (
  VALUES
    (0, -2, 'research', 'Finaliser l’audit du compte', 'Confirmer les constats publics et préparer une valeur concrète à montrer.', 0),
    (1, -1, 'review', 'Vérifier le décideur et la conformité', 'Confirmer le rôle, la provenance, la pertinence et le fondement avant tout contact.', 0),
    (2, 0, 'email', 'Premier courriel personnalisé', 'Présenter un seul angle précis et demander la permission d’envoyer l’audit ou la maquette.', 1),
    (3, 5, 'email', 'Première relance utile', 'Ajouter un constat ou un aperçu nouveau, sans répéter le premier message.', 1),
    (4, 12, 'email', 'Dernière relance', 'Poser une dernière question simple et annoncer clairement la fin de la séquence.', 1),
    (5, 13, 'nurture', 'Clore ou mettre en veille', 'Fermer la séquence sans réponse ou planifier une nouvelle vérification sur signal concret.', 0)
)
INSERT INTO `outreach_steps`
  (`id`, `strategy_id`, `sequence_index`, `business_day_offset`, `action_type`, `title`, `purpose`,
   `requires_contact`, `status`, `scheduled_at`)
SELECT
  strategy.id || '-step-' || printf('%02d', cadence.sequence_index),
  strategy.id,
  cadence.sequence_index,
  cadence.business_day_offset,
  cadence.action_type,
  cadence.title,
  cadence.purpose,
  cadence.requires_contact,
  CASE WHEN cadence.requires_contact=1 THEN 'blocked' ELSE 'planned' END,
  strftime('%Y-%m-%dT%H:%M:%fZ', strategy.recommended_start_at,
    CASE
      WHEN cadence.business_day_offset=-2 THEN '-2 days'
      WHEN cadence.business_day_offset=-1 THEN '-1 day'
      WHEN cadence.business_day_offset=0 THEN '+0 days'
      WHEN cadence.business_day_offset=5 THEN '+7 days'
      WHEN cadence.business_day_offset=12 AND strategy.id='strategy-cohort-jamec' THEN '+18 days'
      WHEN cadence.business_day_offset=12 THEN '+16 days'
      WHEN cadence.business_day_offset=13 AND strategy.id='strategy-cohort-jamec' THEN '+19 days'
      WHEN cadence.business_day_offset=13 THEN '+19 days'
    END)
FROM `outreach_strategies` strategy
CROSS JOIN cadence
WHERE strategy.id LIKE 'strategy-cohort-%';
