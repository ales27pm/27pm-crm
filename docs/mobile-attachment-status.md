# État du raccordement iOS — 16 octobre 2026

`GET /api/mobile/capabilities` remplace le 404 par une réponse authentifiée
`{ "attachments": false }`. Il exige un jeton d'appareil valide, une session
active, l'identité autorisée et le droit de lecture du CRM. La lecture ne crée
aucun fichier, ne vide aucune file locale et n'envoie aucun courriel.

Ce correctif ne constitue pas l'activation des pièces jointes. Le chantier
antérieur reste disponible dans la PR 4, sans fusion globale :
https://github.com/ales27pm/27pm-crm/pull/4

L'activation complète dépend encore des éléments suivants :

1. Route de transfert sur l'origine unique `https://crm.27pm.org`, sans passer
   un fichier de 20 Mio par une fonction Vercel ni rediriger l'iPhone vers une
   autre origine. Aucun changement DNS ou routage n'est effectué ici.
2. Migration additive de `mobile_attachments`, après une sauvegarde et une
   restauration contrôlées. La base de production ne possède pas cette table
   lors de la vérification du 16 octobre.
3. Analyse antivirus privée réelle et opérationnelle, avec signatures à jour,
   authentification serveur et verdict lié aux octets et à la version R2.
   Aucun scanner déployé ni liaison privée n'a été identifié. Ne pas remplacer
   cette analyse par une liste d'extensions autorisées.
4. Tests authentifiés de dépôt et de récupération, contrôle de quarantaine,
   intégrité SHA-256, refus d'accès non autorisé et validation IPv6/DNS64.

Conserver les originaux et la file locale sur l'iPhone tant que ces conditions
ne sont pas démontrées. Aucun indicateur `attachments: true`, migration de
données, déploiement de scanner, nouvelle infrastructure, modification DNS ou
activation de transfert n'est autorisé implicitement par ce correctif de sonde.
