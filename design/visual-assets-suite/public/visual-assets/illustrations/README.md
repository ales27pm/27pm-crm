# Illustrations d’états du CRM 27PM

10 compositions SVG éditables, sans texte visible, sur une grille 320 × 220. Fond transparent; détails ivoire `#F4F0E7`, carbone `#171714` et cobalt `#2846B8`. Elles sont conçues pour les surfaces claires du CRM. Les titres, explications et actions restent en HTML, traduisibles et accessibles.

| Fichier | Emplacement prévu |
| --- | --- |
| `inbox-empty.svg` | `inbox-rail.tsx` : aucune conversation |
| `thread-select.svg` | `thread-view.tsx` : aucune conversation sélectionnée |
| `accounts-empty.svg` | `account-workspace.tsx` : aucune entreprise sélectionnée |
| `search-empty.svg` | `account-workspace.tsx` : aucune entreprise ne correspond aux filtres |
| `pipeline-empty.svg` | `pipeline-view.tsx` : vue entièrement vide |
| `projects-empty.svg` | `work-views.tsx` : liste des projets vide |
| `tasks-clear.svg` | `today-view.tsx` : tout est à jour; réutilisable pour les tâches |
| `strategy-empty.svg` | `outreach-strategy-panel.tsx` : aucun plan préparé |
| `access-denied.svg` | `access-screen.tsx` : compte non autorisé |
| `connection-error.svg` | `crm-app.tsx` : serveur indisponible ou transport dégradé |

Ces illustrations sont intégrées aux branches d’état correspondantes du CRM. Les états compacts d’un tableau ou d’une carte gardent de préférence leur texte seul. Utiliser l’illustration une seule fois dans la vue vide principale.

```tsx
<div className="thread-empty">
  <img
    className="crm-empty-art"
    src="/visual-assets/illustrations/thread-select.svg"
    width="320"
    height="220"
    alt=""
  />
  <h2>Sélectionnez une conversation.</h2>
  <p>Le message et son contexte client s’ouvriront ici.</p>
</div>
```

```css
.crm-empty-art {
  display: block;
  width: min(100%, 20rem);
  height: auto;
  margin-inline: auto;
}
```

Le texte HTML explique l’état; l’image est décorative et reçoit donc `alt=""`. Les icônes d’état doivent accompagner les messages et boutons existants. Les SVG ne contiennent ni texte de client, ni chiffres de performance, ni données de démonstration.
