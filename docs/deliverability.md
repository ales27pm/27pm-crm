# Exploitation de la délivrabilité Mailgun pour 27PM

## Objet, portée et règle de preuve

Ce document transforme les recommandations générales de délivrabilité en un
runbook adapté au domaine `27pm.org` et au CRM actuel. Il décrit les contrôles,
les seuils d'enquête, les preuves à conserver et les portes de changement. Il
n'autorise à lui seul aucun envoi, changement DNS, changement Mailgun,
inscription auprès d'un fournisseur, achat d'option, migration de domaine ou
déploiement.

L'état DNS ci-dessous correspond à l'audit public rafraîchi le
**12 septembre 2026**.
Le DNS, le compte Mailgun, les pools partagés et les politiques des fournisseurs
peuvent changer. Toute exécution doit donc refaire les contrôles en direct et
conserver l'heure UTC, la source observée et le résultat. Une ancienne capture
d'écran ou un ancien résultat de test ne constitue pas une preuve actuelle.

Les termes ont ici un sens strict :

- **accepté par Mailgun** signifie que Mailgun a accepté la demande d'envoi;
- **accepté par le serveur destinataire** signifie que le serveur MX a répondu
  positivement au transfert SMTP;
- **placé en boîte de réception**, **placé en indésirable** et **mis en
  quarantaine** sont des observations distinctes qui exigent une boîte test ou
  une preuve du fournisseur destinataire;
- ni un événement Mailgun `accepted`, ni un événement `delivered`, ni une
  réponse SMTP `250` ne prouve la boîte de réception ou la lecture.

## État actuel audité

### DNS et domaine d'envoi

L'audit public du 12 septembre 2026 a établi les faits suivants à partir du
dépôt, des résolveurs Cloudflare et Google et d'une validation TLS directe :

| Surface | État observé | Décision opérationnelle |
| --- | --- | --- |
| Domaine Mailgun | `27pm.org` est le domaine actuellement utilisé par le CRM | Ne pas changer le domaine de transport sans migration approuvée et testée |
| MX à l'apex | L'apex publie les deux MX Mailgun attendus, `mxa.mailgun.org` et `mxb.mailgun.org` | Ne jamais les remplacer ou les fusionner à l'aveugle; vérifier d'abord tous les usages de réception |
| SPF à l'apex | Un seul enregistrement SPF logique est publié et il contient `include:mailgun.org` | Préserver l'unicité; intégrer toute future source dans le même SPF après analyse de la limite de recherches DNS |
| DKIM public | `pdk1` et `pdk2` sont deux CNAME Mailgun dont les cibles publient actuellement des clés RSA de 2048 bits | Préserver les deux alias; vérifier dans le compte l'état ASS/rotation et sur un message reçu le sélecteur réellement utilisé |
| Domaine de suivi | `email.27pm.org` est un CNAME vers `mailgun.org`, mais son endpoint HTTPS présente un certificat valable seulement pour `mailgun.org`; la validation du hostname `email.27pm.org` échoue | Le CRM désactive le tracking, donc ce défaut n'est pas sur son chemin actuel; corriger/provisionner le certificat avant toute activation et auditer les autres émetteurs ou anciens liens |
| DMARC | `_dmarc.27pm.org` applique `p=reject` avec `adkim=s` et `aspf=s` | Ne pas régresser vers `p=none` ou un alignement relâché pour simplifier une migration |

Les deux clés publiques de 2048 bits et la topologie à deux CNAME sont
compatibles avec **Automatic Sender Security**, mais le DNS public ne prouve ni
que l'option est active dans le compte, ni sa cadence de rotation, ni le
sélecteur appliqué au message. Ces points et le placement en Inbox doivent être
vérifiés séparément dans le compte Mailgun et sur un message réellement reçu.

Le DMARC actuel demande des rapports agrégés et forensiques à Mailgun et
OnDMARC. Leur publication ne prouve pas que les fournisseurs les transmettent;
elle crée néanmoins une dépendance de traitement, d'accès, de conservation et
de confidentialité à inventorier avant de modifier les destinataires `rua` ou
`ruf`.

### Contrôles déjà présents dans le CRM

Le CRM actuel est un outil d'approche manuelle, pas une plateforme de campagne
de masse. Son contrat local fournit déjà :

- un seul destinataire par commande d'envoi;
- une confirmation opérateur et une autorisation de conformité réévaluée juste
  avant le transport;
- un `From:` et un `Reply-To:` limités aux identités autorisées de `27pm.org`;
- DKIM demandé explicitement à Mailgun;
- le suivi des ouvertures et des clics explicitement désactivé;
- une partie texte garantie et, dans le flux UI actuel qui transmet du texte,
  une partie HTML toujours générée de manière sûre par échappement du contenu;
- un pied de page visible et des en-têtes RFC 8058
  `List-Unsubscribe`/`List-Unsubscribe-Post` pour les messages de prospection;
- un endpoint one-click HTTPS authentifié, idempotent et sans connexion;
- des webhooks Mailgun signés, bornés, frais et résistants au rejeu;
- la conservation des événements par message et la création de suppressions
  locales uniquement sur hard bounce explicite, plainte ou désabonnement;
- des suppressions locales immuables qui bloquent les futures autorisations.

Le tableau de bord local agrège maintenant le transport par fournisseur et
expose les autres dimensions dans son API. Ces contrôles ne remplacent pas un
audit en direct des suppressions conservées dans Mailgun, une mesure d'Inbox
placement ou les outils de réputation externes.

Pour garder cette agrégation bornée, le rapport retient au plus 32 tags sûrs
par message et 256 segments de tags, dans un ordre déterministe. Les champs
`messagesWithTagTruncation` et `tagSegmentsTruncated`, également affichés dans
l'avertissement du tableau de bord, rendent toute troncature explicite; une vue
tronquée ne doit pas être interprétée comme un rapport exhaustif.

