# 27PM CRM

CRM privé de 27PM : réception des courriels, conversations, contacts, projets,
pipeline et suivis. L’application gère trois identités distinctes :

- `bonjour@27pm.org` pour les demandes commerciales et les clients;
- `alexis@27pm.org` pour les échanges commerciaux nominatifs d’Alexis Boulet;
- `admin@27pm.org` pour Google Search Console et les comptes de service.

## Architecture

- Vinext/React sur OpenAI Sites et Cloudflare Workers;
- authentification gérée par Sites, doublée d’une liste explicite
  `CRM_ADMIN_EMAILS`;
- D1 pour les courriels, contacts, dossiers, tâches et journaux d’événements;
- R2 privé pour les pièces jointes, dont le téléchargement reste bloqué tant
  qu’une analyse antimalware n’est pas configurée;
- Mailgun pour l’envoi et la réception, avec validation HMAC des webhooks et
  déduplication des événements.

Le site public `27pm.org` et son hébergement GitHub Pages restent entièrement
séparés du CRM.

## CRM de prospection

Le CRM sépare les entreprises, contacts sourcés et opportunités. Il gère le
pipeline, les relances, les interactions, la provenance, l’assignation et les
blocages de conformité. La cohorte initiale contient cinq entreprises, cinq
routes professionnelles officielles et un contact professionnel nominatif
publié sur le site de son entreprise. Les six adresses restent au statut
`unknown` et ne sont jamais rendues envoyables par leur simple présence.

Chaque entreprise peut avoir une stratégie datée : recherche, validation,
premier courriel proposé, deux relances au maximum, puis fermeture ou veille.
Les étapes apparaissent dans le dossier 360° et la vue Tâches. Une stratégie ne
compose et n’envoie aucun message; une étape de contact demeure bloquée tant
que le moteur de conformité ne dispose pas de toutes les preuves exigées.
La portée et les limites du formulaire public, de l’authentification et du
déploiement sont détaillées dans
[docs/mvp-limitations.md](docs/mvp-limitations.md).

## Développement

Node.js `>=22.13.0` est requis.

```sh
npm run dev
npm run lint
npm run test:unit
npm run db:generate
```

`npm test` produit l’artefact déployable puis exécute tous les tests Node. Le
cycle Sites normal utilise plutôt un checkpoint, qui réalise lui-même la
construction et la publication.

Copier `.env.example` vers un fichier local ignoré et fournir les variables
requises. Ne jamais enregistrer de clé Mailgun dans Git.

## Mise en service

La procédure complète, le test de santé et la création idempotente de la route
Mailgun sont décrits dans [docs/operations.md](docs/operations.md). La création
du compte Google avec l’adresse existante `admin@27pm.org` est décrite dans
[docs/google-accounts.md](docs/google-accounts.md).

Le provisionneur Mailgun est en lecture seule par défaut :

```sh
node scripts/provision-mailgun-route.mjs
npm run mailgun:route:alexis
```

La seconde commande inspecte uniquement la route additive, exacte et
non chevauchante d’`alexis@27pm.org`. Le provisionneur n’applique une route
qu’avec `--apply`, après avoir confirmé que le point de terminaison HTTPS de
production est sain. Il ne modifie jamais le DNS et ne crée pas de boîte
IMAP/POP distincte du CRM.
