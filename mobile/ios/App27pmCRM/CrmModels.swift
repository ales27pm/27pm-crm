import Foundation

// MARK: - Primitives

enum MailboxKind: String {
  case sales
  case operations
}

enum TransportState: String {
  case operational
  case configuration
  case degraded

  var label: String {
    switch self {
    case .operational: "Courriel opérationnel"
    case .configuration: "Configuration courriel"
    case .degraded: "Courriel à vérifier"
    }
  }
}

enum Priority: String {
  case veryHigh = "very_high"
  case high
  case normal
  case low

  var label: String {
    switch self {
    case .veryHigh: "Priorité très élevée"
    case .high: "Priorité élevée"
    case .normal: "Priorité normale"
    case .low: "Priorité basse"
    }
  }

  var shortLabel: String {
    switch self {
    case .veryHigh: "Très haute"
    case .high: "Haute"
    case .normal: "Normale"
    case .low: "Basse"
    }
  }
}

enum PipelineStage: String, CaseIterable {
  case nouveau
  case qualifie
  case proposition
  case production
  case gagne

  var label: String {
    switch self {
    case .nouveau: "Nouveau"
    case .qualifie: "Qualifié"
    case .proposition: "Proposition"
    case .production: "En production"
    case .gagne: "Gagné"
    }
  }

  var next: PipelineStage? {
    PipelineStage.allCases.firstIndex(of: self).flatMap { index in
      guard index + 1 < PipelineStage.allCases.count else { return nil }
      return PipelineStage.allCases[index + 1]
    }
  }

  var previous: PipelineStage? {
    PipelineStage.allCases.firstIndex(of: self).flatMap { index in
      guard index > 0 else { return nil }
      return PipelineStage.allCases[index - 1]
    }
  }
}

enum ProjectType: String, CaseIterable {
  case siteWeb = "Site web"
  case application = "Application"
  case produitNumerique = "Produit numérique"
}

// MARK: - Mail & conversations

enum MessageDirection: String {
  case inbound
  case outbound
}

enum DeliveryState: String {
  case received
  case draft
  case queued
  case sent
  case delivered
  case opened
  case bounced

  var label: String {
    switch self {
    case .received: "Reçu"
    case .draft: "Brouillon"
    case .queued: "En file"
    case .sent: "Envoyé"
    case .delivered: "Remis"
    case .opened: "Ouvert"
    case .bounced: "Rebond"
    }
  }

  var isTerminalSuccess: Bool {
    self == .delivered || self == .opened
  }
}

struct DeliveryEvent: Identifiable, Hashable {
  let id: String
  let state: DeliveryState
  let occurredAt: Date
}

struct CrmMessage: Identifiable {
  let id: String
  let direction: MessageDirection
  let senderName: String
  let senderEmail: String
  let recipientLabel: String
  let sentAt: Date
  let body: String
  let deliveryState: DeliveryState
  let deliveryEvents: [DeliveryEvent]
}

struct Mailbox: Identifiable, Hashable {
  let id: String
  let address: String
  let label: String
  let kind: MailboxKind
}

struct Conversation: Identifiable {
  let id: String
  let mailboxAddress: String
  let contactId: String
  let contactName: String
  let contactEmail: String
  let organization: String
  let subject: String
  var preview: String
  var unread: Bool
  var followUp: Bool
  var messages: [CrmMessage]
  let dealId: String?
  var lastActivity: Date
}

// MARK: - Accounts & contacts

struct Contact: Identifiable {
  let id: String
  let name: String
  let email: String
  let role: String
  let organization: String
  let organizationId: String
  let source: String
  let sourceUrl: String?
  let dnclStatus: String
  let emailStatus: String
  let emailReady: Bool
  let emailBlockReasons: [String]
  let lastContactAt: Date?
  /// Server-provided phone (crm.27pm.org contract). Optional with a nil
  /// default so existing initializers keep compiling; a local override is
  /// kept in LocalFieldStore until the server exposes the field.
  var phone: String? = nil
}