## Décision d'architecture : conserver l'apex pour l'instant

Un sous-domaine Mailgun dédié est une bonne architecture lors d'une nouvelle
installation, mais `27pm.org` n'est plus une installation vierge. Le domaine
est déjà en production, reçoit à l'apex par Mailgun et applique DMARC avec un
alignement strict. Une migration immédiate vers `mail.`, `tx.` ou `news.` ferait
changer plusieurs variables à la fois et pourrait casser :

- la réception à l'apex;
- l'alignement strict entre le domaine visible, le domaine DKIM et le domaine
  d'enveloppe;
- les réponses et le fil des conversations;
- les routes Mailgun et les webhooks;
- les liens de désabonnement déjà émis;
- la réputation de domaine en cours de construction;
- l'attribution de la cause si la délivrabilité évolue.

La politique DMARC actuelle est plus forte que le point de départ `p=none`
souvent recommandé à un nouveau domaine. Il ne faut pas la diminuer simplement
pour suivre un exemple générique. Toute évolution doit conserver une protection
équivalente et prouver l'alignement exact sur des messages réels.

### Quand envisager une séparation `tx` / `news`

La séparation ne devient pertinente que si au moins un de ces besoins est
documenté :

- un trafic transactionnel automatisé distinct de la prospection;
- un programme marketing consenti avec volume, cadence et désabonnement
  propres;
- des équipes ou systèmes indépendants qui exigent des clés, webhooks et
  responsabilités distincts;
- un incident démontrant qu'une classe de trafic dégrade l'autre;
- un volume suffisant pour mesurer chaque classe séparément.

Le modèle cible éventuel serait :

```text
27pm.org             identité organisationnelle et réception actuelle
tx.27pm.org          transactionnel demandé par l'utilisateur
news.27pm.org        marketing explicitement consenti
```

Ce dessin n'est pas une instruction de migration. Chaque branche doit franchir
les portes suivantes.

### Portes obligatoires d'une future migration

1. **Inventaire et nécessité**
   - recenser toutes les sources qui utilisent actuellement `27pm.org`;
   - mesurer le volume quotidien et hebdomadaire, sa régularité et les
     fournisseurs destinataires;
   - définir le propriétaire de `tx` et de `news`, le fondement des envois et le
     mécanisme d'arrêt;
   - obtenir l'approbation explicite du changement DNS, Mailgun, applicatif et
     DMARC.

2. **Choix d'alignement avant le DNS**
   - avec `adkim=s` et `aspf=s`, un `From:` à l'apex n'est pas automatiquement
     aligné avec une signature ou une enveloppe sur un sous-domaine;
   - choisir soit un domaine visible exactement aligné avec le sous-domaine,
     soit une méthode Mailgun démontrée qui signe avec le domaine visible exact;
   - ne pas relâcher `adkim` ou `aspf` globalement sans analyse des autres
     expéditeurs et approbation de sécurité;
   - confirmer le comportement de l'adresse de rebond et des réponses.

3. **Création Mailgun sans copier d'exemple**
   - créer le sous-domaine dans le compte appartenant à 27PM;
   - activer Automatic Sender Security seulement si l'option et le contrat
     affichés dans ce compte ont été vérifiés;
   - copier les **deux CNAME DKIM, sélecteurs et cibles exacts générés par le
     compte**; ne jamais reprendre une cible de tutoriel;
   - confirmer dans l'interface la taille de clé, l'état de vérification et la
     politique de rotation; ne pas présumer une valeur historique;
   - publier un SPF unique au nouvel hostname et vérifier la profondeur totale
     des recherches SPF;
   - ajouter les MX seulement si Mailgun doit réellement recevoir sur ce
     sous-domaine;
   - n'ajouter un CNAME de suivi que si le suivi est explicitement approuvé.

4. **Vérification DNS et authentification**
   - interroger au moins deux résolveurs indépendants;
   - utiliser la vérification Mailgun du domaine;
   - attendre la propagation effective, pas seulement l'expiration théorique du
     TTL;
   - recevoir des graines Gmail, Microsoft et Yahoo;
   - vérifier sur chaque message `spf=pass`, `dkim=pass`, `dmarc=pass`, le
     domaine `header.from`, le domaine `header.d`, le domaine d'enveloppe et le
     sélecteur attendu;
   - vérifier qu'aucune autre source légitime n'a commencé à échouer sous
     `p=reject`.

5. **Canari et montée contrôlée**
   - conserver le trafic existant inchangé pendant le canari;
   - déplacer une seule classe, un seul template et une petite cohorte saine;
   - ne pas changer simultanément domaine, IP, contenu, cadence et audience;
   - comparer une fenêtre avant/après par fournisseur;
   - arrêter la montée sur plainte, hard bounce, blocage de politique ou hausse
     anormale des échecs temporaires.

6. **Bascule et retour arrière**
   - définir à l'avance le point d'arrêt, le propriétaire et le chemin de retour;
   - conserver les anciens DNS et routes pendant la fenêtre nécessaire à la
     livraison et aux réponses;
   - revenir d'abord au domaine applicatif précédent en cas d'incident; ne pas
     supprimer immédiatement les preuves DNS;
   - confirmer après retour l'authentification, la réception, les webhooks et le
     désabonnement.

## Politique de suivi et de contenu

### Aucun pixel ou suivi de clic dans le trafic actuel

Le CNAME `email.27pm.org` existe, mais le CRM désactive aujourd'hui le tracking
d'ouvertures et de clics. Le DNS seul ne prouve pas qu'un pixel est injecté et
ne constitue pas une autorisation pour en activer un.

