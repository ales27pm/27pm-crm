# Synchronisation Exchange sans navigateur

Le Site expose uniquement `sync_exchange_mail` dans son serveur MCP `/mcp`.
Le plugin privé créé par Sites authentifie l'appelant; le serveur exige aussi
une adresse autorisée dans `CRM_ADMIN_EMAILS`. Le Site conserve son audience
actuelle. `CRM_SITES_MCP_ORIGIN` doit être l'origine réellement protégée par
le dispatch Sites, jamais une origine Vercel ou un Worker directement exposé.
Cette exception d'identité est limitée au chemin exact `/mcp`.

Chaque appel importe, en série, une page delta de Réception, Indésirables et
Envoyés, avec les verrous, curseurs et règles d'attribution aux alias existants.
Un résultat `more: true` est repris au passage suivant. Une erreur ne rejoue pas
automatiquement l'appel; les données déjà enregistrées restent idempotentes.
Le résultat ne contient que des compteurs, jamais le contenu des messages.

L'automatisation liée au Site doit appeler cet outil une seule fois par passage.
Elle ne doit pas utiliser les connecteurs Outlook/Gmail pour envoyer, marquer
comme lu, déplacer ou supprimer un message. Aucun brouillon ou envoi en attente
n'est exécuté par la synchronisation. Aucun déploiement n'est nécessaire aux
passages ordinaires.

Interrupteurs serveur, tous indépendants :

- `CRM_EXCHANGE_SYNC_ENABLED=true` : autorise l'import manuel et automatique.
- `CRM_EXCHANGE_AUTOMATIC_SYNC_ENABLED=true` : autorise l'outil planifié.
- `CRM_EXCHANGE_MESSAGE_SEND_ENABLED=true` : ouvre l'envoi ordinaire confirmé
  du CRM; ne provoque aucun envoi et ne contourne aucun contrôle de conformité.

Pour arrêter l'automatisation, suspendre sa tâche liée ou passer l'interrupteur
automatique à `false` puis redéployer la version sauvegardée. Pour arrêter tout
accès Exchange, déconnecter la boîte depuis les paramètres du CRM. Les messages
et l'historique existants sont conservés.

La validation doit distinguer : outil publié, appel authentifié réussi,
curseurs réellement persistés, tâche enregistrée et exécution périodique.
Une tâche enregistrée seule ne prouve pas qu'une synchronisation a eu lieu.
