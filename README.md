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
- Mailgun par défaut pour l’envoi et toujours pour la réception, avec
  validation HMAC des webhooks et déduplication des événements;
- Cakemail comme transport sortant optionnel, désactivé tant que les preuves
  de politique, de préservation des en-têtes et d’alignement DKIM strict ne
  sont pas confirmées.

Le site public `27pm.org` est déployé séparément sur Vercel. Son formulaire
Turnstile transmet le contrat d’admission à l’API publique du CRM, mais le site
public ne stocke ni données CRM ni secrets opérateur.

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
npm run typecheck
npm run test:unit
npm run check
npm run db:generate
npm run mailgun:audit -- --help
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

L’adaptateur sortant Cakemail, ses variables, son webhook signé, son canari
obligatoire, sa résolution auditée des résultats inconnus et son retour arrière
sans changement de MX sont documentés dans
[docs/cakemail.md](docs/cakemail.md).

Le plan complet de délivrabilité, ses seuils, les limites des signaux SMTP et
les actions externes qui exigent une validation opérateur sont documentés dans
[docs/deliverability.md](docs/deliverability.md). L’écran **Réglages →
Délivrabilité** agrège uniquement des messages uniques et n’assimile jamais une
remise serveur à un placement en boîte de réception.

Le provisionneur Mailgun est en lecture seule par défaut :

```sh
node scripts/provision-mailgun-route.mjs
npm run mailgun:route:alexis
```

La seconde commande inspecte la couverture exacte d’`alexis@27pm.org`. Si le
compte permet plusieurs routes, elle peut ajouter une route non chevauchante;
si le forfait est limité à une route, elle élargit uniquement la route
historique reconnue, en conservant son identifiant, sa priorité et ses actions.
Le provisionneur n’applique rien sans `--apply` ni point de terminaison HTTPS
sain. Il ne modifie jamais le DNS et ne crée pas de boîte IMAP/POP distincte du
CRM.
