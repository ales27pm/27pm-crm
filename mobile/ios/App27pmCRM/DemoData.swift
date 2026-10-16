import Foundation

/// Demo-mode dashboard mirroring the source's `demo-data.ts` cohort plus a
/// representative working set, so the app reflects a live operator day.
/// Dates are built relative to "now" so the queue always has content.
enum DemoData {
  static func dashboard(now: Date = Date()) -> DashboardData {
    func days(_ offset: Double) -> Date {
      now.addingTimeInterval(offset * 86_400)
    }

    let mailboxes: [Mailbox] = [
      Mailbox(id: "bonjour@27pm.org", address: "bonjour@27pm.org", label: "Prospects et clients", kind: .sales),
      Mailbox(id: "alexis@27pm.org", address: "alexis@27pm.org", label: "Alexis Boulet", kind: .sales),
      Mailbox(id: "admin@27pm.org", address: "admin@27pm.org", label: "Comptes et opérations", kind: .operations),
    ]

    let organizations: [Organization] = [
      Organization(
        id: "org-s-huot", name: "S.Huot", score: 96, priority: .veryHigh,
        budgetMinCents: 2_000_000, budgetMaxCents: 3_500_000, budgetIsHypothesis: true,
        nextStep: "Valider le compte et finaliser la stratégie de sensibilisation",
        notes: "Hypothèse de prospection à valider; enveloppe indicative non confirmée.",
        nextFollowUpAt: nil,
        sourceLabel: "Document utilisateur — cohorte initiale",
        address: "750 Chemin de la Chaudière",
        city: "Lévis, QC"
      ),
      Organization(
        id: "org-jamec", name: "JAMEC", score: 94, priority: .veryHigh,
        budgetMinCents: 2_500_000, budgetMaxCents: 4_000_000, budgetIsHypothesis: true,
        nextStep: "Cadrer le périmètre du portail client",
        notes: "Hypothèse de prospection à valider; enveloppe indicative non confirmée.",
        nextFollowUpAt: nil,
        sourceLabel: "Document utilisateur — cohorte initiale",
        address: "300 Rue Léo-Pariseau",
        city: "Montréal, QC"
      ),
      Organization(
        id: "org-vallee", name: "Vallée", score: 92, priority: .high,
        budgetMinCents: 2_500_000, budgetMaxCents: 4_000_000, budgetIsHypothesis: true,
        nextStep: "Relever le thermomètre de satisfaction après la livraison",
        notes: "Hypothèse de prospection à valider; enveloppe indicative non confirmée.",
        nextFollowUpAt: days(7),
        sourceLabel: "Document utilisateur — cohorte initiale",
        address: "2450 Route du Vallon",
        city: "Lévis, QC"
      ),
      Organization(
        id: "org-pronovost", name: "Machineries Pronovost", score: 89, priority: .high,
        budgetMinCents: 3_000_000, budgetMaxCents: 5_000_000, budgetIsHypothesis: true,
        nextStep: "Valider le compte et identifier un rôle professionnel pertinent",
        notes: "Hypothèse de prospection à valider; enveloppe indicative non confirmée.",
        nextFollowUpAt: nil,
        sourceLabel: "Document utilisateur — cohorte initiale"
      ),
      Organization(
        id: "org-gii", name: "Groupe Industriel Interprovincial", score: 83, priority: .high,
        budgetMinCents: 1_200_000, budgetMaxCents: 2_200_000, budgetIsHypothesis: true,
        nextStep: "Compléter la preuve DNCL du contact technology",
        notes: "Hypothèse de prospection à valider; enveloppe indicative non confirmée.",
        nextFollowUpAt: nil,
        sourceLabel: "Document utilisateur — cohorte initiale"
      ),
    ]

    let contacts: [Contact] = [
      Contact(
        id: "c-gagnon", name: "Marc Gagnon", email: "direction@s-huot.ca",
        role: "Direction générale", organization: "S.Huot", organizationId: "org-s-huot",
        source: "Page Contact du site de l'entreprise (route professionnelle officielle)",
        sourceUrl: "https://s-huot.ca/contact",
        dnclStatus: "Vérifié", emailStatus: "Inconnu", emailReady: false,
        emailBlockReasons: ["Adresse au statut inconnu — validation requise"],
        lastContactAt: days(-4),
        phone: "+1 418 555 0142"
      ),
      Contact(
        id: "c-mercier", name: "Linda Mercier", email: "operations@jamec.ca",
        role: "Directrice des opérations", organization: "JAMEC", organizationId: "org-jamec",
        source: "Route professionnelle officielle — annuaire de l'entreprise",
        sourceUrl: nil,
        dnclStatus: "Vérifié", emailStatus: "Inconnu", emailReady: false,
        emailBlockReasons: ["Adresse au statut inconnu — validation requise"],
        lastContactAt: days(-0.8),
        phone: "+1 514 555 0187"
      ),
      Contact(
        id: "c-lambert", name: "Robert Lambert", email: "direction@vallee.ca",
        role: "Direction générale", organization: "Vallée", organizationId: "org-vallee",
        source: "Route professionnelle officielle — annuaire de l'entreprise",
        sourceUrl: nil,
        dnclStatus: "À vérifier", emailStatus: "Inconnu", emailReady: false,
        emailBlockReasons: ["Preuve DNCL à consigner", "Adresse au statut inconnu — validation requise"],
        lastContactAt: days(-30)
      ),
      Contact(
        id: "c-carrier", name: "Sophie Carrier", email: "ventes@pronovost.com",
        role: "Vice-présidence, ventes et marketing", organization: "Machineries Pronovost",
        organizationId: "org-pronovost",
        source: "Route professionnelle officielle — annuaire de l'entreprise",
        sourceUrl: nil,
        dnclStatus: "À vérifier", emailStatus: "Inconnu", emailReady: false,
        emailBlockReasons: ["Adresse au statut inconnu — validation requise"],
        lastContactAt: nil
      ),
      Contact(
        id: "c-bergeron", name: "Daniel Bergeron", email: "technologie@gii.ca",
        role: "Directeur de la technologie", organization: "Groupe Industriel Interprovincial",
        organizationId: "org-gii",
        source: "Route professionnelle officielle — annuaire de l'entreprise",
        sourceUrl: nil,
        dnclStatus: "À vérifier", emailStatus: "Inconnu", emailReady: false,
        emailBlockReasons: ["Preuve DNCL à consigner", "Adresse au statut inconnu — validation requise"],
        lastContactAt: days(-8)
      ),
      Contact(
        id: "c-rioux", name: "Patrice Rioux", email: "projets@vallee.ca",
        role: "Gestionnaire de projets", organization: "Vallée", organizationId: "org-vallee",
        source: "Contact nominatif publié sur le site de son entreprise",
        sourceUrl: "https://vallee.ca/equipe",
        dnclStatus: "Vérifié", emailStatus: "Inconnu", emailReady: false,
        emailBlockReasons: ["Adresse au statut inconnu — validation requise"],
        lastContactAt: days(-12)
      ),
    ]

    let interactions: [String: [Interaction]] = [
      "deal-shuot": [
        Interaction(id: "i-shuot-1", kind: .call, summary: "Appel de qualification — besoins et contraintes de la refonte.", occurredAt: days(-9), createdBy: "alexis@27pm.org"),
        Interaction(id: "i-shuot-2", kind: .meeting, summary: "Rencontre de cadrage : périmètre, estimateur et échéancier.", occurredAt: days(-5), createdBy: "alexis@27pm.org"),
        Interaction(id: "i-shuot-3", kind: .note, summary: "Proposition acheminée avec estimateur chiffré. Relance prévue sous 3 jours.", occurredAt: days(-4), createdBy: "alexis@27pm.org"),
      ],
      "deal-jamec": [
        Interaction(id: "i-jamec-1", kind: .call, summary: "Appel initial : douleur sur le suivi de commandes et la facturation.", occurredAt: days(-6), createdBy: "alexis@27pm.org"),
        Interaction(id: "i-jamec-2", kind: .note, summary: "Linda confirme un conseil d'administration jeudi — budget à présenter d'ici là.", occurredAt: days(-1), createdBy: "alexis@27pm.org"),
      ],
      "deal-gii": [
        Interaction(id: "i-gii-1", kind: .meeting, summary: "Kickoff de la migration, phase 1 : catalogue et fiches produits.", occurredAt: days(-14), createdBy: "alexis@27pm.org"),
        Interaction(id: "i-gii-2", kind: .note, summary: "Phase 1 en révision interne jeudi prochain.", occurredAt: days(-2), createdBy: "alexis@27pm.org"),
      ],
      "deal-vallee": [
        Interaction(id: "i-vallee-1", kind: .email, summary: "Livraison confirmée et facture finale envoyée.", occurredAt: days(-18), createdBy: "bonjour@27pm.org"),
      ],
    ]

    let deals: [Deal] = [
      Deal(
        id: "deal-shuot", organizationId: "org-s-huot", contactId: "c-gagnon",
        title: "Refonte du site vitrine", contactName: "Marc Gagnon", organization: "S.Huot",
        projectType: .siteWeb, stage: .proposition,
        nextAction: "Relancer la proposition avec l'estimateur chiffré",
        nextActionDate: days(3),
        note: "Enveloppe indicative 20 000 – 35 000 $ (hypothèse à confirmer en cadrage).",
        interactions: interactions["deal-shuot"] ?? []
      ),
      Deal(
        id: "deal-jamec", organizationId: "org-jamec", contactId: "c-mercier",
        title: "Portail client JAMEC", contactName: "Linda Mercier", organization: "JAMEC",
        projectType: .application, stage: .qualifie,
        nextAction: "Valider le périmètre du portail avec Linda",
        nextActionDate: days(-1),
        note: "Conseil d'administration jeudi — la proposition doit être mûre d'ici là.",
        interactions: interactions["deal-jamec"] ?? []
      ),
      Deal(
        id: "deal-pronovost", organizationId: "org-pronovost", contactId: "c-carrier",
        title: "Application de suivi de production", contactName: "Sophie Carrier",
        organization: "Machineries Pronovost", projectType: .application, stage: .nouveau,
        nextAction: "",
        nextActionDate: nil,
        note: "Opportunité ouverte sans plan — à cadrer lors de la validation du compte.",
        interactions: []
      ),
      Deal(
        id: "deal-gii", organizationId: "org-gii", contactId: "c-bergeron",
        title: "Migration de la vitrine B2B", contactName: "Daniel Bergeron",
        organization: "Groupe Industriel Interprovincial", projectType: .siteWeb, stage: .production,
        nextAction: "Livrer la phase 1 à la révision interne",
        nextActionDate: days(10),
        note: "Phase 1 : catalogue et fiches produits. Phase 2 : portail de commandes.",
        interactions: interactions["deal-gii"] ?? []
      ),
      Deal(
        id: "deal-vallee", organizationId: "org-vallee", contactId: "c-rioux",
        title: "Vitrine Vallée", contactName: "Patrice Rioux", organization: "Vallée",
        projectType: .siteWeb, stage: .gagne,
        nextAction: "Relever le thermomètre après 30 jours",
        nextActionDate: days(18),
        note: "Projet livré — suivre la satisfaction et la référencabilité.",
        interactions: interactions["deal-vallee"] ?? []
      ),
    ]

    let tasks: [CrmTask] = [
      CrmTask(
        id: "task-jamec", title: "Relancer JAMEC sur le périmètre du portail",
        completed: false, dueDate: days(-1),
        organizationId: "org-jamec", organization: "JAMEC", dealId: "deal-jamec"
      ),
      CrmTask(
        id: "task-huot", title: "Finaliser la stratégie de sensibilisation S.Huot",
        completed: false, dueDate: days(0),
        organizationId: "org-s-huot", organization: "S.Huot", dealId: nil
      ),
      CrmTask(
        id: "task-vallee", title: "Qualifier la demande entrante de Forage Vallée",
        completed: false, dueDate: days(1),
        organizationId: "org-vallee", organization: "Vallée", dealId: nil
      ),
      CrmTask(
        id: "task-gii", title: "Vérifier la preuve DNCL pour Daniel Bergeron",
        completed: false, dueDate: days(2),
        organizationId: "org-gii", organization: "Groupe Industriel Interprovincial", dealId: nil
      ),
      CrmTask(
        id: "task-agenda", title: "Préparer l'ordre du jour de la révision de vendredi",
        completed: true, dueDate: days(-2),
        organizationId: "org-gii", organization: "Groupe Industriel Interprovincial", dealId: "deal-gii"
      ),
    ]

    let intakes: [IntakeSubmission] = [
      IntakeSubmission(
        id: "intake-vallee", organizationName: "Forage Vallée inc.",
        contactName: "Julie Côté", contactEmail: "julie.cote@foragevallee.ca",
        projectType: "Site web",
        message: "Bonjour, nous aimerions refondre notre site vitrine et ajouter un catalogue de produits en ligne. Pouvons-nous discuter d'une soumission?",
        createdAt: days(-0.4)
      ),
      IntakeSubmission(
        id: "intake-boudreaux", organizationName: "Atelier Métal Boudreaux",
        contactName: "Pierre Boudreaux", contactEmail: "pierre@metalboudreaux.ca",
        projectType: "Application",
        message: "Nous cherchons une application interne pour suivre les commandes d'atelier et les livraisons.",
        createdAt: days(-1.3)
      ),
    ]

    func event(_ id: String, _ state: DeliveryState, _ offset: Double) -> DeliveryEvent {
      DeliveryEvent(id: id, state: state, occurredAt: days(offset))
    }

    let conversations: [Conversation] = [
      Conversation(
        id: "conv-julie", mailboxAddress: "bonjour@27pm.org", contactId: "c-julie",
        contactName: "Julie Côté", contactEmail: "julie.cote@foragevallee.ca",
        organization: "Forage Vallée inc.",
        subject: "Demande de soumission — refonte du site",
        preview: "Bonjour, nous aimerions refondre notre site vitrine et ajouter un catalogue en ligne…",
        unread: true, followUp: false,
        messages: [
          CrmMessage(
            id: "m-julie-1", direction: .inbound, senderName: "Julie Côté",
            senderEmail: "julie.cote@foragevallee.ca", recipientLabel: "bonjour@27pm.org",
            sentAt: days(-0.15),
            body: "Bonjour,\n\nNous aimerions refondre notre site vitrine et ajouter un catalogue de produits en ligne. Pouvons-nous discuter d'une soumission?\n\nMerci!\nJulie Côté\nForage Vallée inc.",
            deliveryState: .received, deliveryEvents: []
          )
        ],
        dealId: nil, lastActivity: days(-0.15)
      ),
      Conversation(
        id: "conv-linda", mailboxAddress: "alexis@27pm.org", contactId: "c-mercier",
        contactName: "Linda Mercier", contactEmail: "operations@jamec.ca",
        organization: "JAMEC",
        subject: "Suivi — périmètre du portail client",
        preview: "Notre conseil se réunit jeudi. Avez-vous des questions sur le périmètre?",
        unread: true, followUp: true,
        messages: [
          CrmMessage(
            id: "m-linda-1", direction: .outbound, senderName: "Alexis Boulet",
            senderEmail: "alexis@27pm.org", recipientLabel: "Linda Mercier",
            sentAt: days(-3),
            body: "Bonjour Linda,\n\nMerci pour l'échange de lundi. J'analyse le périmètre du portail et je reviens vers vous avec une proposition de cadrage cette semaine.\n\nAlexis",
            deliveryState: .opened,
            deliveryEvents: [
              event("e-linda-sent", .sent, -3),
              event("e-linda-delivered", .delivered, -2.98),
              event("e-linda-opened", .opened, -2.8),
            ]
          ),
          CrmMessage(
            id: "m-linda-2", direction: .inbound, senderName: "Linda Mercier",
            senderEmail: "operations@jamec.ca", recipientLabel: "alexis@27pm.org",
            sentAt: days(-0.85),
            body: "Bonjour Alexis,\n\nNotre conseil se réunit jeudi. Avez-vous des questions sur le périmètre? Je peux vous transmettre les notes de notre dernier comité opérationnel.\n\nLinda",
            deliveryState: .received, deliveryEvents: []
          )
        ],
        dealId: "deal-jamec", lastActivity: days(-0.85)
      ),
      Conversation(
        id: "conv-marc", mailboxAddress: "alexis@27pm.org", contactId: "c-gagnon",
        contactName: "Marc Gagnon", contactEmail: "direction@s-huot.ca",
        organization: "S.Huot",
        subject: "RE: Estimateur de projet en ligne",
        preview: "Intéressant — pouvez-vous nous préparer une esquisse de l'estimateur?",
        unread: false, followUp: false,
        messages: [
          CrmMessage(
            id: "m-marc-1", direction: .outbound, senderName: "Alexis Boulet",
            senderEmail: "alexis@27pm.org", recipientLabel: "Marc Gagnon",
            sentAt: days(-6),
            body: "Bonjour Marc,\n\nSuite à notre appel, voici comment l'estimateur en ligne pourrait s'intégrer à la refonte : trois questions, une enveloppe indicative, et une demande de rencontre.\n\nAlexis",
            deliveryState: .opened,
            deliveryEvents: [
              event("e-marc-sent", .sent, -6),
              event("e-marc-delivered", .delivered, -5.97),
              event("e-marc-opened", .opened, -5.5),
            ]
          ),
          CrmMessage(
            id: "m-marc-2", direction: .inbound, senderName: "Marc Gagnon",
            senderEmail: "direction@s-huot.ca", recipientLabel: "alexis@27pm.org",
            sentAt: days(-5),
            body: "Bonjour Alexis,\n\nIntéressant — pouvez-vous nous préparer une esquisse de l'estimateur pour la rencontre de vendredi?\n\nMarc",
            deliveryState: .received, deliveryEvents: []
          ),
          CrmMessage(
            id: "m-marc-3", direction: .outbound, senderName: "Alexis Boulet",
            senderEmail: "alexis@27pm.org", recipientLabel: "Marc Gagnon",
            sentAt: days(-4.2),
            body: "Bonjour Marc,\n\nL'esquisse est prête — je l'apporte vendredi avec la proposition complète.\n\nAlexis",
            deliveryState: .delivered,
            deliveryEvents: [
              event("e-marc2-sent", .sent, -4.2),
              event("e-marc2-delivered", .delivered, -4.18),
            ]
          )
        ],
        dealId: "deal-shuot", lastActivity: days(-4.2)
      ),
      Conversation(
        id: "conv-pierre", mailboxAddress: "bonjour@27pm.org", contactId: "c-pierre",
        contactName: "Pierre Boudreaux", contactEmail: "pierre@metalboudreaux.ca",
        organization: "Atelier Métal Boudreaux",
        subject: "Application interne — suivi des commandes",
        preview: "Nous cherchons une application interne pour suivre les commandes d'atelier…",
        unread: false, followUp: false,
        messages: [
          CrmMessage(
            id: "m-pierre-1", direction: .inbound, senderName: "Pierre Boudreaux",
            senderEmail: "pierre@metalboudreaux.ca", recipientLabel: "bonjour@27pm.org",
            sentAt: days(-2),
            body: "Bonjour,\n\nNous cherchons une application interne pour suivre les commandes d'atelier et les livraisons. Avez-vous déjà réalisé des projets du genre?\n\nPierre Boudreaux",
            deliveryState: .received, deliveryEvents: []
          )
        ],
        dealId: nil, lastActivity: days(-2)
      ),
      Conversation(
        id: "conv-canary", mailboxAddress: "admin@27pm.org", contactId: "c-canary",
        contactName: "Surveillance 27PM", contactEmail: "surveillance@27pm.org",
        organization: "Opérations 27PM",
        subject: "Canari de délivrabilité — rapport quotidien",
        preview: "Le canari quotidien confirme une remise normale. Aucun signal anormal.",
        unread: false, followUp: false,
        messages: [
          CrmMessage(
            id: "m-canary-1", direction: .inbound, senderName: "Surveillance 27PM",
            senderEmail: "surveillance@27pm.org", recipientLabel: "admin@27pm.org",
            sentAt: days(-1),
            body: "Le canari quotidien confirme une remise normale.\n\nAucun signal SMTP anormal au cours des dernières 24 heures. Aucune action requise.",
            deliveryState: .received, deliveryEvents: []
          )
        ],
        dealId: nil, lastActivity: days(-1)
      ),
    ]

    let strategies: [OutreachStrategy] = [
      OutreachStrategy(
        id: "strat-shuot", organizationId: "org-s-huot", organization: "S.Huot",
        contactName: "Marc Gagnon", status: .draft,
        objective: "Décrocher une rencontre de qualification avec la direction",
        targetRole: "Direction générale",
        valueProposition: "Refonte de la vitrine et estimateur de projet en ligne",
        openingAngle: "Saison budgétaire : moderniser la vitrine avant la haute saison",
        emailReady: false,
        emailBlockReasons: [
          "Adresse courriel au statut inconnu — validation requise",
          "Pertinence du rôle à consigner avec preuve",
        ],
        steps: [
          OutreachStep(id: "s-shuot-1", sequenceIndex: 1, actionType: .research, title: "Documenter le compte", purpose: "Consolider les sources publiques et l'envergure des projets récents.", status: .done, scheduledAt: days(-6)),
          OutreachStep(id: "s-shuot-2", sequenceIndex: 2, actionType: .review, title: "Valider la recherche", purpose: "Vérifier les hypothèses et l'angle d'approche avant tout contact.", status: .ready, scheduledAt: days(-2)),
          OutreachStep(id: "s-shuot-3", sequenceIndex: 3, actionType: .email, title: "Premier courriel", purpose: "Proposer un échange court de 20 minutes autour de l'estimateur.", status: .blocked, scheduledAt: days(1)),
          OutreachStep(id: "s-shuot-4", sequenceIndex: 4, actionType: .call, title: "Relance téléphonique", purpose: "Confirmer la réception et clarifier les besoins.", status: .planned, scheduledAt: days(5)),
          OutreachStep(id: "s-shuot-5", sequenceIndex: 5, actionType: .nurture, title: "Mise en veille", purpose: "Réévaluer l'intérêt dans 30 jours si aucune réponse.", status: .planned, scheduledAt: days(30)),
        ]
      ),
      OutreachStrategy(
        id: "strat-jamec", organizationId: "org-jamec", organization: "JAMEC",
        contactName: "Linda Mercier", status: .active,
        objective: "Cadrer le périmètre du portail client",
        targetRole: "Directrice des opérations",
        valueProposition: "Portail client : suivi de commandes et facturation centralisée",
        openingAngle: "Suite à la demande de soumission du portail",
        emailReady: false,
        emailBlockReasons: ["Adresse au statut inconnu — validation requise"],
        steps: [
          OutreachStep(id: "s-jamec-1", sequenceIndex: 1, actionType: .research, title: "Documenter le compte", purpose: "Cartographier les opérations et les points de friction actuels.", status: .done, scheduledAt: days(-7)),
          OutreachStep(id: "s-jamec-2", sequenceIndex: 2, actionType: .review, title: "Valider la recherche", purpose: "Confirmer le rôle de la directrice des opérations comme interlocutrice.", status: .done, scheduledAt: days(-4)),
          OutreachStep(id: "s-jamec-3", sequenceIndex: 3, actionType: .email, title: "Premier courriel officiel", purpose: "Confirmer par écrit le périmètre discuté au téléphone.", status: .blocked, scheduledAt: days(0)),
          OutreachStep(id: "s-jamec-4", sequenceIndex: 4, actionType: .call, title: "Relance avant le conseil", purpose: "S'assurer que la proposition sera prête pour le conseil de jeudi.", status: .planned, scheduledAt: days(2)),
        ]
      ),
    ]

    let activities: [ActivityEntry] = [
      ActivityEntry(id: "a-1", action: "Stratégie de sensibilisation créée pour JAMEC", createdAt: days(-2)),
      ActivityEntry(id: "a-2", action: "Opportunité passée en proposition — S.Huot", createdAt: days(-4)),
      ActivityEntry(id: "a-3", action: "Tâche terminée : ordre du jour de la révision", createdAt: days(-2)),
      ActivityEntry(id: "a-4", action: "Deux demandes entrantes reçues par bonjour@27pm.org", createdAt: days(-0.5)),
    ]

    return DashboardData(
      mailboxes: mailboxes,
      transportState: .configuration,
      conversations: conversations,
      organizations: organizations,
      contacts: contacts,
      deals: deals,
      tasks: tasks,
      strategies: strategies,
      intakes: intakes,
      activities: activities
    )
  }
}
