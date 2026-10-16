# Pièces jointes natives : retrait ClamAV sortant, v2

Implémentation locale du 16 octobre 2026, branche
`codex/attachment-pull-20261016`, basée sur `c5608add`.
**Non publiée et non activée.** Ce document ne remplace pas la validation sur
Sites/Vercel ni celle de l'application sur un appareil Apple.

## Périmètre

Les nouveaux transferts natifs passent par `https://crm.27pm.org`, en blocs
binaires de 2 097 152 octets au maximum, pour un fichier de 20 971 520 octets
maximum. Les pièces jointes Exchange historiques, les courriels, les DNS/MX,
l'authentification Google web et les anciens téléchargements ne sont pas migrés.
L'ancienne app ne négociant pas `chunked-v2` conserve sa capacité à `false`.

Le backend conserve D1 et R2 privés. Un agent Linux initie uniquement des appels
HTTPS sortants vers l'origine CRM fixe. Il retire un travail réservé, reconstruit
ses octets dans un temporaire non nommé, vérifie taille et SHA-256, puis appelle
l'adaptateur ClamAV existant sur `127.0.0.1:8788`. Aucun listener, hostname public
d'antivirus, tunnel OpenAI ou nouvelle clé OpenAI n'est ajouté.

## Contrat et protections

- Mobile : bearer signé, scopes et session active dans l'allowlist. Aucun cookie,
  en-tête d'identité transféré ou credential scanner ne remplace cette identité.
  Session et expiration sont revérifiées après les attentes réseau sensibles.
- Création : `POST /api/mobile/attachment-uploads`, manifeste JSON limité à
  16 Kio, propriétaire actif, clé d'idempotence liée au créateur et à sa session.
  Une même clé avec un autre manifeste est refusée.
- Réception : `PUT .../{id}/chunks/{index}`, octets bruts contrôlés par taille et
  SHA-256, staging R2 immuable. Une reprise consulte les blocs déjà confirmés.
  Ce ne sont pas des parties multipart R2.
- Finalisation : `POST .../{id}/complete`, lease de 120 secondes reprenable,
  assemblage séquentiel `FixedLengthStream`, checksum complet contrôlé par R2.
  Métadonnée et confirmation durable sont engagées dans un lot D1 transactionnel.
  Un timeout ne supprime pas les octets dont l'engagement peut être incertain.
- Après engagement, le fichier reste **en quarantaine**. L'analyse n'est pas
  attendue dans la requête de finalisation. Un échec transitoire d'enqueue est
  réconcilié lors d'une reprise de finalisation ou d'un accès au manifeste.
- Scanner : namespace `/api/internal/attachment-scanner/`, POST seulement,
  HMAC dédié `sc1`, liant méthode, chemin, query, corps, timestamp et nonce
  durable à usage unique. MAC contrôlé avant lecture du corps; fraîcheur
  revérifiée après lecture et accès DB. Pas d'identité opérateur inventée.
- `claim`, `heartbeat`, `jobs/{id}/renew`, `jobs/{id}/chunks/{index}`,
  `jobs/{id}/complete` et `jobs/{id}/fail` sont les seules actions machine.
  Lecture limitée à la réservation courante, sans nom client ni clé R2 exposée.
- Un résultat `crm-clamav-v1` est lié au hash, à la taille, à la version R2,
  à la politique, au job et à sa génération. Son reçu est immuable; seul le
  pointeur engagé par CAS dans D1 peut autoriser le téléchargement.
- Un résultat ancien ne peut pas écraser une nouvelle génération. Une répétition
  strictement identique réconcilie un accusé perdu. Un résultat infecté ou un
  refus de politique d'archive ne redevient pas sain par simple expiration.
- Téléchargement : manifeste puis plages de 2 Mio, version exacte requise.
  Droits, propriétaire, suppression, réservation/résultat et version sont
  revérifiés avant remise des octets. Aucun `Range` utilisateur arbitraire.
