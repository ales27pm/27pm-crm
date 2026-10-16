# Guide d'implémentation — Endpoints « Capacités natives » (crm.27pm.org)

> Document d'exécution pour le dépôt `27pm-crm`. Le contrat de référence est
> `ios-27pm-crm/docs/crm-27pm-org-api-contract.md` ; ce guide le traduit en
> étapes concrètes, dans l'ordre de déploiement. Tant que la sonde
> `GET /api/mobile/capabilities` ne répond pas `{"attachments": true}`, le
> client iOS garde tout en file locale — vous pouvez donc déployer chaque
> étape sans risque, indépendamment.

---

## 0. Hypothèses et périmètre

- **Pile supposée** : Next.js App Router (`app/api/**/route.ts`), SQLite
  existant, authentification par jeton d'appareil déjà en place (celle de
  `/api/dashboard`). Le client ne voit que le HTTP : adaptez les exemples SQL
  et d'accès aux données à votre couche existante.
- **Origine unique** : tout se déploie sur `https://crm.27pm.org`. Jamais de
  sous-domaine (`api.crm.27pm.org` est interdit), jamais d'IP littérale —
  c'est une exigence IPv6/DNS64 du client.
- **Conventions inchangées** : `Authorization: Bearer <access token>`,
  erreurs JSON `{"error": "<code>"}`, dates ISO 8601 (ou SQLite UTC
  `YYYY-MM-DD HH:MM:SS`, déjà comprises par le parseur du client).
- **Périmètre** : (1) champs `address`/`city` des comptes et `phone` des
  contacts dans le dashboard, (2) sonde de capacités, (3) quatre endpoints
  pièces jointes. La consignation d'interactions reste hors périmètre.

**Ordre de déploiement** (chaque étape est indépendante et sans risque) :

| #  | Livrable                              | Impact client                          |
|----|----------------------------------------|----------------------------------------|
| 1  | Migration base de données              | Aucun                                  |
| 2  | Champs dashboard (`address`, `city`, `phone`) | Champs apparaissent dans l'app  |
| 3  | Stockage fichiers + table `attachments` | Aucun                                 |
| 4  | `POST` / `DELETE` / `LIST` / `GET file` | Aucun (sonde encore négative)         |
| 5  | `GET /api/mobile/capabilities` → `true` | **La file locale se vide seule**      |

---

## Étape 1 — Migration de base de données

Ajoutez les colonnes du contrat (toutes optionnelles) et la table des
pièces jointes :

```sql
-- Champs du contrat (section 1)
ALTER TABLE organizations ADD COLUMN address TEXT;
ALTER TABLE organizations ADD COLUMN city TEXT;
ALTER TABLE contacts ADD COLUMN phone TEXT;

-- Pièces jointes (section 3)
CREATE TABLE attachments (
  id           TEXT PRIMARY KEY,              -- UUID généré par le serveur
  owner_kind   TEXT NOT NULL CHECK (owner_kind IN ('account','deal','conversation')),
  owner_id     TEXT NOT NULL,
  file_name    TEXT NOT NULL,                 -- nom d'affichage (ex. « Photo », « rapport.pdf »)
  content_type TEXT NOT NULL,
  byte_size    INTEGER NOT NULL,
  sha256       TEXT NOT NULL,                 -- déduplication + intégrité
  storage_key  TEXT NOT NULL,                 -- chemin RELATIF dans le volume (jamais absolu)
  created_at   TEXT NOT NULL,                 -- 'YYYY-MM-DD HH:MM:SS' UTC
  created_by   TEXT,                          -- référence de session appareil (audit)
  deleted_at   TEXT                           -- soft delete ; NULL = actif
);

CREATE INDEX idx_attachments_owner   ON attachments (owner_kind, owner_id);
CREATE INDEX idx_attachments_dedup   ON attachments (owner_kind, owner_id, sha256);
```

Notes :
- `ALTER TABLE … ADD COLUMN` est sans coût en SQLite : aucun verrou long,
  aucun impact sur le traffic existant.
- Gardez le nom de table/colonnes en snake_case ; la sérialisation JSON en
  camelCase se fait dans les route handlers (comme le dashboard actuel).

---

## Étape 2 — Exposer les nouveaux champs dans `GET /api/dashboard`

