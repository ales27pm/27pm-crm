# Connexion Microsoft déléguée — tranche de préparation

## Portée

Cette tranche prépare la connexion de la boîte Alexis au CRM; elle **ne livre
pas encore la synchronisation de messages ni le transport sortant Exchange**.
Les MX, les webhooks et le fournisseur sortant Mailgun restent inchangés.
Aucun envoi, suppression ou déplacement Microsoft n'est exécuté par ce code.
Le statut `connected` confirme une autorisation OAuth vérifiée et conservée,
pas un test de réception, un envoi ou un placement Inbox.

L'opérateur a autorisé une seule boîte, avec `Mail.ReadWrite` et `Mail.Send`,
ainsi que le stockage chiffré dans le R2 privé existant. Le premier droit peut
techniquement supprimer des messages; ce connecteur ne le fait pas. Les scopes
OIDC `openid profile offline_access` servent à vérifier l'identité immuable et
à renouveler la connexion, sans ajouter `User.Read` ni droit applicatif global.

## Deux déploiements, une seule frontière de secrets

- Vercel sert `/settings/exchange` et relaie les actions d'un opérateur Google
  authentifié et autorisé, avec le mécanisme interne signé existant.
- Le Worker Sites reçoit le retour Microsoft **directement** sur
  `https://api.crm.27pm.org/api/integrations/exchange/callback`, uniquement en
  `POST application/x-www-form-urlencoded`. Le proxy Vercel refuse ce chemin.
- Aucun code OAuth dans une URL : le retour `form_post` met le code temporaire
  dans R2 chiffré, puis redirige vers `https://crm.27pm.org/settings/exchange?complete=1`.
- L'onglet d'origine finalise une seule fois avec un aléa de liaison de session
  et son identité opérateur. Ni cet aléa ni l'état OAuth brut ne vont dans D1;
  seulement leurs empreintes. Un autre navigateur ou opérateur ne peut finaliser.
- Le code Microsoft étant très bref, la finalisation est immédiate au retour.
  Un échec ou un résultat ambigu ne déclenche aucun rejeu automatique.

`CRM_EXCHANGE_ENABLED` est **false par défaut**. Il contrôle la connexion,
pas l'envoi de courriels. Aucun changement de `CRM_OUTBOUND_PROVIDER`.

## Identités préparées

L'inscription Entra **27PM CRM Exchange** a été créée le 13 octobre 2026 au
soir (heure de Montréal), mono-tenant, avec un retour Web et aucun retour SPA
ou public client. Aucun secret ni consentement Microsoft n'a été créé par
cette inscription seule.

- Tenant : `fa50326f-9af6-47b5-a45e-9f5ef5f6ea61`.
- Client : `74eb1889-7bf4-4a8b-aa74-f8fba1616531`.
- Objet de l'application : `fe014b3c-871b-4d9f-ab9e-aba47acbc73c`.
- Objet de la boîte autorisée : `b27823bf-22d1-4f1e-a461-c0e60523cdd3`.
- UPN conservé : `alexis@27PM428.onmicrosoft.com`.
- L'adresse SMTP et les alias `alexis@27pm.org`, `bonjour@27pm.org`,
  `admin@27pm.org` ont été vérifiés dans le portail lors de la préparation
  précédente. Ils ne constituent pas trois licences ou trois boîtes physiques.

Ces identifiants ne sont pas des secrets; aucun mot de passe, refresh token ou
justificatif applicatif ne doit être ajouté à ce document.

## Stockage et concurrence

- Clé AES-256-GCM dédiée, exactement 32 octets en base64url canonique, et secret
  applicatif confidentiel conservés uniquement dans **Sites Secrets**.
- Refresh tokens et secrets temporaires PKCE chiffrés sous
  `_credentials/exchange/v1/` dans R2 privé, jamais enregistrés comme pièces
  jointes. Les deux frontières de téléchargement refusent `_credentials/`.
- Données authentifiées liées à la version, au tenant, à l'application, à la
  boîte et à la finalité. Nouveau nonce à chaque écriture, enveloppe bornée.
- D1 contient seulement l'état de connexion, le pointeur UUID du justificatif,
  les verrous, les empreintes OAuth et une file de nettoyage non secrète.
