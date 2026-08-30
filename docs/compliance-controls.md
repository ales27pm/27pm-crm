# Contrôles de conformité avant approche

Ce document décrit les contrôles techniques du CRM. Il ne constitue pas un
avis juridique et ne transforme pas une hypothèse de prospection en fait. Une
preuve ou une décision de politique interne absente maintient le canal bloqué.

Sources officielles consultées pour cette tranche : le [guide LCAP du
CRTC](https://crtc.gc.ca/fra/com500/guide.htm), la [FAQ LCAP du
CRTC](https://crtc.gc.ca/fra/com500/faq500.htm), les [règles de
télémarketing](https://crtc.gc.ca/fra/phone/telemarketing/reg.htm), les
[obligations LNNTE](https://crtc.gc.ca/fra/phone/telemarketing/tobligations/regles-rules.htm)
et les pages de la CAI sur les [changements de la Loi
25](https://www.cai.gouv.qc.ca/protection-renseignements-personnels/sujets-et-domaines-dinteret/principaux-changements-loi-25)
et les [incidents de
confidentialité](https://www.cai.gouv.qc.ca/protection-renseignements-personnels/information-entreprises-privees/incidents-confidentialite-mesures-securite-entreprises).

## Matrice d’écart et résultat

| Exigence auditée | État avant 0006 | Contrôle livré | Limite ou décision requise |
| --- | --- | --- | --- |
| Preuve par contact, canal et adresse | Champs globaux incomplets | `contact_channel_compliance` conserve provenance, URL/date, référence, fondement, vérificateur, preuve et échéance; chaque création/édition et autorisation journalise un snapshot immuable complet | L’opérateur doit déposer une référence vérifiable; le CRM ne juge pas sa valeur juridique |
| Publication visible | « trouvé en ligne » pouvait être ambigu | Publication par le destinataire ou autorisée, absence de restriction et pertinence précise exigées | Bloqué si un des trois éléments manque; une liste tierce ne suffit pas |
| Exemption B2B | Organisations seules | Relation entre organisations et pertinence du message exigées séparément | La qualification juridique de la relation demeure à valider |
| Courriel | Contrôles répartis | `canEmail` serveur unique, revalidation transactionnelle avant autorisation et avant transport, un destinataire, confirmation opérateur, pied de page serveur | Les transferts hors Québec restent bloqués sans EFVP, contrat, validation et preuve |
| Désabonnement et suppression | Blocage au contact | Route publique à jeton opaque authentifié, suppression globale ou catégorie `prospecting`, preuve hachée, annulation des tâches/commandes, gardes de réimport et journal immuable | Tous les courriels composés dans ce CRM sont classés `prospecting`, quelle que soit la boîte; aucun choix de boîte ne contourne la suppression |
| Appels | Statut LNNTE seulement | `canCall` exige non-appel interne, vérification LNNTE récente, inscription de 27PM, numéro d’affaires, identité/numéro affiché, fuseau et heures | Aucun appel n’est lancé par le CRM; inscription et preuves réelles doivent être fournies |
| Données personnelles | Pas de classe explicite | Coordonnée de travail séparée de `other_personal`; cette dernière bloque l’approche; avertissements sur les champs libres | La minimisation et les durées de conservation finales requièrent une politique interne |
| Automatisation et fournisseur hors Québec | Aucun verrou explicite | Blocage par défaut sans validation juridique et référence d’EFVP/contrat; qualification entièrement automatisée bloquée | Les cases ne doivent être activées qu’après validation documentée |
| Droits des personnes | Pas de flux dédié | API opérateur pour accès, rectification, retrait, destruction et export structuré, avec statut et audit | Vérification d’identité, décision et exécution restent manuelles; aucun export ou effacement automatique |
| Incidents | Aucun registre applicatif | Processus externe exigé ci-dessous | Aucun registre d’incident n’est prétendu dans le CRM |

## Décision serveur

`lib/compliance.ts` est l’unique moteur d’autorisation. Il retourne une liste de
motifs lisibles et bloque par défaut. Les anciennes fonctions partielles ont
été retirées. La création d’un rappel de contact et son passage à « fait »
revalident le canal; l’envoi revalide encore l’état et les versions juste avant
le transport. Une demande de consentement ne contourne pas le moteur : le
fondement `none` reste bloqué.

Les migrations existantes sont conservées. `0006_compliance_hardening.sql`
reconstruit uniquement `send_commands`, ajoute les champs contact sans
reconstruire cette table, rétroclasse les contacts historiques à
`lawful_basis = 'none'`, crée les suppressions historiques et les triggers
d’immutabilité. `0007_compliance_evidence.sql` ajoute les références de preuve
et l’empreinte des imports. `0008_flippant_valeria_richards.sql` ajoute l’état
réservé/traité des callbacks Mailgun afin qu’une panne intermédiaire reste
reprenable sans perdre une plainte, un rebond ou une pièce jointe.

## Registre d’incidents hors application

Le CRM ne contient pas de registre d’incidents de confidentialité. Avant la
production, 27PM doit désigner le registre officiel hors application, son
responsable et son contrôle d’accès. Pour chaque incident, y consigner les
champs exigés par la CAI, les avis transmis et les mesures prises, et conserver
le registre au moins cinq ans. Ne jamais utiliser les notes libres d’un contact
comme registre d’incident.

## Blocages de mise en production

- aucune migration D1 ni publication avant un export/snapshot complet dont la
  restauration a été démontrée;
- aucun courriel avant configuration réelle de `CRM_UNSUBSCRIBE_SIGNING_KEY`,
  validation du mécanisme d’exclusion, identité complète et contrôles
  transfrontaliers;
- aucun formulaire public sans vrais secrets Turnstile et origine exacte;
- aucun appel avant les preuves LNNTE/numéro d’affaires et une validation de la
  politique d’appel de 27PM.