Dans le handler existant `app/api/dashboard/route.ts`, ajoutez les colonnes
aux requêtes et à la sérialisation :

```ts
// organizations[] — ajouter :
address: row.address ?? null,   // clé présente avec null OU clé absente : les deux marchent
city: row.city ?? null,

// contacts[] — ajouter :
phone: row.phone ?? null,
```

**Pourquoi les deux formes sont sûres** : le décodeur Swift du client
déclare ces champs en optionnels (`String?`) décodés avec
`decodeIfPresent` — une clé absente, `null` ou une chaîne vide sont tous
tolérés. Vous n'avez **aucune** migration de payload à coordonner.

Vérification immédiate après déploiement : dans l'app, les dossiers 360°
affichent l'adresse du serveur en priorité sur la valeur saisie localement
(`CrmStore.address(for:)` privilégie la valeur serveur).

---

## Étape 3 — Stockage des fichiers

Décision structurante : les fichiers ne vont **jamais** dans le déploiement
Next ni dans `public/`. Utilisez un volume persistant :

```
/var/lib/crm27pm/attachments/2026/10/<id>   ← contenu binaire brut
```

- **Chemin piloté par la base** : `storage_key` contient le chemin relatif
  (`2026/10/<id>`), jamais de chemin fourni par le client → aucune
  traversée de répertoire possible.
- **Écriture atomique** : écrire dans `<key>.tmp` puis `rename()`, pour ne
  jamais servir un fichier partiel.
- **Sauvegardes** : le volume entre dans la même politique de sauvegarde que
  la base (base et volume sont cohérents si la sauvegarde du volume précède
  de peu celle de la base ; la dédup par `sha256` tolère un fichier
  orphelin, jamais une ligne sans fichier).
- **Limite de taille** : 20 Mo par fichier (contractuelle). Vérifiez aussi
  la limite du proxy en amont (nginx `client_max_body_size 21m;`, Cloudflare
  ≤ 100 Mo par défaut) — sinon le client verrait une erreur réseau générique
  au lieu du code prévu.

---

## Étape 4 — Authentification (réutiliser l'existant)

Chaque endpoint de `api/mobile/*` utilise le même garde que
`app/api/dashboard/route.ts` :

```ts
// helpers/auth.ts — le vôtre existe déjà ; c'est le même appel.
const session = await requireDeviceSession(request);
// 401 → NextResponse.json({ error: "authentication_required" }, { status: 401 })
```

Le client gère : `401` → rotation du refresh token → **un seul** rejeu de la
requête. Ne renvoyez jamais `401` pour autre chose qu'un jeton expiré ou
invalide, sinon la file d'envoi garde l'opération en attente (comportement
voulu, mais inutile ici).

---

## Étape 5 — `GET /api/mobile/capabilities` (la sonde)

**Déployez ce endpoint en dernier**, ou pilotez-le par un drapeau
d'environnement — c'est lui qui déclenche l'envoi réel des pièces jointes
accumulées sur les appareils.

```ts
// app/api/mobile/capabilities/route.ts
import { NextResponse } from "next/server";

export const runtime = "nodejs";            // pas d'Edge : cohérence avec le reste de /api
export const dynamic = "force-dynamic";     // jamais de cache de la sonde

export async function GET(request: Request) {
  const session = await requireDeviceSession(request); // 401 sinon
  const attachmentsEnabled = process.env.ATTACHMENTS_ENABLED === "1";
  return NextResponse.json({ attachments: attachmentsEnabled });
}
```

Règles de la sonde telles que le client les applique :

| Réponse serveur                  | Interprétation client                    |
|----------------------------------|------------------------------------------|
| `200 {"attachments": true}`      | Capacité confirmée → la file se vide     |
| `200 {"attachments": false}`     | Capacité refusée → tout reste en file    |
| `404`, `401`, timeout, HTML…     | Capacité indisponible → tout reste en file |

Répondez donc toujours JSON (`Accept: application/json` est envoyé par le
client) et n'activez `ATTACHMENTS_ENABLED=1` qu'à l'étape 9.

---

## Étape 6 — `POST /api/mobile/attachments`

Multipart (`multipart/form-data`), champs attendus par le client :
`ownerKind`, `ownerId`, `file`. Réponse `200 {"id": "..."}`.

