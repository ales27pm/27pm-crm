---
version: alpha
name: "27PM CRM — iOS"
description: "Dossiers CRM natifs, identité éditoriale 27PM et états de transfert explicites."
colors:
  primary: "#2846B8"
  background: "#F4F0E7"
  surface: "#FBF8F1"
  text: "#171714"
  muted: "#65625B"
  success: "#225C3A"
  warning: "#B56D2A"
  warningSurface: "#FFF4E7"
  danger: "#A83224"
  dangerSurface: "#F9E9E4"
typography:
  sans:
    fontFamily: "system-ui, sans-serif"
  display:
    fontFamily: "ui-serif, serif"
rounded:
  DEFAULT: "3px"
omitted:
  - section: spacing
    reason: "Les espacements SwiftUI sont définis par les composants canoniques ; ce document ne génère pas de valeurs CSS."
components:
  card:
    backgroundColor: "#FBF8F1"
    textColor: "#171714"
  attachmentStatus:
    backgroundColor: "#FFF4E7"
    textColor: "#171714"
---

# 27PM CRM iOS

## Overview

Application produit privée destinée à l'opérateur 27PM, en français canadien.
Cette tranche porte sur les photos/documents des comptes, opportunités et
conversations. Aucun rebranding ni changement de thème global.

Le caractère éditorial existant repose sur les titres serif, les surfaces
ivoire bordées et l'accent bleu. Les états de sécurité restent lisibles sans
couleur ; aucune décoration ne remplace leur libellé.

**Propriété des tokens :** `App27pmCRM/Theme.swift` reste canonique. Ce document
reflète ses valeurs ; il ne génère aucun token. La palette native est héritée
des variables de `../../app/globals.css`. Toute évolution durable doit vérifier
ces deux sources, pas créer une troisième palette locale.

## Colors

Bleu pour les actions, texte sombre pour la lecture, vert pour une observation
positive confirmée, ambre clair pour l'attente, rouille pour un refus confirmé.
Les badges utilisent texte et symbole ; pas de texte ivoire minuscule sur ambre.
Le thème clair est imposé par l'app actuelle ; une qualification sombre n'est
pas revendiquée.

## Typography

Conserver les titres serif existants. Dans les contrôles de fichiers modifiés,
utiliser les styles système `.footnote` et `.caption` qui suivent Dynamic Type.
Un nom long ou un état de sécurité doit pouvoir se répartir sur plusieurs
lignes. Éviter les majuscules systématiques dans une phrase d'état.

## Layout

Le dossier garde son défilement naturel. La section des pièces jointes est
partagée, sans implémentation locale différente par type de dossier. Les actions
se réorganisent sur petite largeur ; les cibles modifiées ont un minimum de
44 points de hauteur. La progression d'analyse n'a pas de pourcentage fictif.

## Elevation & Depth

Réutiliser `Card` et les bordures fines de `Theme`. Les aperçus plein écran et
sélecteurs natifs ne déplacent pas le contenu du dossier. Pas de nouvelle ombre,
de flou ni d'adoption de Liquid Glass pour cette correction.

## Shapes

Coins de carte hérités de `Card` (3 points). Les pastilles d'état peuvent être
arrondies mais doivent grandir avec leur contenu plutôt que couper le texte.

## Components

- `AttachmentSectionView` : accès, découverte distante, liste, ajout et actions.
- `AttachmentStatusChip` : état écrit et symbole ; attente et refus distincts.
- `AttachmentViewer` : copie locale seulement, session valide, pas de fichier
  explicitement bloqué ; disparition immédiate après révocation/blocage.
- `fileImporter`, `PhotosPicker`, caméra et confirmations : composants natifs
  acceptés, avec erreur localisée persistante dans la section.
- `ProgressView` : activité indéterminée pendant la lecture de la liste ; aucun
  succès annoncé avant confirmation.

## Do's and Don'ts

- Nommer « Aperçu local » une copie de l'iPhone : ce n'est pas une preuve ClamAV.
- Distinguer réception, analyse, refus et disponibilité vérifiée.
- Ne pas afficher « infecté » à partir du seul code HTTP 423.
- Ne pas créer de nouveau transport ou de nouvelle identité visuelle pour une
  seule vue. Voir `UX-CONTRACT.md` pour le comportement et ses sources.