- Verrou de 60 secondes et CAS génération/version; flux OAuth de 5 minutes,
  utilisables une seule fois; code staged accepté au maximum 55 secondes.
- Une rotation écrit un nouvel objet immuable, puis valide son pointeur D1
  avant tout usage. Une déconnexion invalide d'abord les anciens flux et
  écrivains. Les échecs de nettoyage restent visibles et récupérables.
- Une réponse de stockage perdue impose une relecture; ne jamais supprimer
  un justificatif qui pourrait être devenu actif, ni rejouer un code Microsoft.

La déconnexion bloque l'usage par le CRM. Elle ne révoque pas à elle seule le
consentement Entra et ne déconnecte pas les autres sessions Microsoft. En cas
de compromission, retirer explicitement le consentement de **cette application**
dans Microsoft, puis désactiver le connecteur; ne pas révoquer toutes les
sessions du compte par défaut.

## Activation — portes à franchir, non présumées réussies

1. Vérifier les builds Sites et Vercel, les tests de concurrence et les routes
   d'authentification. Sauvegarder D1 avant les migrations additives 0019/0020;
   préserver l'audience publique du site et l'accès opérateur interne.
2. Dans l'inscription Entra ci-dessus, garder seulement les droits délégués
   nécessaires. Pas de permissions applicatives sur toutes les boîtes, pas de
   flux implicite, pas de client public. Le secret doit être créé/acheminé par
   une saisie privée, pas collé dans une conversation, un dépôt ou un journal.
3. Renseigner les variables `CRM_EXCHANGE_*` de `.env.example` uniquement dans
   Sites. Garder `CRM_EXCHANGE_ENABLED=false` jusqu'au déploiement vérifié des
   deux parties. Vercel ne reçoit **aucune** clé Exchange.
4. Vérifier en environnement réel le bucket privé, les préconditions R2,
   l'absence de journalisation des corps OAuth et le rejet du callback via
   Vercel. Ne jamais tester ces protections avec un vrai secret dans une URL.
5. Activer la connexion, ouvrir `/settings/exchange` en opérateur, consentir
   pour la boîte prévue; vérifier connexion, renouvellement manuel, rejet des
   autres identités et déconnexion. Ne pas annoncer ces tests comme déjà faits.
6. Livrer séparément le delta entrant, le classement fiable des trois identités
   CRM et les brouillons/envois à approbation explicite. Puis tester les alias,
   SPF/DKIM/DMARC et le placement sur des boîtes témoins autorisées.
7. La bascule MX nécessite toutes ces preuves de continuité; elle n'est pas
   autorisée par un simple statut OAuth `connected`.

## Références

### Pièges de compatibilité vérifiés le 14 octobre 2026

- Le workerd utilisé avec la date de compatibilité `2026-09-11` rejette
  `redirect: "error"` avant tout appel réseau. Utiliser `manual` et refuser
  explicitement toute réponse 300–399 **avant** de lire son corps, sans suivre
  `Location`. Le test OAuth exerce réellement la construction de Request dans
  workerd, en plus des tests de non-suivi des redirections.
- D1 peut inclure les écritures des triggers dans `meta.changes`. La rotation
  ou la déconnexion modifie la connexion et déclenche aussi le nettoyage :
  ce compteur ne prouve donc pas qu'une seule ligne principale a été modifiée.
  L'accusé d'un UPDATE doit vérifier sa ligne `RETURNING`, en conservant les
  prédicats CAS et les transactions. `changes()` dans SQL conserve son sens
  distinct et ne doit pas être remplacé aveuglément par le compteur D1.
- Les diagnostics de connexion ne journalisent que des catégories fixes et
  des codes numériques explicitement autorisés. Ne jamais ajouter de corps
  Microsoft, d'exception brute, de jeton ou de secret aux journaux.

Ces contrôles concernent la connexion OAuth et sa récupération, pas encore
le transport des messages. Voir aussi la définition du compteur dans
la [documentation D1](https://developers.cloudflare.com/api/resources/d1/).

### Protocoles et stockage

- [Flux Microsoft code + PKCE, form_post](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow).
- [Claims d'identité Microsoft](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).
- [Refresh tokens et révocation](https://learn.microsoft.com/en-us/entra/identity-platform/refresh-tokens).
- [Préconditions R2](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/).
