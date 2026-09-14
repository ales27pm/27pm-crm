# Icônes du CRM 27PM

40 SVG individuels, un sprite et un index. Les 24 premières icônes conservent la géométrie de `app/components/icons.tsx`, au commit `04f5c233244def06ee9c8847af5fbf5c7c607de4`. Les 16 autres étendent le même vocabulaire. Grille 24 × 24, trait 1,7, extrémités et jonctions arrondies, couleur `currentColor`.

Les noms existants restent identiques : aucune migration de vocabulaire n’est nécessaire. Le dossier fourni ne modifie pas le composant de l’application.

Utilisation du sprite avec la couleur héritée du bouton :

```tsx
<button type="button" aria-label="Télécharger">
  <svg width="24" height="24" aria-hidden="true">
    <use href="/visual-assets/icons/sprite.svg#crm-download" />
  </svg>
</button>
```

La couleur CSS du parent est héritée dans un SVG intégré ou dans le sprite. Un fichier chargé avec `<img>` n’hérite pas de `color`; il apparaît en noir par défaut. Pour les variantes colorées, privilégier le sprite ou le SVG intégré. La couleur des états n’est pas portée par les fichiers : le composant contrôle `color`.

Chaque SVG individuel contient un titre français. Lorsqu’une icône accompagne déjà un texte ou un bouton nommé, la masquer aux technologies d’assistance avec `aria-hidden="true"`; donner au bouton son nom accessible. Pour une icône informative seule, donner un nom accessible au SVG extérieur.

Navigation actuelle :

| Vue | Icône |
| --- | --- |
| Aujourd’hui | `calendar` |
| Réception | `inbox` |
| Comptes | `contacts` |
| Pipeline | `pipeline` |
| Projets | `projects` |
| Tâches | `tasks` |
| Paramètres | `settings` |

`building` est une variante disponible pour l’entreprise; elle ne remplace pas automatiquement l’icône `contacts` actuellement utilisée pour Comptes.
