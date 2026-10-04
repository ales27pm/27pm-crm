# Dossier de preuve avant approche — Machineries Pronovost

Date locale de vérification : 2026-09-10 (America/Toronto)  
Instant de capture : 2026-09-11T02:28:49Z  
Portée : recherche et préparation seulement; aucun courriel, formulaire ou appel.

## Décision proposée

Une approche très étroite peut être documentée pour la boîte professionnelle
générale `info@pronovost.qc.ca`, à l'attention de Simon Pronovost. Elle doit
rester limitée aux frictions observées dans le parcours de vente public. Dave
Barclay demeure une cible de routage secondaire, pas le destinataire principal.

Cette décision ne prouve ni la remise en boîte de réception, ni le routage
interne vers Simon Pronovost, ni un mandat, un budget ou un intérêt de Pronovost.
Elle ne constitue pas une autorisation d'envoi.

## Identité, adresse et provenance

- Adresse : `info@pronovost.qc.ca`.
- Source principale : brochure officielle Pronovost « Home use », huit pages,
  imprimée au Canada en mai 2025 :
  https://pronovost.qc.ca/wp-content/uploads/2025/06/Pronovost_Home-use.pdf
- La page 8 publie ensemble le nom de l'entreprise, l'adresse postale, le
  téléphone, `info@pronovost.qc.ca` et le site Web. Aucune mention refusant les
  messages commerciaux n'accompagne l'adresse sur cette page. La page a été
  vérifiée visuellement et par extraction de texte.
- Le PDF répondait `200` au moment de la capture, avec une date serveur de
  dernière modification du 2 juin 2025.
- SHA-256 du PDF capturé :
  `fa31e43e2ddd11bd1c593c2f0d5b3342d09b51d28c6afe8faac3c741b12342ab`.
- Le domaine publiait deux routes MX actives au moment du contrôle : Mailhop
  (priorité 0) et Microsoft 365 (priorité 10).

Conclusion documentaire proposée : adresse professionnelle publiée par
l'organisation et techniquement routable au niveau du domaine. Le statut
`valid` du CRM signifierait ici « adresse officielle vérifiée », pas
« boîte individuelle », « routage vers Simon confirmé » ni « remise garantie ».

## Rôle et pertinence du message

Source officielle : https://pronovost.qc.ca/fr/equipe/

- Simon Pronovost est présenté comme directeur des ventes.
- Dave Barclay est présenté comme directeur général.
- La page déclarait une dernière modification le 4 juin 2026.
- Aucun courriel nominatif n'a été trouvé ou déduit.

L'audit en lecture seule a vérifié le parcours accueil → catégorie souffleuses
→ sélecteur → résultats. Les constats reproductibles sont les suivants :

1. un interstitiel Agriextra presque plein écran a masqué le parcours; sa
   fermeture n'était pas exposée comme bouton et un clic visant la fermeture a
   activé le lien situé dessous;
2. la catégorie présente douze cartes sans filtre visible et avec un petit
   signe plus sans nom d'action distinct;
3. le sélecteur expose correctement ses curseurs, mais « Soumettre » apparaît
   comme un conteneur plutôt que comme un bouton dans l'arbre d'accessibilité;
4. le résultat devient un très long tableau, et plusieurs liens publics
   pointent encore vers `wordpress-dev.pronovost.qc.ca`.

Rapport détaillé :
`artifacts/pronovost-sales-audit-20260910-Wl2AZE/audit.md`.

Ces constats concernent directement l'autoqualification des acheteurs, la
continuité du parcours de vente et la conversion. Une approche limitée à ces
constats est donc raisonnablement liée aux fonctions publiées de la direction
des ventes. La propriété interne du site ou du numérique par Simon Pronovost
n'est toutefois pas démontrée; le message doit demander si le dossier relève
bien de lui.

## Analyse LCAP à consigner

Le guide et la FAQ officiels du CRTC exigent, pour invoquer une publication
bien en vue : une publication attribuable au destinataire, aucune restriction
associée à l'adresse, et un contenu pertinent pour ses activités ou fonctions.
Le fardeau de preuve demeure à l'expéditeur et l'analyse se fait au cas par cas.

Sources :

- https://crtc.gc.ca/fra/com500/guide.htm
- https://crtc.gc.ca/fra/com500/faq500.htm
- https://laws-lois.justice.gc.ca/fra/lois/E-1.6/section-6.html
- https://laws-lois.justice.gc.ca/fra/lois/E-1.6/FullText.html