```ts
// app/api/mobile/attachments/route.ts
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const MAX_BYTES = 20 * 1024 * 1024;
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/heic",
  "application/pdf", "text/plain", "text/csv",
  "application/msword", "application/vnd.ms-excel", "application/zip",
  "application/octet-stream",
]);

function fail(code: string, status: number) {
  return NextResponse.json({ error: code }, { status });
}

export async function POST(request: Request) {
  const session = await requireDeviceSession(request);

  // 1. Parsing multipart — le client envoie ownerKind, ownerId, file.
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return fail("validation_failed", 400);
  }

  const ownerKind = String(form.get("ownerKind") ?? "");
  const ownerId = String(form.get("ownerId") ?? "");
  const file = form.get("file");

  if (!["account", "deal", "conversation"].includes(ownerKind)) return fail("validation_failed", 400);
  if (!ownerId) return fail("validation_failed", 400);
  if (!(file instanceof File)) return fail("validation_failed", 400);
  if (file.size === 0 || file.size > MAX_BYTES) return fail("file_too_large", 413);
  const contentType = file.type || "application/octet-stream";
  if (!ALLOWED_TYPES.has(contentType)) return fail("unsupported_media_type", 415);

  // 2. Le support doit exister (comptes, opportunités, conversations).
  const owner = await findOwner(ownerKind, ownerId);   // SELECT sur organizations/deals/conversations
  if (!owner) return fail("owner_not_found", 404);

  // 3. Déduplication : même contenu déjà attaché à ce support → même id.
  const buffer = Buffer.from(await file.arrayBuffer());
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  const existing = await db.get(
    `SELECT id FROM attachments
     WHERE owner_kind = ? AND owner_id = ? AND sha256 = ? AND deleted_at IS NULL`,
    ownerKind, ownerId, sha256
  );
  if (existing) return NextResponse.json({ id: existing.id });

  // 4. Écriture atomique dans le volume.
  const id = randomUUID();
  const now = new Date();
  const storageKey = path.join(
    String(now.getUTCFullYear()), String(now.getUTCMonth() + 1).padStart(2, "0"), id
  );
  const absolute = path.join(ATTACHMENTS_ROOT, storageKey); // ATTACHMENTS_ROOT = /var/lib/crm27pm/attachments
  await mkdir(path.dirname(absolute), { recursive: true });
  await writeFileAtomic(path.join(absolute + ".tmp"), buffer);
  await rename(absolute + ".tmp", absolute);

  // 5. Ligne en base, puis confirmation.
  await db.run(
    `INSERT INTO attachments
       (id, owner_kind, owner_id, file_name, content_type, byte_size,
        sha256, storage_key, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ownerKind, ownerId,
    file.name || (contentType.startsWith("image/") ? "Photo" : "Document"),
    contentType, buffer.size, sha256, storageKey,
    formatSqliteUtc(now), session.reference
  );

  return NextResponse.json({ id });
}
```

Points de conformité au contrat :

- `owner_not_found` (404) : vérifiez le support **dans la bonne table** selon
  `ownerKind` (`organizations`, `deals`, `conversations`).
- La dédup `(ownerKind, ownerId, sha256)` rend le double dépôt idempotent —
  la clé d'idempotence locale du client ne protège que contre ses propres
  redémarrages ; un double envoi réseau reste possible et doit retourner le
  même `id`.
- Ne vous fiez pas au `Content-Type` déclaré pour la sécurité : c'est une
  allowlist de routage, pas une validation de contenu. Un `file`/`ODA` scan
  existe déjà côté infra ? Sinon, notez-le comme suite.

---

## Étape 7 — `DELETE /api/mobile/attachments/{id}`

Soft delete + suppression du fichier, **idempotent** :

```ts
// app/api/mobile/attachments/[id]/route.ts
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await requireDeviceSession(request);
  const { id } = await params;

  const row = await db.get(
    `SELECT id, storage_key FROM attachments WHERE id = ? AND deleted_at IS NULL`, id
  );
  if (!row) {
    // Contrat : déjà supprimé = succès. Le client iOS traite 404 comme un
    // succès et 2xx comme un succès — les deux évitent une boucle de rejeu.
    return new NextResponse(null, { status: 204 });
  }

  await db.run(`UPDATE attachments SET deleted_at = ? WHERE id = ?`, formatSqliteUtc(new Date()), id);
  await rm(path.join(ATTACHMENTS_ROOT, row.storage_key), { force: true }); // force: idempotent
  return new NextResponse(null, { status: 204 });
}
```

Gardez la ligne en base (soft delete) : l'historique d'audit reste intact et
le fichier peut être restauré depuis la sauvegarde pendant la fenêtre de
rétention.

---

## Étape 8 — `GET /api/mobile/attachments` (liste) et `GET …/{id}/file`

**Liste** (recommandée par le contrat, pour le multi-appareil futur) :

```ts
// app/api/mobile/attachments/route.ts
export async function GET(request: Request) {
  await requireDeviceSession(request);
  const url = new URL(request.url);
  const ownerKind = url.searchParams.get("ownerKind") ?? "";
  const ownerId = url.searchParams.get("ownerId") ?? "";
  if (!["account", "deal", "conversation"].includes(ownerKind) || !ownerId) {
    return NextResponse.json({ error: "validation_failed" }, { status: 400 });
  }
  const rows = await db.all(
    `SELECT id, owner_kind, owner_id, file_name, byte_size, created_at
     FROM attachments WHERE owner_kind = ? AND owner_id = ? AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    ownerKind, ownerId
  );
  return NextResponse.json({
    attachments: rows.map((r) => ({
      id: r.id, ownerKind: r.owner_kind, ownerId: r.owner_id,
      fileName: r.file_name, byteSize: r.byte_size, createdAt: r.created_at,
    })),
  });
}
```

**Téléchargement** — toujours authentifié, jamais d'URL publique :

```ts
// app/api/mobile/attachments/[id]/file/route.ts
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  await requireDeviceSession(request);
  const { id } = await params;
  const row = await db.get(
    `SELECT content_type, byte_size, storage_key, file_name
     FROM attachments WHERE id = ? AND deleted_at IS NULL`, id
  );
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const stream = createReadStream(path.join(ATTACHMENTS_ROOT, row.storage_key));
  return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
    headers: {
      "Content-Type": row.content_type,
      "Content-Length": String(row.byte_size),
      "Content-Disposition": `inline; filename="${encodeURIComponent(row.file_name)}"`,
      "Cache-Control": "private, no-store",
    },
  });
}
```

Aucune mise en cache CDN (`private, no-store`) : ces fichiers sont des
données clients, la vignette/visualisation reste côté appareil.

---

## Étape 9 — Tests curl de bout en bout

Avec un access token valide (récupéré via votre flow appareil existant) :

```bash
TOKEN="…"   # access token d'appareil
BASE="https://crm.27pm.org"

# 1. Sonde (doit répondre {"attachments": true} après activation du drapeau)
curl -sS -H "Authorization: Bearer $TOKEN" "$BASE/api/mobile/capabilities"

# 2. Envoi — mêmes champs que le client (ownerKind, ownerId, file)
curl -sS -X POST "$BASE/api/mobile/attachments" \
  -H "Authorization: Bearer $TOKEN" \
  -F "ownerKind=account" \
  -F "ownerId=org-s-huot" \
  -F "file=@/tmp/local.jpg;type=image/jpeg"
# → {"id":"…"}

# 3. Double dépôt = même id (déduplication)
curl -sS -X POST "$BASE/api/mobile/attachments" \
  -H "Authorization: Bearer $TOKEN" \
  -F "ownerKind=account" -F "ownerId=org-s-huot" \
  -F "file=@/tmp/local.jpg;type=image/jpeg"

# 4. Liste
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/mobile/attachments?ownerKind=account&ownerId=org-s-huot"

# 5. Téléchargement authentifié (octets identiques au fichier envoyé)
curl -sS -H "Authorization: Bearer $TOKEN" \
  "$BASE/api/mobile/attachments/<id>/file" -o /tmp/downloaded.jpg
shasum -a 256 /tmp/local.jpg /tmp/downloaded.jpg   # les deux empreintes sont égales

# 6. Suppression, puis re-suppression (les DEUX doivent répondre 2xx)
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/mobile/attachments/<id>" -o /dev/null -w "%{http_code}\n"  # 204
curl -sS -X DELETE -H "Authorization: Bearer $TOKEN" "$BASE/api/mobile/attachments/<id>" -o /dev/null -w "%{http_code}\n"  # 204

# 7. Sans jeton → 401 {"error":"authentication_required"}
curl -sS "$BASE/api/mobile/capabilities" -o /dev/null -w "%{http_code}\n"
```

Vérifications d'erreurs : fichier > 20 Mo → `413 file_too_large` ;
`ownerKind=banana` → `400 validation_failed` ; `ownerId` inconnu →
`404 owner_not_found` ; `.exe` → `415 unsupported_media_type`.

---

## Étape 10 — Activation et vérification côté app

1. Déployez les étapes 1–8 (sonde peut déjà répondre `false`).
2. Renseignez au moins une adresse sur un compte dans l'app (dossier 360° →
   **Ajouter**) — elle reste locale tant que l'étape 2 n'est pas déployée.
3. Déployez l'étape 2 : l'adresse serveur prime dans l'app.
4. Ajoutez une photo hors connexion (mode avion) : elle reste locale avec la
   pastille **« En file »** ; coupez le mode avion.
5. Passez `ATTACHMENTS_ENABLED=1`, redéployez.
6. Dans l'app : **Paramètres → Stockage local** doit afficher
   **« Endpoints confirmés »**, et la file d'attente (**Opérations en
   file**) se vide seule au prochain rafraîchissement — la photo prise en
   mode avion part sans geste supplémentaire.
