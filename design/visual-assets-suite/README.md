# 27PM CRM — suite visuelle

Extension de l’identité actuelle « Confiance calme », préparée le 13 septembre 2026. Ouvrir `index.html` pour parcourir les fichiers et les exemples. Le dossier `public/visual-assets` contient les actifs à copier dans le CRM.

## Contenu

- Emblème de production conservé, signatures horizontale, compacte et verticale; exports pour applications et favoris.
- 40 icônes SVG : 24 géométries actuelles, 16 extensions; sprite disponible.
- 10 illustrations SVG transparentes et leurs PNG : réception, conversation, comptes, recherche, pipeline, projets, tâches, stratégie, accès et connexion.
- Trois fonds générés avec Imagegen, sans texte ni logo, en PNG original et WebP sans perte.
- Motifs vectoriels exacts dérivés du champ de lignes du site, visuels de partage et gabarits de courriel.
- Polices locales, licences OFL, tokens CSS/JSON, composant React d’exemple et inventaire avec SHA-256.

## Règles d’usage

Ivoire `#F4F0E7`, carbone `#171714`, cobalt `#2846B8`. Newsreader pour les titres; Instrument Sans pour le texte et l’interface. Le vermillon, le `27:00` et les anciens logos ne font pas partie de cette version.

Les fonds générés sont des images éditoriales : leurs couleurs et lignes ne sont pas des références numériques. Utiliser les tokens et les SVG pour la précision des interfaces. Garder les fonds dans les surfaces de connexion/accueil; utiliser les petits SVG dans les vues de travail. Aucun texte important ne doit être inscrit dans les bitmaps.

L’emblème officiel disponible est un PNG transparent. Les signatures SVG qui l’intègrent sont **hybrides**, avec texte vectoriel et emblème raster; elles ne sont pas présentées comme un logo intégralement vectorisé.

L’illustration doit avoir `alt=""` lorsque son message apparaît déjà dans le titre adjacent. Les icônes d’action ont un libellé visible ou un nom accessible. Le `currentColor` d’un SVG externe chargé avec `<img>` ne suit pas la couleur CSS du parent : employer le sprite ou du SVG intégré pour les états actifs.

## Intégration

1. Copier `public/visual-assets` dans `public/visual-assets` du dépôt `ales27pm/27pm-crm`.
2. Réutiliser les polices et variables déjà présentes dans `app/globals.css`. Les tokens fournis sont une référence additive.
3. `integration/VisualAsset.tsx` montre l’usage des images et du sprite; les identifiants simples comme `inbox` sont préfixés automatiquement par `crm-`.
4. Les gabarits `templates/` et l’aperçu de connexion sont des propositions visuelles. Brancher les actions sur les fonctions existantes; ils ne créent pas d’authentification ou d’envoi.
5. Le manifest fourni propose uniquement les icônes et couleurs d’installation. Il ne crée aucun service worker et ne rend pas le CRM utilisable hors ligne.

Les fichiers sont livrés pour intégration. Aucun déploiement du CRM n’a été effectué. Aucun courriel ou contact réel n’apparaît dans les exemples.

## Sources

- [Identité 27PM](https://github.com/ales27pm/27pm), commit `003bad433ad4915d9afbfe068fd414d57deda944` : `design/brand-v5/implementation-spec.md`, identité v4 et `src/main.ts`.
- [CRM](https://github.com/ales27pm/27pm-crm), commit `04f5c233244def06ee9c8847af5fbf5c7c607de4` : `design/implementation-spec.md`, `app/globals.css`, `app/components/icons.tsx` et actifs de `public`.
- Les requêtes Imagegen exactes sont dans `docs/image-prompts.json`. Création via l’outil intégré, sans API externe.

`manifest.json` et `docs/validation.json` décrivent le contenu et les vérifications locales.
