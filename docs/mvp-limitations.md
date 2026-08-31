# CRM 27PM — portée et limites vérifiables

## Fonctionnel dans ce dépôt

- fiches d’entreprises indépendantes, contacts sourcés et opportunités de pipeline;
- cohorte initiale de cinq entreprises, avec six routes professionnelles
  publiques conservées en état non vérifié et bloqué;
- score, priorité, enveloppe indicative explicitement marquée comme hypothèse,
  assignation, provenance, prochaine étape et prochaine relance;
- notes, interactions manuelles, journal d’audit, tâches internes ou de contact,
  plans d’approche datés et séquences de trois courriels au maximum;
- recherche et filtres de comptes, édition, création et file des demandes publiques;
- preuve distincte par canal et adresse, moteur serveur unique pour courriel et
  appel, motifs lisibles et revalidation atomique au moment d’une action;
- blocage des envois et tâches de contact si une preuve, un fondement, une
  échéance, la pertinence du rôle, l’identité de 27PM, l’exclusion, la LNNTE ou
  un contrôle de transfert requis manque;
- édition et suppression logique des entreprises et contacts; une opposition,
  un désabonnement ou une suppression est irréversible dans l’interface et
  nécessite un nouveau dossier vérifié plutôt qu’une réactivation silencieuse;
- contrôle LNNTE, « ne pas appeler » et statut du courriel enregistrés. Le CRM
  ne passe aucun appel et n’exécute automatiquement aucune séquence.

Les interactions de type « courriel » sont des notes historiques : elles
n’envoient rien. L’envoi manuel Mailgun exige un destinataire, une confirmation
opérateur, une décision conforme et un pied de page construit par le serveur.
Il n’a pas été utilisé pendant cette mise à niveau.

Les demandes de droits (accès, rectification, retrait, destruction et export
structuré) disposent d’un flux opérateur et d’un audit, mais la vérification
d’identité, la décision et l’exécution restent manuelles. Le CRM ne contient
pas de registre d’incidents : le processus externe obligatoire est décrit dans
`docs/compliance-controls.md`. Il n’existe aucune qualification entièrement
automatisée ni aucun composeur. Les séquences de prospection servent seulement
à planifier et à marquer des étapes manuelles; elles ne déclenchent aucun envoi.

La migration `0010_outreach_planning.sql` contient les résultats de recherche
publique observés le 30 août 2026. Une adresse publique ou un rôle nommé ne
prouve ni la pertinence actuelle, ni l’absence de restriction, ni un fondement
LCAP. L’opérateur doit revoir la source et la décision au moment de l’action.

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

Les migrations `0004_flawless_orphan.sql` à `0010_outreach_planning.sql` sont
validées ensemble sur une base SQLite jetable avec contrôle des clés
étrangères. La migration `0010` et l’interface de stratégie de ce worktree ne
sont pas publiées par la préparation locale de cette tranche. Le binding D1
réel appartient au projet Sites; le `database_id` du mode local est
volontairement un placeholder.

Les contacts historiques sont intentionnellement bloqués après `0006` jusqu’à
une nouvelle vérification et une preuve par canal. Il n’existe pas de migration destructive de retour arrière automatique. Le
retour arrière sûr est une restauration D1 à un point antérieur ou une
migration corrective en avant, après export. Voir `docs/operations.md`.