struct Organization: Identifiable {
  let id: String
  let name: String
  let score: Int
  let priority: Priority
  let budgetMinCents: Int
  let budgetMaxCents: Int
  let budgetIsHypothesis: Bool
  var nextStep: String?
  let notes: String
  var nextFollowUpAt: Date?
  let sourceLabel: String
  /// Server-provided location fields (crm.27pm.org contract). Optional with
  /// nil defaults so existing initializers keep compiling; until the server
  /// exposes them, the operator-entered value lives in LocalFieldStore.
  var address: String? = nil
  var city: String? = nil
}

// MARK: - Deals & interactions

enum InteractionKind: String {
  case call
  case email
  case meeting
  case note
  case other

  var label: String {
    switch self {
    case .call: "Appel"
    case .email: "Courriel"
    case .meeting: "Rencontre"
    case .note: "Note"
    case .other: "Autre"
    }
  }

  var symbol: String {
    switch self {
    case .call: "phone"
    case .email: "envelope"
    case .meeting: "person.2"
    case .note: "square.and.pencil"
    case .other: "circle"
    }
  }
}

struct Interaction: Identifiable {
  let id: String
  let kind: InteractionKind
  let summary: String
  let occurredAt: Date
  let createdBy: String
}

struct Deal: Identifiable {
  let id: String
  let organizationId: String
  let contactId: String
  let title: String
  let contactName: String
  let organization: String
  let projectType: ProjectType
  var stage: PipelineStage
  var nextAction: String
  var nextActionDate: Date?
  let note: String
  var interactions: [Interaction]
}

// MARK: - Tasks, intakes, activities

struct CrmTask: Identifiable {
  let id: String
  let title: String
  var completed: Bool
  let dueDate: Date?
  let organizationId: String
  let organization: String
  let dealId: String?
}

struct IntakeSubmission: Identifiable {
  let id: String
  let organizationName: String
  let contactName: String
  let contactEmail: String
  let projectType: String?
  let message: String
  let createdAt: Date
}

struct ActivityEntry: Identifiable {
  let id: String
  let action: String
  let createdAt: Date
}

// MARK: - Outreach strategies

enum StepAction: String {
  case research
  case review
  case email
  case call
  case nurture

  var label: String {
    switch self {
    case .research: "Recherche"
    case .review: "Validation"
    case .email: "Courriel"
    case .call: "Appel"
    case .nurture: "Veille"
    }
  }

  var symbol: String {
    switch self {
    case .research: "magnifyingglass"
    case .review: "checkmark.seal"
    case .email: "envelope"
    case .call: "phone"
    case .nurture: "leaf"
    }
  }
}

enum StepStatus: String {
  case planned
  case ready
  case blocked
  case done
  case skipped

  var label: String {
    switch self {
    case .planned: "Planifiée"
    case .ready: "Prête"
    case .blocked: "Bloquée"
    case .done: "Complétée"
    case .skipped: "Écartée"
    }
  }
}

enum StrategyStatus: String {
  case draft
  case ready
  case active
  case paused
  case completed
  case archived

  var label: String {
    switch self {
    case .draft: "Brouillon"
    case .ready: "Prête"
    case .active: "Active"
    case .paused: "En pause"
    case .completed: "Terminée"
    case .archived: "Archivée"
    }
  }
}

struct OutreachStep: Identifiable {
  let id: String
  let sequenceIndex: Int
  let actionType: StepAction
  let title: String
  let purpose: String
  var status: StepStatus
  let scheduledAt: Date
}

struct OutreachStrategy: Identifiable {
  let id: String
  let organizationId: String
  let organization: String
  let contactName: String?
  let status: StrategyStatus
  let objective: String
  let targetRole: String
  let valueProposition: String
  let openingAngle: String
  let emailReady: Bool
  let emailBlockReasons: [String]
  var steps: [OutreachStep]
}

// MARK: - Aggregate

struct DashboardData {
  let mailboxes: [Mailbox]
  var transportState: TransportState
  var conversations: [Conversation]
  var organizations: [Organization]
  var contacts: [Contact]
  var deals: [Deal]
  var tasks: [CrmTask]
  var strategies: [OutreachStrategy]
  var intakes: [IntakeSubmission]
  var activities: [ActivityEntry]
}