7. Vérifiez en base : ligne `attachments` avec `sha256`, puis la pastille
   « En file » disparaît dans l'app (`markSynced`).

C'est le critère de réussite de l'objectif qualité **« File d'envoi
fiable »** : envoi interrompu → reprise seule → pas de doublon.

---

## Étape 11 — Explication continue

- **Sauvegardes** : base **et** volume ensemble ; testez une restauration
  complète une fois.
- **Purge des orphelins** (cron hebdomadaire) : fichiers du volume sans
  ligne active en base → suppression après 7 jours.
- **Quota/monitoring** : alerte sur la taille du volume
  (`SUM(byte_size) FROM attachments WHERE deleted_at IS NULL`).
- **Rétention des soft deletes** : après votre fenêtre (ex. 90 jours),
  purger lignes + fichiers.
- **Ne dérivez jamais d'URL** : tout reste sur `crm.27pm.org` — la sonde du
  client échouerait sur un sous-domaine, par conception.

---

## Annexe A — Récapitulatif des endpoints

| Endpoint | Méthode | Succès | Erreurs |
|---|---|---|---|
| `/api/mobile/capabilities` | GET | `200 {"attachments": true\|false}` | `401` |
| `/api/mobile/attachments` | POST (multipart) | `200 {"id":"…"}` | `400 validation_failed`, `401`, `404 owner_not_found`, `413 file_too_large`, `415 unsupported_media_type` |
| `/api/mobile/attachments` | GET `?ownerKind=&ownerId=` | `200 {"attachments":[…]}` | `400`, `401` |
| `/api/mobile/attachments/{id}` | DELETE | `204` (idempotent, même si absent) | `401` |
| `/api/mobile/attachments/{id}/file` | GET | `200` flux binaire | `401`, `404 not_found` |

## Annexe B — Pièges connus

1. **Edge runtime** : `request.formData()` et `node:fs` exigent
   `runtime = "nodejs"` sur les routes d'upload/download.
2. **Proxy en amont** : la limite `client_max_body_size` (ou équivalent)
   doit dépasser 20 Mo, sinon les gros envois meurent en réseau sans le code
   d'erreur prévu.
3. **JSON absent vs `null`** : les deux sont acceptés par le client pour les
   champs optionnels — ne cassez rien en supprimant des clés.
4. **Delete idempotent** : répondez `204` même si la pièce jointe n'existe
   plus (le client iOS traite aussi `404` comme succès — les deux évitent la
   boucle de rejeu, mais `204` reste la forme propre).
5. **Jamais de `public/`** pour les fichiers : toute URL non authentifiée
   viole la section confidentialité du contrat.
6. **Un seul hôte** : la sonde et les endpoints vivent sous `crm.27pm.org` ;
   aucune redirection inter-hôtes ne suit le flux du client.
