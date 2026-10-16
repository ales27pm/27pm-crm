# Contrat d'API — Capacités natives (crm.27pm.org)

> Contrat partagé avec la branche de revue `27pm-crm`. Le client iOS lie le
> paquet `NativeAttachmentPolicy` et conserve les opérations dans une file
> locale durable tant que la capacité réelle n'est pas confirmée. Cette
> conformité du code client ne signifie pas que les endpoints sont activés en
> production. Aucune rupture de compatibilité : tous les champs ajoutés au
> dashboard sont optionnels.

## Conventions héritées (inchangées)

- **Origine unique** : `https://crm.27pm.org`. Jamais `api.crm.27pm.org`,
  jamais d'IP littérale.
- **Authentification** : même mécanisme que `/api/dashboard` — en-tête
  `Authorization: Bearer <access token>` du jeton d'appareil (Authorization
  Code + PKCE). Aucun identifiant fourni par le client dans le corps.
- **Autorité locale durable** : les portées mobiles sont administratives à
  l'échelle de ce CRM (`crm:dashboard:read` et `crm:work`), pas une ACL de
  locataire ou d'opérateur inventée par le client. La file locale durable des
  pièces jointes survit donc à une reconnexion et ne doit pas être liée au hash
  d'un jeton éphémère. Les opérations en vol et toute interface affichant les
  fichiers restent néanmoins liées à l'époque exacte de la session qui les a
  commencées et sont abandonnées dès que cette session change.
- **Erreurs** : corps JSON `{"error": "<code>"}` ; seul un premier `401`
  déclenche la rotation du refresh token puis un seul rejeu. Un second `401`
  exige une nouvelle authentification. `403`, `423`, les erreurs de stockage
  et les `5xx` ne déclenchent jamais une rotation.
- **Dates** : mêmes formats que le dashboard (ISO 8601, SQLite UTC ou
  `YYYY-MM-DD` en `America/Montreal`).

## 1. Champs additionnels du dashboard

Ajouts optionnels dans `GET /api/dashboard` (absents = non renseigné) :

```jsonc
// organizations[]
{
  "address": "750 Chemin de la Chaudière",  // optionnel — adresse postale (sans ville)
  "city": "Lévis, QC"                       // optionnel — ville/région affichée
}

// contacts[]
{
  "phone": "+1 418 555 0142"                // optionnel — téléphone professionnel
}
```

Le client privilégie la valeur du serveur dès qu'elle est présente ; la
valeur saisie localement sur l'appareil ne sert que d'appoint.

## 2. Sonde de capacités

`GET /api/mobile/capabilities`

- `200` → `{"attachments": true}` lorsque les endpoints de la section 3 sont
  déployés et actifs pour cet appareil.
- `404` (ou tout échec) → le client considère les capacités indisponibles et
  garde chaque opération dans sa file locale.

## 3. Pièces jointes

### `POST /api/mobile/attachments`

`multipart/form-data` :

| Champ        | Type   | Description                                              |
| ------------ | ------ | -------------------------------------------------------- |
| `ownerKind`  | chaîne | `account` \| `deal` \| `conversation`                     |
| `ownerId`    | chaîne | identifiant du support dans le CRM                        |
| `file`       | binaire| fichier (photo JPEG ou document ; PDF, PNG, HEIC, etc.)   |

- `200` → `{"id": "<server attachment id>"}`
- Limites strictes : enveloppe multipart maximale de 21 Mio (22 020 096
  octets), fichier non vide de 20 Mio (20 971 520 octets) au maximum.
- Erreurs : `validation_failed` (forme ou champ invalide), `owner_not_found`
  (support syntaxiquement valide mais absent), `file_too_large`,
  `unsupported_media_type`, `attachments_unavailable`.
- Le client conserve une clé d'idempotence stable par fichier local. Le
  serveur déduplique obligatoirement les dépôts actifs identiques par
  `ownerKind`, `ownerId` et SHA-256 et retourne le même `id` durable, après
  confirmation de la clé, de la longueur et de la somme native du stockage.
- Le nom multipart est le nom local déterministe `<UUID local>.<extension>`.
  Le nom original destiné à l'opérateur reste conservé dans l'index local ;
  le nom déterministe permet de retrouver sans ambiguïté un POST commité dont
  la réponse a été interrompue pendant une suppression.
- Un `200` confirme le dépôt durable, pas encore le droit au téléchargement :
  l'analyse peut rester en quarantaine sans provoquer un nouveau POST.

### `DELETE /api/mobile/attachments/{id}`

- `204` → suppression logique des métadonnées actives et suppression des
  octets privés. Une répétition sur un identifiant déjà absent reste `204` au
  service de données ; le client traite également un `404` de passerelle
  comme un succès idempotent.

### `GET /api/mobile/attachments?ownerKind=&ownerId=` (recommandé)

Liste pour resynchroniser un multi-appareil futur :

```jsonc
{ "attachments": [ { "id": "…", "ownerKind": "account", "ownerId": "org-…",
  "fileName": "photo.jpg", "byteSize": 241_133,
  "sha256": "<64 caractères hexadécimaux minuscules>", "createdAt": "…" } ] }
```

Le SHA-256, dérivé du contenu et renvoyé uniquement à un appareil CRM
authentifié, permet de réconcilier un accusé de réception perdu lorsque la
déduplication serveur a conservé le nom de fichier d'un autre appareil. La
liste ne contient jamais de clé R2 ni d'URL de stockage.

### Téléchargement

`GET /api/mobile/attachments/{id}/file` — **toujours authentifié** (Bearer).
Aucune URL publique ni lien signé permanent. Une preuve d'analyse valide
retourne `200` avec les octets et des en-têtes privés `no-store`. Un objet en
attente, bloqué ou dont la preuve est absente, expirée, altérée ou liée à une
autre version retourne `423 {"error":"attachment_quarantined"}` avec
`Retry-After`. Une incohérence clé/longueur/SHA-256 retourne `503
attachment_storage_unavailable`.

Le client conserve toujours l'original local. Sur `200`, il vérifie la
longueur et le SHA-256 des octets téléchargés avant de marquer le fichier
disponible. Sur `423`, il conserve l'identifiant local, l'identifiant serveur
et une opération de téléchargement différée ; il affiche exactement
« En vérification / fichier bloqué ». `Retry-After` est borné entre 30 et
3 600 secondes ; le repli exponentiel est plafonné à 1 800 secondes.

## 4. Comportement du client en attendant le déploiement

| Étape                                | Comportement                                                       |
| ------------------------------------ | ------------------------------------------------------------------ |
| Sonde échoue (404/réseau)            | Fichiers et suppressions restent en file locale, indicateur honnête dans Paramètres |
| Sonde réussit                        | Upload, vérification et suppression avancent séparément ; une quarantaine différée ne bloque pas les autres éléments |
| Retour du réseau / relance de l'app  | Nouvelle sonde, réconciliation durable, puis reprise automatique sans doublon |
| Réponse POST interrompue             | Le même original et la même clé restent en file ; le dépôt serveur identique rend le même identifiant |
| Suppression pendant un POST          | Une pierre tombale conserve l'intention ; un accusé tardif déclenche la suppression du nouvel identifiant serveur |

## 5. Confidentialité

- Les pièces jointes sont des données clients : accès réservé à la session
  de l'appareil authentifié, jamais exposées publiquement.
- Aucune donnée de localisation n'est envoyée au serveur : le géocodage est
  fait côté appareil par le géocodeur système et reste en cache local.