- iOS conserve le contrat existant retournant `Data` : reconstruction en mémoire,
  bornée à 20 Mio, puis vérification de la taille et du hash complet avant retour
  au coordinateur de stockage privé. Pas de présentation d'un assemblage partiel.
  Reconnexion, rotation de session ou annulation interrompent l'opération.
- Le BFF borne les corps avant transfert et ne crée pas d'assertion opérateur
  pour une requête scanner. Les credentials/identités internes ne sont pas
  rendus aux clients. L'auth Google signée reste inchangée.

Budgets actuels par créateur : trois uploads actifs, quarante créations et
100 Mio déclarés par 24 heures. Upload incomplet : une heure. Scan : cinq
tentatives maximum, lease/heartbeat de 120 secondes, renouvellement total limité
à dix minutes. Résultat sain : 24 heures; signatures : 72 heures maximum.
Ces plafonds ne remplacent pas une politique de rétention ou un budget fournisseur.
Aucune purge automatique n'est implémentée : les orphelins restent privés.

## Configuration — tout désactivé par défaut

| Cible | Valeur | État livré |
| --- | --- | --- |
| Vercel | `CRM_ATTACHMENT_V2_PROXY_ENABLED` | `0` |
| Sites | `ATTACHMENTS_V2_ENABLED` | `0` |
| Sites | `CRM_ATTACHMENT_SCANNER_ENABLED` | `0` |
| Sites | `CRM_SCANNER_KEY_ID`, `CRM_SCANNER_ID`, `CRM_SCANNER_SIGNING_KEY` | Absentes |

Le mobile continue d'utiliser sa clé serveur et son origine déjà prévues,
sans secret scanner embarqué. L'agent lit un fichier JSON contenant exactement
`keyId`, `scannerId`, `signingKey`, et un fichier séparé pour le token loopback.
Ces fichiers doivent être réguliers, sans symlink, détenus par l'utilisateur
du service et en mode `0600`, dans un répertoire privé.

Aucun credential n'a été généré, sauvegardé, partagé ou installé par cette tranche.
Ne réutiliser ni clé OpenAI, ni cookie navigateur, ni clé d'assertion interne,
ni token de l'adaptateur comme clé HMAC machine. Le choix des emplacements,
la génération et la distribution des secrets restent à approuver.

Entrée de l'agent, à utiliser seulement après ce provisionnement :

```sh
python3 services/antimalware/outbound_agent.py \
  --credential-file /chemin/prive/scanner.json \
  --adapter-token-file /chemin/prive/adapter.token --once
```

Sans `--once`, un seul travail est traité à la fois avec backoff et jitter.
L'agent n'a pas été lancé en service ni connecté à la production.
L'ordinateur doit rester allumé et ClamAV à jour; sinon aucun nouveau fichier
n'est libéré. Un heartbeat n'est jamais un résultat d'analyse sain.

## Migrations additives

`0022_attachment_v2_uploads.sql` ajoute objets, uploads et blocs.
`0023_attachment_scan_jobs.sql` ajoute jobs, heartbeat et nonces.
Le journal et les deux snapshots custom ont été produits avec le Drizzle Kit
verrouillé dans le projet, via une copie temporaire, en préservant 0000–0021.
Les séparateurs `statement-breakpoint` sont requis pour le migrateur D1.

Ces six tables sont volontairement **SQL-authoritatives**, utilisées via les
interfaces étroites `CrmDatabase`; elles ne sont pas déclarées dans `db/schema.ts`.
Les snapshots custom préservent donc le modèle ORM précédent. Ne pas utiliser
`drizzle-kit push` pour les synchroniser ou les supprimer. Pour les modéliser
ultérieurement dans l'ORM, produire aussi une transition cohérente des snapshots,
sans réémettre les `CREATE TABLE` déjà appliqués.

Aucune migration n'est appliquée à distance. Avant application : sauvegarde D1
et inventaire/copie R2 indépendants, restauration contrôlée et contrôle des
migrations réellement présentes. Ne pas reprendre le 0019 d'un ancien candidat.