Au 12 septembre 2026, HTTPS sur ce hostname échoue la validation stricte du
certificat : le certificat présenté couvre `mailgun.org`, pas
`email.27pm.org`. Le défaut est dormant pour le flux CRM actuel, mais il peut
affecter un autre émetteur, un ancien message ou une future réécriture de lien.
Une activation du tracking est interdite tant que Mailgun n'a pas confirmé le
`web_scheme`, le certificat personnalisé et un canari HTTPS valide.

La politique actuelle est donc :

- aucune activation implicite du tracking dans Mailgun;
- aucune mesure d'ouverture, aucun ratio texte/image et aucune liste de mots
  utilisés comme preuve d'engagement ou garantie d'Inbox;
- priorité aux réponses, demandes entrantes, achats, rendez-vous et activité
  applicative vérifiable;
- conservation du CNAME jusqu'à une analyse de dépendances et un changement DNS
  séparément approuvé;
- avant toute activation future : examen de confidentialité, minimisation,
  information des destinataires, durée de conservation, accès, sous-traitants
  et test du message reçu.

### Construction du message

Pour chaque message :

- envoyer systématiquement `text/plain` et HTML : le flux UI actuel transmet le
  texte, puis le serveur génère toujours un HTML minimal en l'échappant et ajoute
  le pied de conformité échappé. L'API accepte aussi un HTML déjà fourni et le
  conserve; cette branche n'est pas un assainisseur HTML et ne doit être ouverte
  qu'à un producteur de contenu approuvé;
- garder le domaine des liens cohérent avec 27PM et éviter les raccourcisseurs
  opaques;
- laisser Mailgun produire un `Message-ID` valide sauf besoin documenté;
- conserver un `From:` lisible, un `Reply-To:` exact et une identité postale et
  de contact complète;
- inclure un lien de désabonnement visible sur la prospection;
- inclure `List-Unsubscribe` et
  `List-Unsubscribe-Post: List-Unsubscribe=One-Click`;
- tester le endpoint one-click sans exiger une connexion et confirmer que la
  suppression est immédiatement effective;
- vérifier sur le message reçu que la signature DKIM couvre les deux en-têtes
  de désabonnement dans la liste `h=`;
- limiter images, liens et pièces jointes à ce qui sert directement le message.

### Tags Mailgun

Le CRM émet déjà deux tags stables pour chaque message de prospection :
`traffic-prospecting` et `source-crm`. `lib/mailgun-message.ts` accepte au plus
trois tags, impose le kebab-case en minuscules, refuse les doublons et plusieurs
formes de données personnelles, puis les transmet comme `o:tag`. Les messages,
Events et agrégats locaux conservent cette taxonomie.

Convention recommandée :

```text
traffic-prospecting
source-crm
template-v1
```

`template-v1` illustre le troisième emplacement disponible; il ne doit être
ajouté que lorsqu'une version de template réelle et stable existe. Un
identifiant de stratégie interne ne doit être envoyé à Mailgun que s'il est
opaque et si sa conservation externe a été approuvée. Les tags servent à
l'agrégation; ils ne donnent aucune autorisation d'envoi.

## Consentement, listes et suppressions

### Admission d'une adresse

Avant tout envoi, la preuve doit établir :

- la provenance exacte de l'adresse et sa date de collecte;
- le consentement ou le fondement applicable, sa portée et son échéance;
- la pertinence du message pour le rôle du destinataire;
- l'absence de refus, plainte, désabonnement, hard bounce ou blocage interne;
- l'identité de l'expéditeur et un moyen de contact valide;
- la confirmation humaine requise par le CRM.

Sont interdits : listes achetées, louées ou aspirées; import massif de dormants;
réactivation silencieuse; suppression d'une plainte ou d'un désabonnement pour
« essayer encore »; nouvelle adresse déduite sans preuve; envoi à une liste dont
le consentement ne peut être démontré.

Le double opt-in est le standard à retenir pour toute future liste d'abonnement.
Le CRM de prospection actuel reste limité aux messages individuels qualifiés.

### Traitement par type de signal

Dans ce runbook, une **suppression fournisseur explicite** désigne uniquement :
un hard bounce identifié par un événement bounce ou une raison Mailgun de
bounce, une plainte, ou un désabonnement. Un échec permanent générique, un
blocage de politique ou de réputation et un échec d'authentification ne créent
pas de suppression destinataire; ils déclenchent une enquête opérationnelle.

| Signal | Action immédiate | Réutilisation permise |
| --- | --- | --- |
| Désabonnement | Suppression globale ou de catégorie selon la demande; annuler les actions ouvertes | Seulement après un nouveau consentement explicite, vérifiable et juridiquement valide, dans un nouveau dossier contrôlé |
| Plainte spam | Suppression globale immédiate; arrêter toute séquence | Ne pas retirer la suppression pour retester |
| Hard bounce / adresse inexistante | Suppression immédiate de l'adresse exacte; corriger la source | Seulement après preuve indépendante qu'une nouvelle adresse valide appartient au destinataire |
| Échec permanent de politique/réputation | Mettre en attente et analyser le code SMTP, le domaine, l'IP et le fournisseur | Ne pas l'étiqueter automatiquement comme adresse inexistante |
| Échec temporaire | Laisser Mailgun gérer ses reprises; réduire la cadence si le signal augmente | Ne pas renvoyer manuellement pendant les reprises |
| Refus direct ou réponse négative | Enregistrer le refus et arrêter les actions | Respecter exactement la portée exprimée |

### Audit croisé des suppressions

Avant une série d'envois et au minimum chaque semaine pendant le faible volume
actuel :

