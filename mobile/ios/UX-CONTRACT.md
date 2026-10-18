# Contrat UX — fichiers natifs 27PM CRM

Périmètre : section partagée des comptes, opportunités et conversations.
Français canadien ; dates/heure via `Theme.swift/Fmt` (America/Montreal).
Objectif d'accessibilité : état lisible par texte et symbole, Dynamic Type,
commandes natives et cibles confortables. Une conformité complète exige des
tests sur appareil, non déduits de ce contrat.

## Sources métier et autorisations

| Domaine | Source canonique |
| --- | --- |
| Session, droits, propriété active | `../../lib/attachment-v2-worker.ts`, `App27pmCRM/CrmStore.swift` |
| Analyse, version, intégrité, refus terminal | `../../lib/attachment-scan-service.ts`, `../../lib/attachment-v2-protocol.ts` |
| Transfert privé et plafonds | `../../lib/attachment-v2-transfer.ts`, `../../docs/attachment-pull-v2.md` |
| File locale et persistance | `App27pmCRM/OfflineKit.swift`, `App27pmCRM/AttachmentKit.swift` |
| Reprise/authentification réseau | `App27pmCRM/AttachmentSyncCoordinator.swift`, `Packages/NativeAttachmentPolicy` |
| Suppression/rétention | `../../lib/attachment-v2-store.ts`, contrat de transport ci-dessus |

Les mentions historiques de déploiement dans les documents de préparation ne
sont pas une preuve de la production actuelle. Aucun paiement ni courriel
automatique n'appartient à ce parcours.

## Visual contract

Voir `DESIGN.md`. Source des tokens : `App27pmCRM/Theme.swift` ; la section et ses
actions sont les propriétaires de leur géométrie, pas d'une nouvelle palette.

## Canonical UI Map

| Capability | Canonical owner | Source of truth | Allowed variants | Verification |
| --- | --- | --- | --- | --- |
| CRUD | `AttachmentSectionView` + `AttachmentStore` + `AttachmentSyncCoordinator` | Sources métier ci-dessus | compte / opportunité / conversation | XCTest de stockage/coordinateur, test iPhone |
| Form | `fileImporter`, `PhotosPicker`, `CameraCaptureView` | contrat de stockage | sélection native | taille, format, refus et conservation |
| Toast | erreur inline dans `AttachmentSectionView` | ce contrat | attente / erreur / refus | VoiceOver et test de restitution |

Grilles web, listes déroulantes web et scrollbars CSS sont hors périmètre natif.

## Flow ledger

| Opération | Attente | Succès | Échec / reprise |
| --- | --- | --- | --- |
| Ajouter | Valider format/taille, enregistrer localement et en file durable | Le fichier apparaît, sans faux succès distant | Erreur localisée, aucun fichier invalide mis en file |
| Envoyer | Même ID et clé d'idempotence après interruption | Réception confirmée puis vérification séparée | Erreur persistée visible, reprise adaptée avec la même identité |
| Actualiser la liste | Indicateur stable, une lecture dans la voie d'authentification sérialisée | Métadonnées seulement, aucune récupération automatique | Fichiers connus conservés, action Actualiser ; aucun faux « vide » |
| Télécharger un fichier distant | Intention explicite durable | Cache atomique après taille, version et SHA-256 identiques | Aucun assemblage partiel exposé ni original local remplacé |
| Analyse en attente | Quarantaine et reprise bornée | Disponibilité contrôlée par serveur, pas par couleur du badge | Un 423 inconnu ne devient pas un verdict d'infection |
| Blocage définitif | `423 attachment_blocked` authentifié | Arrêt des vérifications répétées | Pas de bouton Réessayer ; remplacer/supprimer selon droits |
| Aperçu | Copie locale clairement nommée | Vue native, contexte de session conservé | Aucun aperçu sans octets locaux ou après blocage/déconnexion |
| Supprimer | Confirmation nommant le fichier, intention durable | Réconciliation selon contrat de suppression | Ne pas supprimer d'autres fichiers ni inventer une réussite distante |

Dans les Paramètres, une suppression globale annonce aussi ses effets sur le
CRM et capture la liste exacte des identifiants au moment d'ouvrir la
confirmation. Les fichiers découverts ensuite n'entrent pas dans cette portée.

## Données et compatibilité

- La collection existante est bornée à 200 entrées par dossier ; ce correctif
  n'ajoute pas de pagination et ne déduit jamais une suppression d'une absence
  dans cette collection bornée.
- Métadonnées validées avant publication de l'import complet : propriétaire,
  UUID, nom, type, taille, date, empreinte et version.
- Une découverte ne réanime ni tombstone ni envoi local en attente.
- Les champs d'index ajoutés sont optionnels ; conserver la lecture des anciens
  index et les identifiants de la file existante.
- Une nouvelle version distante sans copie locale peut actualiser ses
  métadonnées ; elle n'est pas téléchargée sans nouvelle intention explicite.
- L'ancien serveur conserve un 423 générique : l'app ne doit pas le classer
  bloqué définitivement sans signal fiable. L'ancien client reste sûr face au
  nouveau signal, même s'il ne sait pas encore arrêter cette attente.

## Résilience et sécurité de l'interface

- Les lectures de collection, uploads et downloads partagent la même voie de
  rafraîchissement de jeton. Seule la politique d'authentification traite 401.
- Session/revision vérifiées après les attentes ; une réponse de l'ancienne
  connexion ne réimporte pas de nom ou d'octet client.
- Sans réseau, conserver les métadonnées connues et les originaux. Ne pas
  prétendre que le serveur est vide ou à jour.
- Un fichier confirmé bloqué ne redevient pas disponible par expiration du
  délai d'un résultat sain. Aucun nouveau droit ni détail machine exposé.
- Infections et politique d'archive restent protégées par le serveur, même si
  les commandes d'interface sont manipulées.

## Vérification

- Serveur : `npm run test:unit`, `npm run lint`, `npm run typecheck`,
  `npm run build`, `npm run build:vercel` depuis la racine.
- Apple : `AttachmentStoreTests`, `AttachmentSyncCoordinatorTests`,
  `ChunkedAttachmentTransportTests`, UI de distinction attente/blocage.
- Appareil : version/build, PDF/JPEG/PNG/HEIC, 20 Mio et dépassement,
  téléchargement sur appareil neuf, coupure/reprise, annulation, déconnexion,
  grande taille de texte, VoiceOver et contrôle des états persistants.
- Les tests source, builds web et fixtures UI ne remplacent ni une compilation
  Xcode ni la qualification d'une build signée sur iPhone physique.