## Preuves locales et limites

Commandes vérifiées sur cette branche : `npm run lint`, `npm run typecheck`,
`npm run test:unit`, `npm run build`, `npm run build:vercel`.
Dernier passage intégré : `npm run check` réussit avec **766 tests**, zéro échec;
build Vercel séparé réussi. `drizzle-kit check` et `git diff --check` réussissent.
Les évolutions déjà publiées dans Sites (synchronisation horaire Exchange/MCP,
capacité native inactive authentifiée) sont réconciliées sans reprendre
l'historique privé ni retirer leurs contrôles. Le lint conserve un avertissement
préexistant dans le test de synchronisation importé, sans erreur.
La suite Python opt-in réussit **10 tests** (sept unitaires, trois intégrations
loopback réelles, dont le contrôle EICAR porte sur brut et ZIP).
Les tests de routes exercent JWT/MAC réels et SQLite, avec R2 simulé. Les tests
`attachment-v2-runtime` exercent le moteur workerd, D1/R2 locaux réels, dix blocs
de 2 Mio, assemblage de 20 Mio, checksum R2 et lecture/version; leur adaptateur
ne remplace pas une session authentifiée de production.
Le parcours `attachment-v2-auth-runtime` ajoute le vrai handler JWT/MAC dans
workerd avec D1/R2 natifs, sur deux blocs (2 Mio + 17 octets), jusqu'au reçu
immuable et au téléchargement. Son verdict est explicitement synthétique.
Les tests `attachment-v2-migrations` exécutent aussi le vrai migrateur Drizzle
sur D1 local : historique préservé et second passage idempotent.

Tests de l'agent, sans accès CRM :

```sh
python3 -m unittest discover -s services/antimalware -p 'test_*.py' -v
CRM_TEST_LOCAL_CLAMAV=1 python3 -m unittest discover \
  -s services/antimalware -p 'test_*.py' -v
```

La seconde commande est un opt-in à l'installation loopback de ce poste.
Ses témoins synthétiques ont confirmé : 20 Mio sains, EICAR et EICAR ZIP infectés,
et archive à décompression excessive bloquée. La file distante y reste simulée.
Aucun fichier client ni message électronique n'a été transmis.

Les seize nouveaux tests Swift sont écrits, **non exécutés** : pas de toolchain
Apple locale; passerelle Mac indisponible et connexion SSH existante non
autorisée. Aucun changement d'authentification/VM n'a été tenté pour contourner
ce blocage. Build, signature, TestFlight et appareil réel restent à vérifier.

## Gates avant pilote et activation

1. Revue du patch, politique de rétention des staging/orphelins et budgets.
2. Tests Swift/Xcode puis iPhone réel : 20 Mio dans les deux sens, 20 Mio + 1
   refusé, arrière-plan/coupure/reprise/logout, IPv6/DNS64 et ancienne app.
3. Sauvegarde/restauration, publication du code validé flags à zéro et migrations
   additives vérifiées; provisionnement du credential dédié après accord.
4. Agent pilote et backend/BFF réels : mêmes fichiers synthétiques, quarantaine,
   délais, panne, reprise, suppression et remplacement concurrents.
5. Activation distincte et contrôlée, puis constat depuis l'app authentifiée.

La finalisation reste dans la requête HTTP avec réconciliation par lease;
aucun `waitUntil` n'est présenté comme une file durable. Le budget réel de
25 secondes du BFF et la mémoire sous charge doivent être mesurés au pilote.
Un succès local ne prouve pas la disponibilité de ce chemin chez les hébergeurs.

Rollback : remettre les trois flags à `0`, arrêter le retrait et révoquer la
clé machine si nécessaire. Conserver les originaux, tables additives, reçus et
objets référencés en quarantaine; pas de `DROP`, de suppression de document ou
de retour de base implicite. Aucun accès entrant à ClamAV n'est nécessaire.