1. exporter en lecture seule les bounces, plaintes et désabonnements Mailgun;
2. paginer jusqu'à la fin; ne pas supposer que la première page est exhaustive;
3. comparer les trois listes aux suppressions locales, sans exposer les adresses
   dans un journal général;
4. ajouter localement tout signal fournisseur manquant avec sa provenance et
   son horodatage;
5. enquêter sur tout signal local absent de Mailgun sans supprimer le blocage
   local;
6. confirmer qu'un contact supprimé échoue au contrôle avant transport;
7. conserver un résumé chiffré et haché; protéger ou détruire l'export détaillé
   selon la politique de conservation.

La consultation des suppressions nécessite un accès Mailgun de lecture plus
large que la clé d'envoi limitée du CRM. Cet accès doit rester dans une session
opérateur temporaire; il ne doit pas devenir un secret permanent du runtime.

## Événements et diagnostic

### Journal minimal par message

Pour une enquête, conserver dans une zone privée :

- heure UTC;
- domaine d'envoi et domaine visible;
- identifiant Mailgun et `Message-ID`;
- adresse ou domaine destinataire selon le niveau d'accès;
- IP ou pool d'envoi observé;
- type d'événement et sévérité;
- code et texte SMTP;
- raison Mailgun, y compris les signaux de politique tels qu'`espblock`;
- tags non personnels;
- résultat SPF, DKIM, DMARC et authentification composite fourni par la boîte;
- placement observé : Inbox, autre onglet, Junk, quarantaine, absent ou inconnu.

Les identifiants, adresses et en-têtes complets restent des données
opérationnelles sensibles. Ils vont dans le dossier privé de l'incident, pas
dans un ticket public, une capture partagée ou les logs du navigateur.

### Audit Events

Le dépôt fournit `scripts/audit-mailgun-deliverability.mjs`, un CLI GET-only qui
borne la fenêtre à 31 jours, la taille et le nombre de pages, refuse une origine
ou pagination inattendue, agrège les Events sans sortir les adresses et compte
les listes Mailgun de bounces, plaintes et désabonnements. Son exécution contre
le compte réel reste une porte externe : injecter l'accès dans la session,
confirmer le domaine et la région, puis consulter d'abord l'aide avec
`node scripts/audit-mailgun-deliverability.mjs --help`.

Compléter cet audit avec les Logs Mailgun pour les recherches privées par
destinataire, sujet ou `Message-ID`. Réaliser au minimum :

- échecs temporaires et permanents sur la fenêtre;
- codes SMTP regroupés par domaine destinataire;
- plaintes et hard bounces;
- IP/pool et domaine d'envoi;
- événements manquants ou webhooks en erreur;
- comparaison des compteurs Events avec les messages locaux.

Un webhook manquant n'autorise pas un nouvel envoi. Réconcilier d'abord l'état
depuis Mailgun afin d'éviter un doublon après un résultat ambigu.

## Surveillance segmentée et seuils

### Axes obligatoires

Toute vue quotidienne ou hebdomadaire doit permettre :

```text
domaine d'envoi
  -> classe de trafic
    -> fournisseur destinataire
      -> IP ou pool
        -> tag/template
```

Afficher toujours le numérateur, le dénominateur et la fenêtre, pas seulement
un pourcentage. Au faible volume actuel, un seul événement peut produire un
taux spectaculaire; le signal individuel reste important, mais une tendance
statistique n'est pas établie. Aucune décision automatique de changement d'IP
ne doit reposer sur une fenêtre trop petite.

Les domaines grand public connus peuvent être regroupés prudemment sous Gmail,
Microsoft ou Yahoo. Un domaine d'entreprise personnalisé ne doit pas être
attribué à un fournisseur sans preuve MX actuelle.

L'API opérateur `GET /api/admin/deliverability?window=24h|7d|30d` calcule déjà
des messages uniques par fournisseur, domaine d'envoi, IP, classe de trafic et
tag, avec numérateur, dénominateur et état `insufficient_data`. Le panneau
`app/components/deliverability-panel.tsx`, intégré à la vue de travail, affiche
actuellement la synthèse et le tableau par fournisseur; les autres axes restent
disponibles dans l'API pour une enquête contrôlée.

### Grille d'alerte

Les lignes marquées **fournisseur** reprennent une limite publique citée dans
l'analyse source. Les lignes marquées **interne** sont des seuils conservateurs
pour ouvrir une enquête; elles ne sont pas des garanties ni des règles
universelles.

| Métrique | Cible | Avertissement | Critique / action | Nature |
| --- | ---: | ---: | ---: | --- |
| Plaintes visibles dans Mailgun | `< 0,05 %` | `>= 0,05 %` | `>= 0,10 %`: pause et enquête | Interne; Mailgun recommande de rester sous `0,10 %` |
| Spam rate Gmail | `< 0,10 %` | `>= 0,10 %` | `>= 0,30 %`: niveau à ne jamais atteindre | Fournisseur Google |
| Plaintes Yahoo bulk | idéalement `< 0,10 %` | `>= 0,10 %` | `>= 0,30 %`: hors exigence bulk | Fournisseur Yahoo |
| Hard bounce | `< 1 %` | `>= 1 %` | `>= 2 %`: pause et nettoyage | Interne |
| Delivery SMTP | `>= 98 %` | `< 98 %` | `< 95 %`: enquête immédiate | Interne; ne mesure pas l'Inbox |
| Échec temporaire | baseline stable | `> 2 x` baseline | `> 5 %` soutenu ou concentré chez un fournisseur | Interne |
| `espblock` | environ `0` | toute hausse inhabituelle | hausse persistante chez un fournisseur | Interne |
| DMARC aligné | `> 99,5 %` | `< 99 %` | `< 98 %`: auditer les sources | Interne |
| Désabonnement | baseline propre au flux | `> 2 x` baseline | hausse avec plaintes: revoir cible et fréquence | Interne |
| Blocklist reconnue | aucune | nouvelle entrée | Spamhaus ou rejet SMTP associé: traiter la cause | Interne |

