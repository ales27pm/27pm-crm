# 27PM CRM

CRM privé de 27PM : réception des courriels, conversations, contacts, projets,
pipeline et suivis. L’application gère deux identités distinctes :

- `bonjour@27pm.org` pour les demandes commerciales et les clients;
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
```

Il n’applique une route qu’avec `--apply`, après avoir confirmé que le point de
terminaison HTTPS de production est sain. Il ne modifie jamais le DNS.
