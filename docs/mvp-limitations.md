# CRM 27PM — portée et limites vérifiables

## Fonctionnel dans ce dépôt

- fiches d’entreprises indépendantes, contacts vérifiés et opportunités de pipeline;
- cohorte initiale idempotente de cinq entreprises, sans contact personnel;
- score, priorité, enveloppe indicative explicitement marquée comme hypothèse,
  assignation, provenance, prochaine étape et prochaine relance;
- notes, interactions manuelles, journal d’audit et tâches internes ou de contact;
- recherche et filtres de comptes, édition, création et file des demandes publiques;
- blocage des envois et des tâches de contact si le contact ou l’entreprise est
  supprimé, bloqué, désabonné, non validé, sans fondement documenté, sans rôle
  pertinent ou sans courriel confirmé;
- édition et suppression logique des entreprises et contacts; une opposition,
  un désabonnement ou une suppression est irréversible dans l’interface et
  nécessite un nouveau dossier vérifié plutôt qu’une réactivation silencieuse;
- contrôle LNNTE, « ne pas appeler » et statut du courriel enregistrés. Le CRM
  ne passe aucun appel et n’automatise aucune séquence.

Les interactions de type « courriel » sont des notes historiques : elles
n’envoient rien. L’envoi manuel Mailgun préexistant reste réservé aux contacts
qualifiés et n’a pas été utilisé pendant cette mise à niveau.

## Formulaire public

`POST /api/public/intake` est un contrat d’intégration prêt côté CRM. Il exige
une origine exacte, Turnstile, une clé d’idempotence, une limite de débit et un
consentement à la politique de confidentialité. Une demande reste
`pending_review`; elle ne crée jamais automatiquement un contact actionnable.

Le dépôt du site public `27pm.org` n’est pas ce dépôt. Son formulaire actuel
n’a donc pas été modifié ni déclaré connecté. Pour l’intégrer, configurer les
trois variables décrites dans `.env.example`, ajouter Turnstile au formulaire,
envoyer le contrat JSON documenté dans `docs/operations.md`, puis déployer et
tester les deux surfaces. Sans ces opérations, l’API retourne
`intake_not_configured` ou `origin_forbidden`.

## Authentification et opérateurs

Les pages et toutes les routes d’administration reposent sur l’identité
injectée par OpenAI Sites, doublée de `CRM_ADMIN_EMAILS`. Le dépôt ne fournit ni
mot de passe local, ni gestion de rôles, ni invitation d’utilisateur. Le point
d’entrée public ne partage pas cette authentification et ne donne aucun accès
aux données CRM.

## Déploiement et données

Les migrations `0004_flawless_orphan.sql` et `0005_known_naoko.sql` ont été
validées ensemble sur une base SQLite jetable avec contrôle des clés
étrangères. Elles n’ont pas été appliquées à D1 de production et ce worktree
n’a pas été publié. Le binding D1 réel appartient au projet Sites; le
`database_id` du mode local est volontairement un placeholder.

Il n’existe pas de migration destructive de retour arrière automatique. Le
retour arrière sûr est une restauration D1 à un point antérieur ou une
migration corrective en avant, après export. Voir `docs/operations.md`.