À faible volume :

- ne pas masquer une plainte ou un hard bounce parce que le dénominateur est
  petit;
- ne pas prétendre qu'un taux de `0 %` prouve une bonne réputation;
- comparer les comptes absolus et les messages individuels;
- indiquer « données insuffisantes » lorsqu'un fournisseur ne produit pas de
  métrique;
- séparer l'absence de données de la valeur zéro.

### Alertes

Configurer dans Mailgun, lorsque le forfait et le volume le permettent, des
alertes séparées par domaine et fournisseur pour plainte, delivery, hard bounce
et échec temporaire. Les alertes sont une détection, pas une remédiation
automatique. Leur destination doit appartenir à 27PM, être protégée et faire
l'objet d'une procédure d'astreinte adaptée au faible volume.

## IP partagée, cadence et récupération

### Décision actuelle

Le trafic actuel utilise un pool partagé. Il n'y a donc pas d'IP dédiée à
chauffer. Il reste nécessaire de bâtir et protéger la réputation du domaine.

Ne pas demander une IP dédiée tant que ces preuves ne sont pas réunies :

- volume élevé, régulier et durable;
- segmentation et métriques fiables par fournisseur;
- liste et consentement propres;
- capacité opérationnelle de warm-up et de surveillance quotidienne;
- télémétrie Mailgun indiquant qu'une isolation est utile;
- coût, propriétaire, rollback et plan d'incident approuvés.

Les ordres de grandeur de volume publiés par un fournisseur sont des
heuristiques, pas un déclencheur automatique. Une IP dédiée sous-utilisée peut
être plus difficile à réputationaliser qu'un bon pool partagé.

### Tiers d'audience

Pendant une récupération ou le warm-up d'un futur domaine :

| Tier | Preuve acceptable sans pixel | Action |
| --- | --- | --- |
| A | demande entrante, réponse récente, achat, rendez-vous ou activité explicite récente | Commencer ici |
| B | relation et consentement valides avec activité récente moins forte | Ajouter seulement si le Tier A reste propre |
| C | ancien engagement réel, preuve encore valide | Réintroduire lentement après stabilité |
| Dormant | aucune activité récente ou preuve devenue incertaine | Arrêt; ne pas réactiver pendant la récupération |

L'ouverture n'est pas disponible dans la politique actuelle et ne doit pas être
inventée. Les réponses et actions réelles ont priorité.

### Montée graduelle

La formule `plancher(100 × 1,2^(jour−1))` est réservée au mode futur
`dedicated_ip_warmup`; `lib/deliverability-policy.ts` ne la retourne dans aucun
autre mode. Elle reste un plafond manuel, jamais une cible de trafic. Une montée
de réputation du domaine sur le pool partagé doit utiliser un plafond décidé à
partir du volume naturel du Tier A et des preuves observées, sans formule
automatique et sans trafic fabriqué.

À chaque palier :

1. conserver la cadence prévisible;
2. examiner séparément Gmail, Microsoft, Yahoo et les MX d'entreprise;
3. ne monter que si plaintes, hard bounces, échecs temporaires et `espblock`
   restent propres;
4. geler ou réduire sur anomalie;
5. attendre une fenêtre interprétable avant le palier suivant;
6. repousser toute campagne de réengagement après la stabilisation.

Une campagne de réengagement doit être courte, explicite, réservée à un ancien
engagement démontré et se terminer par un sunset définitif en l'absence de
reconfirmation.

## Outils externes, propriété et confidentialité

| Outil | Propriétaire attendu | Usage | Porte de confidentialité et d'exécution |
| --- | --- | --- | --- |
| Mailgun Logs, Events et Metrics | Opérateur Mailgun 27PM | Événement, SMTP, tendance, IP/pool et suppressions | Accès en lecture minimale; exports privés et bornés |
| Mailgun Send Alerts | Opérateur Mailgun 27PM | Alertes par domaine, pool et fournisseur | Revoir destinataires, seuils et bruit avant activation |
| Google Postmaster Tools | Propriétaire DNS/Google 27PM | Réputation et spam Gmail si le volume produit des données | Vérification du domaine séparément approuvée; accès nominatif minimal |
| Yahoo Sender Hub / CFL | Propriétaire DNS et messagerie 27PM | Plaintes Yahoo et signaux bulk | Inscription et sélecteurs vérifiés; ne pas exposer de données destinataire |
| Signaux Microsoft sur pool partagé | Mailgun, avec demande de 27PM | Réputation du pool, blocages ou anomalies Microsoft | Fournir seulement les identifiants nécessaires dans un ticket privé; Mailgun contrôle le pool |
| Spamhaus Reputation Checker | Responsable délivrabilité | Listes reconnues pour IP et domaine | Vérifier la cause et la réponse SMTP avant tout delisting |
| MXToolbox | Responsable délivrabilité | Détection large de blocklists et DNS | Un résultat agrégé n'est pas une preuve d'usage par un fournisseur |
| Analyseur DMARC spécialisé | Responsable sécurité/domaine | Agrégation `rua`, sources et alignement | Les rapports contiennent des métadonnées d'envoi; contrat, accès, rétention et localisation à approuver |
| Email on Acid ou équivalent | Responsable contenu | Rendu client et vérification du template | Utiliser des données synthétiques; ne pas téléverser un message client ou une liste réelle sans autorisation |

L'absence de données dans Postmaster, Yahoo ou Mailgun n'est pas un résultat
positif. Inscrire « indisponible » ou « volume insuffisant ».

## Matrice de graines et validation des en-têtes

