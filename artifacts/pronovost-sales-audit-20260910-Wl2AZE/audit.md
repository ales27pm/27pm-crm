# Audit visuel du parcours public Pronovost

Date : 2026-09-10
Viewport observe : 1264 x 710, navigateur integre Codex
Mode : lecture seule; aucun formulaire soumis

## Verdict

Le parcours expose un besoin concret de fiabilisation du chemin de vente en ligne : l'interstitiel peut masquer le contenu et provoquer une navigation accidentelle, la decouverte des souffleuses demande beaucoup de balayage, certains controles ont une semantique d'action faible, et plusieurs CTA publics pointent encore vers `wordpress-dev.pronovost.qc.ca`.

Ces observations rendent plausible la pertinence de ces sujets pour une direction des ventes. Elles ne prouvent ni un mandat, ni un budget, ni un interet pour un fournisseur externe, ni l'autorisation de prospecter un role ou une adresse.

## Etapes

1. Accueil - sante degradee
   - Force : l'action pour trouver un concessionnaire est presente.
   - Probleme majeur : l'interstitiel Agriextra couvre presque tout le contenu. Sa fermeture est minuscule et n'est pas exposee comme bouton dans l'arbre d'accessibilite. Un clic visant la fermeture a active le lien sous-jacent Trouver un concessionnaire.
   - Effet ventes : risque de sortie du parcours voulu, perte de confiance et mesure de conversion brouillee.

2. Categorie souffleuses - sante moyenne
   - Force : les douze modeles sont presentes sous forme de cartes visuellement coherentes sur deux colonnes.
   - Problemes : aucun filtre visible; parcours long; signe plus seul et petit; l'arbre d'accessibilite expose les cartes comme de grands liens sans nom d'action distinct.
   - Effet ventes : effort de comparaison eleve et autoqualification plus faible avant la prise de contact.

3. Selecteur Trouver la bonne souffleuse - sante mitigee
   - Force : les curseurs de puissance et de largeur traduisent des criteres d'achat concrets; ils sont exposes comme sliders dans l'arbre d'accessibilite. Des accordions fournissent des explications.
   - Risque : Soumettre apparait comme simple conteneur, pas comme bouton semantique.
   - Effet ventes : action finale moins robuste pour clavier ou technologie d'assistance; une difficulte de soumission pourrait reduire le nombre de selections abouties.

4. Resultats et comparaison - sante degradee
   - Force : la page fournit beaucoup de caracteristiques pour un acheteur expert.
   - Problemes : resultat presente dans un tres long tableau, donc balayage et comparaison couteux; plusieurs CTA renvoient vers des pages `wordpress-dev.pronovost.qc.ca`.
   - Effet ventes : priorisation du bon modele peu evidente et rupture de confiance ou de continuite au moment d'avancer dans le parcours.

5. Soumission ou concessionnaire - verification incomplete
   - Aucun formulaire n'a ete soumis.
   - La page concessionnaire a ete atteinte accidentellement par le clic traversant l'interstitiel; le resultat terminal d'une soumission valide n'a donc pas ete prouve.

## Priorites

1. Corriger l'interstitiel : vrai bouton de fermeture, cible suffisamment grande, focus et ordre d'empilement empechant tout clic sur le contenu masque.
2. Remplacer tous les liens `wordpress-dev.pronovost.qc.ca` par des destinations de production verifiees.
3. Ajouter des filtres ou une comparaison progressive et une courte selection recommandee.
4. Donner aux controles un nom et un role explicites, notamment le plus des cartes et Soumettre.
5. Raccourcir la sortie du selecteur et afficher une prochaine action claire : voir le modele, demander une soumission ou trouver un concessionnaire.

## Limites de preuve

- Les captures ont ete observees et inspectees dans la session CUA du thread racine, mais n'ont pas pu etre exportees comme fichiers depuis la session de ce rapport.
- Aucun test mobile, zoom, clavier complet, lecteur d'ecran, contraste mesure, erreur de formulaire ou soumission reelle n'a ete effectue.
- Les risques d'accessibilite sont fondes sur l'etat visuel et l'arbre d'accessibilite, pas sur une certification WCAG.