Évaluation proposée pour ce seul message :

- `provenance_type = recipient_published`;
- `lawful_basis = conspicuous_publication`;
- `publication_by_recipient = true`;
- `publication_no_restriction = true`, sur la base de la page 8 capturée;
- `role_relevance = relevant`, uniquement pour le sujet précis ci-dessous;
- aucune date d'expiration légale arbitraire ajoutée, mais nouvelle vérification
  de la source et des oppositions obligatoire juste avant toute action.

Cette évaluation n'est pas une licence générale de prospection. Elle devient
inapplicable si le contenu, la cible ou les preuves changent.

## Message de référence pour la pertinence

Destinataire envisagé : `info@pronovost.qc.ca`  
Routage demandé : Simon Pronovost, directeur des ventes  
Objet proposé : `Pronovost — trois frictions observées dans le parcours souffleuses`

> Bonjour,
>
> À l'attention de Simon Pronovost, directeur des ventes.
>
> En parcourant l'outil « Trouver la bonne souffleuse », j'ai relevé trois
> frictions vérifiables : un interstitiel qui peut déclencher le lien situé
> dessous, plusieurs liens publics qui pointent encore vers
> `wordpress-dev.pronovost.qc.ca`, et l'action « Soumettre » qui n'est pas
> exposée comme un bouton aux technologies d'assistance.
>
> J'ai résumé les constats et leurs effets possibles sur l'autoqualification
> des acheteurs dans une page. Est-ce un sujet qui relève de vous? Si oui, je
> peux vous transmettre le résumé ou le parcourir avec vous en quinze minutes.
> Sinon, dites-le-moi simplement et je n'effectuerai pas de relance.
>
> Merci,
> Alexis

L'identité complète et le lien de désabonnement doivent être ajoutés par le
serveur; ils ne doivent pas être copiés manuellement dans un brouillon.

## Contrôles globaux 27PM observés en production

- Identité stockée : Alexis Boulet / 27PM / adresse postale / méthode de
  contact. Validité déclarée jusqu'au 10 novembre 2026.
- Désabonnement : secret de signature présent; un lien signé provenant du
  courriel JAMEC déjà livré a retourné `200` sur la page de confirmation le
  10 septembre, sans `POST` et sans créer de suppression.
- Validité déclarée du mécanisme : jusqu'au 10 novembre 2026.
- Pour un envoi le 23 septembre, les deux fenêtres doivent couvrir au moins
  jusqu'au 23 novembre; cette borne inclut la marge interne de 24 heures du
  CRM au-delà des 60 jours exigés. Les dates actuelles sont donc insuffisantes.

Le test du lien permet de dater une nouvelle validation technique du parcours
de désabonnement. Il ne permet pas, à lui seul, de confirmer l'adresse postale
de l'expéditeur ni d'engager 27PM à maintenir le secret et l'origine publique
au-delà du 10 novembre. La prolongation des deux dates exige donc une décision
opérateur explicite et une session CRM authentifiée.

## État des bloqueurs après recherche

| Contrôle | Preuve prête | Modification production |
| --- | --- | --- |
| Adresse professionnelle | Oui : PDF officiel, hash et MX | Non appliquée |
| Routage nominatif | Non; boîte générale seulement | Ne pas prétendre le contraire |
| Pertinence du rôle | Oui pour Simon et le message ci-dessus | Non appliquée |
| Fondement LCAP | Analyse documentée pour ce seul message | Non appliquée |
| Identité expéditeur | Champs présents, adresse non reconfirmée aujourd'hui | Échéance non prolongée |
| Désabonnement | GET signé 200, aucune suppression créée | Échéance non prolongée |
| Approbation d'envoi | Non demandée | Aucun envoi |

## Mise à jour CRM prévue après authentification

La route opérateur du CRM doit être utilisée afin de conserver l'audit et les
versions. La fiche contact peut alors être mise à jour avec les valeurs
documentées ci-dessus, la stratégie recentrée sur Simon Pronovost, et l'étape
interne de recherche marquée terminée. Les étapes courriel ne constituent
jamais une autorisation d'envoi.

La configuration globale ne doit être prolongée qu'après confirmation que
l'identité complète stockée est toujours exacte et engagement à maintenir le
mécanisme de désabonnement pendant toute la nouvelle fenêtre.