Le test minimum avant/après un changement comporte des boîtes contrôlées chez :

| Fournisseur | Placement à relever | En-têtes à relever | État |
| --- | --- | --- | --- |
| Gmail | Inbox, Promotions/Autre, Spam, absent | SPF, DKIM, DMARC, domaine/signataire, identifiant | Une graine contrôlée existe; refaire en direct |
| Microsoft grand public | Inbox, Junk, quarantaine/absent | SPF, DKIM, DMARC, authentification composite, classification disponible | À maintenir comme preuve spécifique Microsoft |
| Yahoo | Inbox, Spam, absent | SPF, DKIM, DMARC, identifiant | À établir avant une hausse de volume |
| MX dominant d'une audience réelle | Inbox, quarantaine, rejet, absent | authentification, code SMTP et règle locale si disponible | Seulement avec une boîte autorisée et pertinente |

Chaque envoi de graine exige une confirmation opérateur explicite. Utiliser un
objet unique, ne pas réutiliser un ancien résultat et ne pas automatiser les
envois sans mandat distinct.

Fiche de preuve :

```text
Heure UTC :
Changement testé :
Classe de trafic :
Domaine visible / domaine Mailgun :
IP ou pool observé :
Fournisseur destinataire :
Message-ID privé :
Mailgun accepted : oui/non/inconnu
Serveur destinataire accepté : oui/non/inconnu
Placement : Inbox/Autre/Junk/Quarantaine/Absent/Inconnu
SPF :
DKIM : domaine, sélecteur, résultat
DMARC : politique, alignement, résultat
DKIM h= couvre List-Unsubscribe : oui/non/non applicable
DKIM h= couvre List-Unsubscribe-Post : oui/non/non applicable
Capture/en-tête stocké dans : emplacement privé
```

Un bon résultat Gmail n'extrapole pas Microsoft ou Yahoo. Une classification
Junk isolée ne prouve pas non plus que l'IP partagée en est la cause.

## Procédure d'incident de délivrabilité

1. **Contenir** : suspendre le segment, template ou fournisseur touché; ne pas
   relancer manuellement les résultats ambigus.
2. **Horodater** : définir la première et la dernière observation UTC.
3. **Classer** : distinguer refus Mailgun, refus SMTP, acceptation SMTP avec
   Junk, quarantaine ou absence.
4. **Segmenter** : domaine d'envoi, classe, fournisseur, IP/pool, tag et
   template.
5. **Authentifier** : contrôler SPF, DKIM, DMARC et alignement sur le message
   reçu.
6. **Auditer l'audience** : provenance, consentement, plaintes, suppressions,
   bounces et dormance.
7. **Lire la réponse réelle** : code SMTP, texte, `espblock`, throttling et
   blocklist explicitement nommée.
8. **Comparer les outils** : Mailgun, graines, Postmaster/Sender Hub si des
   données existent, Spamhaus puis agrégateur large.
9. **Formuler une hypothèse unique** : contenu, domaine, cadence, audience,
   configuration ou pool; distinguer le fait de l'inférence.
10. **Changer une variable** : conserver toutes les autres constantes et définir
    le critère de succès et de retour arrière.
11. **Répéter la matrice de graines** : mêmes fournisseurs, fenêtre comparable,
    nouveaux identifiants.
12. **Reprendre graduellement** : Tier A seulement, puis élargissement contrôlé.
13. **Clore** : consigner cause démontrée, actions, preuves, limites et mesures
    préventives.

Pour une IP partagée, transmettre à Mailgun dans un canal privé l'heure UTC, le
fournisseur, l'IP observée, le résultat SMTP et l'identifiant strictement
nécessaire. Demander une conclusion fondée sur la télémétrie du pool. Ne pas
présenter un changement de pool comme une garantie.

## Discipline de changement

Pendant toute remédiation :

- une seule variable matérielle change par expérience;
- chaque changement possède un propriétaire, une approbation, une fenêtre, une
  baseline, un critère de succès et un rollback;
- DNS, DMARC, domaine Mailgun, pool/IP, template, cadence et audience sont des
  variables distinctes;
- les anciennes valeurs et preuves sont conservées dans le dossier privé;
- aucune suppression ou plainte n'est effacée pour embellir les métriques;
- aucune conclusion n'est généralisée d'un fournisseur à un autre;
- aucune reprise n'est annoncée avant vérification des webhooks, suppressions,
  graines et contrôles de conformité.

## Matrice exhaustive des actions P0 / P1 / P2

Légende : **observé** = vérifié à la frontière indiquée le 12 septembre 2026;
**déployé** = code présent dans l'artefact de production Sites version 23 issu
du commit `54c4413`, sans présumer que chaque branche a été exercée;
**vérifié en production** = comportement directement sondé sur cette version;
**partiel** = preuve locale ou publique présente mais frontière externe encore
manquante; **différé** = non justifié dans la portée actuelle; **porte externe**
= exige accès, propriété et approbation hors dépôt. Cette matrice n'attribue
aucune configuration interne Mailgun, inscription fournisseur ou émission de
graine qui n'a pas été directement observée.

| Priorité | Recommandation | Statut 27PM au 2026-09-12 | Action / critère de sortie |
| --- | --- | --- | --- |
| P0 | Identifier domaine Mailgun et `From:` visible | **Observé + implémenté dans le dépôt** | `27pm.org` est audité; `app/api/messages/send/route.ts` et `lib/mailgun-message.ts` bornent l'identité. Revalider le message reçu avant tout changement |
| P0 | Éviter deux SPF au même hostname | **Observé** | Un SPF logique avec `include:mailgun.org`; aucun changement DNS exécuté. Recontrôler après toute source ajoutée |
| P0 | SPF sur messages réels | **Historique Microsoft seulement** | Le spécimen Outlook/Hotmail du 2 septembre 2026 rapporte `spf=pass`; refaire un canari actuel et compléter Gmail/Yahoo avant toute conclusion multi-fournisseur |
| P0 | DKIM 2048 et Automatic Sender Security | **DKIM public observé + porte compte/message** | `pdk1` et `pdk2` délèguent à deux clés RSA de 2048 bits et `lib/mailgun-message.ts` impose `o:dkim=yes`; l'état ASS, la rotation, le sélecteur actif et `dkim=pass` exigent encore le compte et un message reçu |
| P0 | DMARC d'observation initial | **Observé au niveau final** | `_dmarc.27pm.org` applique déjà `p=reject; adkim=s; aspf=s`; ne pas régresser et ne modifier aucun DNS sans porte de changement |
| P0 | Alignement SPF/DKIM/DMARC | **Historique Microsoft seulement** | Le spécimen Outlook/Hotmail du 2 septembre 2026 rapporte SPF, DKIM, DMARC et `compauth` en réussite, mais un placement Junk avec `SCL: 6`; obtenir les domaines exacts et un résultat actuel sur Gmail, Microsoft et Yahoo |
| P0 | Exporter Events, bounces, plaintes et désabonnements | **CLI implémenté; lecture réelle non exécutée** | `scripts/audit-mailgun-deliverability.mjs` effectue des GET bornés, paginés et agrégés; `tests/mailgun-audit-script.test.mjs` couvre origine, bornes, pagination et schémas. L'accès compte reste externe |
| P0 | Respecter les suppressions partout | **Code déployé; blocage production non exercé; réconciliation fournisseur non exécutée** | Le pré-transport de `app/api/messages/send/route.ts` bloque les tombstones; `lib/mailgun-event-reconciliation.ts` les crée idempotemment à partir des trois signaux explicites. Les migrations D1 sont appliquées; la production comptait 19 Events et aucun lien Event-vers-message cassé lors du contrôle. Rapprocher un export Mailgun séparément, puis vérifier le blocage sans émettre de message |
| P0 | Distinguer hard bounce et rejet de politique | **Implémenté et testé dans le dépôt** | `lib/deliverability-policy.ts`, `lib/mailgun-event-metadata.ts` et `lib/mailgun-lifecycle.ts` séparent bounce, politique, authentification et autres permanents; `tests/mailgun-event-reconciliation.test.mjs` prouve qu'un rejet de politique ne supprime pas l'adresse |
| P0 | Zéro liste achetée/louée | **Politique actuelle** | Le flux reste individuel et soumis aux preuves de provenance/conformité; aucun import de liste n'est autorisé par ce runbook |
| P0 | Stopper dormants massifs et pics | **Contrôle opérateur; pas de quota automatique** | `app/api/messages/send/route.ts` accepte un destinataire et réévalue l'autorisation. Aucun plafond quotidien, détecteur de pic ou filtre d'inactivité serveur n'est inventé sans volume et baseline approuvés; les Tiers et la cadence restent une décision humaine explicite |
| P0 | Multipart texte + HTML | **Implémenté et testé dans le dépôt** | Le flux UI texte passe par `lib/unsubscribe.ts`, qui retourne toujours texte et HTML et génère le HTML minimal avec échappement; `lib/mailgun-message.ts` transmet les deux. Un HTML API fourni reste à la charge d'un producteur approuvé. Couverture dans `tests/compliance-policy.test.mjs` et `tests/mailgun-message.test.mjs` |
| P0 | One-click et lien visible | **Implémenté dans le dépôt; réception à vérifier** | `lib/unsubscribe.ts`, `lib/mailgun-message.ts` et `app/api/public/unsubscribe/route.ts` fournissent lien, headers et effet idempotent. Vérifier le MIME reçu et la couverture DKIM `h=` |
| P0 | Message-ID valide | **Comportement fournisseur à vérifier** | Le CRM laisse Mailgun le générer; conserver l'identifiant réellement reçu dans la preuve privée |
| P0 | Ne pas confondre `delivered` et Inbox | **Implémenté dans API et UI** | `lib/mailgun-lifecycle.ts`, `GET /api/admin/deliverability` et `app/components/deliverability-panel.tsx` indiquent explicitement remise SMTP et placement inconnu; tests dans `tests/mailgun-lifecycle.test.mjs` et `tests/deliverability-route.test.mjs` |
| P1 | Google Postmaster Tools | **Porte externe** | Domaine vérifié par le propriétaire; accès minimal; indiquer volume insuffisant si aucune donnée |
| P1 | Yahoo Sender Hub / CFL | **Porte externe** | Inscription et signaux vérifiés avant trafic bulk Yahoo |
| P1 | Signaux Microsoft du pool partagé | **Porte Mailgun** | Demande privée et conclusion Mailgun fondée sur sa télémétrie; aucune causalité présumée |
| P1 | Segmentation Gmail/Microsoft/Yahoo | **Déployée et vérifiée en production** | `lib/mailgun-event-metadata.ts` normalise prudemment fournisseur, domaine, IP et SMTP; `lib/mailgun-event-store.ts` les stocke. Les migrations `0012`/`0013` sont appliquées; les fenêtres privées 24 h, 7 j et 30 j répondent et `lib/deliverability-metrics.ts` agrège par fournisseur |
| P1 | Segmentation transactionnel/marketing | **Partiellement implémentée; nouvelles branches différées** | `traffic_type` accepte plusieurs classes, l'API les agrège, et le flux actuel écrit `prospecting`. Aucun domaine `tx`/`news` ni flux transactionnel/marketing n'a été créé |
| P1 | Tags/campagnes non personnels | **Implémenté pour la prospection CRM** | `app/api/messages/send/route.ts` émet `source-crm` et `traffic-prospecting`; `lib/mailgun-message.ts` valide au plus trois tags kebab non personnels; messages, Events et métriques les conservent. Aucun `template-v1` n'est émis tant qu'il n'existe pas |
| P1 | Baseline Inbox placement avant/après | **Porte externe, non exécutée** | L'endpoint canari existe dans `app/api/admin/mailgun-canary/route.ts`, mais chaque graine et chaque lecture d'en-têtes/placement exigent une approbation et une boîte contrôlée |
| P1 | Envoyer d'abord au Tier A | **Contrôle opérationnel** | Utiliser réponses, demandes, achats et activité réelle; ne pas utiliser d'ouverture inventée |
| P1 | Cadence prévisible / warm-up domaine | **Mode et télémétrie déployés; application manuelle** | `lib/deliverability-policy.ts` expose `domain_ramp` et `recovery` sans formule automatique; l'API/UI affichent le mode, un plafond manuel éventuel et `automaticAdvancement=false`. Aucun quota serveur n'est déduit d'un volume inconnu; chaque palier réel exige une limite approuvée et des preuves propres |
| P1 | Alertes Mailgun par fournisseur | **Porte externe** | Configurer si le forfait/volume le permet; tester la destination et la procédure de réponse |
| P1 | Dashboard de métriques et seuils | **Code/UI déployés; API vérifiée en production** | `lib/deliverability-policy.ts` calcule les seuils et dénominateurs; `lib/deliverability-metrics.ts` agrège les messages uniques; `GET /api/admin/deliverability?window=24h|7d|30d` est borné, privé et `no-store`; `app/components/deliverability-panel.tsx` expose la vue opérateur. Les trois fenêtres et les rejets 400/401 ont été contrôlés sur Sites version 23; cette preuve API ne remplace pas un nouveau parcours visuel du panneau |
| P1 | Audit Spamhaus | **Contrôle DNS indicatif exécuté; outil officiel restant** | Le 12 septembre 2026, le résolveur système a retourné `NXDOMAIN` pour l'IP partagée `159.135.228.14` dans Spamhaus ZEN, SpamCop et Barracuda, ainsi que pour `27pm.org` dans Spamhaus DBL. Ce signal n'établit ni la réputation Microsoft ni l'absence dans tous les outils; utiliser le checker officiel après lecture du SMTP et traiter la cause avant delisting |
| P1 | Audit MXToolbox | **À la demande** | Détection large seulement; ne pas confondre présence et utilisation par le fournisseur |
| P1 | Analyse DMARC | **Porte externe** | Propriétaire, contrat, rétention et accès approuvés; inventaire complet des sources |
| P1 | Test de rendu Email on Acid | **Optionnel et gated** | Données synthétiques seulement; aucun message client réel sans autorisation |
| P2 | Séparer `tx.27pm.org` / `news.27pm.org` | **Taxonomie locale prête; DNS/Mailgun différés** | Le modèle `traffic_type` permet l'analyse future, mais aucun sous-domaine, DNS, domaine Mailgun ou flux n'a été créé; franchir les six portes en préservant `p=reject` et l'alignement strict |
| P2 | Passer DMARC à `quarantine`, puis `reject` | **Déjà au niveau final** | Ne pas régresser; vérifier chaque nouvelle source avant activation |
| P2 | BIMI | **Différé et optionnel** | Seulement après stabilité durable de DMARC, réputation, logo conforme et décision de certificat |
| P2 | Activer le tracking | **Désactivé; TLS du hostname invalide** | `lib/mailgun-message.ts` fixe tracking, clics et ouvertures à `no`; l'API/UI l'affichent désactivé. Avant toute activation : analyse de confidentialité, certificat valide pour `email.27pm.org`, contrôle du `web_scheme`, absence de réécriture inattendue et test reçu |
| P2 | IP dédiée | **Différé** | Volume régulier, télémétrie et capacité d'exploitation démontrés; décision séparée |
| P2 | Warm-up d'une IP dédiée | **Formule locale implémentée; non applicable et non exécutée** | `lib/deliverability-policy.ts` réserve `plancher(100 × 1,2^(jour−1))` au seul mode `dedicated_ip_warmup`; `tests/deliverability-policy.test.mjs` protège cette séparation. Aucun warm-up sans IP dédiée approuvée |

## Actions qui restent explicitement externes

Les opérations suivantes exigent encore une vérification en direct, un compte
appartenant à 27PM, les droits minimaux nécessaires et une approbation
d'exécution distincte :

- lire ou modifier le DNS;
- lancer la vérification d'un domaine dans Mailgun;
- activer Automatic Sender Security ou modifier DKIM;
- créer un sous-domaine, une route, un webhook, une alerte ou un pool;
- consulter ou exporter Events et suppressions avec un accès de compte;
- rapprocher un export fournisseur avec la base de production;
- inscrire le domaine dans Google Postmaster ou Yahoo Sender Hub/CFL;
- transmettre une enquête privée à Mailgun;
- envoyer une graine ou un message réel;
- utiliser un service tiers de blocklist, DMARC ou rendu avec des données 27PM;
- acheter, attacher ou chauffer une IP dédiée;
- modifier DMARC, SPF, MX, DKIM, CNAME, TLS ou BIMI;
- déployer toute nouvelle modification du CRM ou appliquer toute nouvelle
  migration D1.

À l'exécution, ne jamais placer un secret dans la ligne de commande, le dépôt,
un ticket, une capture, un fichier d'export non protégé ou un log. Charger
l'accès depuis le gestionnaire approuvé dans la session courante, vérifier le
compte et la région, effectuer l'action bornée, conserver une preuve sans
secret, puis retirer l'accès de la session.
