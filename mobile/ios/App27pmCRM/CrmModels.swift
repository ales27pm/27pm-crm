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

enum TransportProvider: String {
  case mailgun
  case cakemail
  case exchange
  case unknown

  func settingsTitle(for state: TransportState) -> String {
    let providerName = switch self {
    case .mailgun: "Mailgun"
    case .cakemail: "Cakemail"
    case .exchange: "Microsoft Exchange"
    case .unknown: ""
    }
    guard !providerName.isEmpty else { return state.label }
    let stateLabel = switch state {
    case .operational: "envoi activé"
    case .configuration: "envoi désactivé"
    case .degraded: "envoi à vérifier"
    }
    return "\(providerName) — \(stateLabel)"
  }

  func settingsDescription(for state: TransportState) -> String {
    switch (self, state) {
    case (.exchange, .operational):
      "Microsoft Exchange est configuré pour synchroniser les boîtes et envoyer les courriels."
    case (.exchange, .configuration):
      "Microsoft Exchange synchronise les boîtes. L'envoi reste désactivé pendant la validation du transport sortant."
    case (.exchange, .degraded):
      "Microsoft Exchange doit être vérifié avant tout nouvel envoi."
    case (.mailgun, .operational):
      "Mailgun est configuré pour envoyer les courriels."
    case (.mailgun, .configuration):
      "Mailgun doit être configuré avant tout nouvel envoi."
    case (.mailgun, .degraded):
      "Mailgun doit être vérifié avant tout nouvel envoi."
    case (.cakemail, .operational):
      "Cakemail est configuré pour envoyer les courriels."
    case (.cakemail, .configuration):
      "Cakemail doit être configuré avant tout nouvel envoi."
    case (.cakemail, .degraded):
      "Cakemail doit être vérifié avant tout nouvel envoi."
    case (.unknown, .operational):
      "Le transport courriel est configuré pour l'envoi."
    case (.unknown, .configuration):
      "Le transport sortant n'est pas encore activé. Aucun nouveau courriel ne sera envoyé."
    case (.unknown, .degraded):
      "Le transport courriel doit être vérifié avant tout nouvel envoi."
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

enum DeliveryState: String, CaseIterable {
  case received
  case draft
  case queued
  case accepted
  case sent
  case delivered
  /// Legacy provider signal. It does not prove that a human read the message.
  case opened
  case temporaryFailure = "temporary-failure"
  case permanentFailure = "permanent-failure"
  case bounced
  case complained
  case unknown

  /// Converts the server/provider spelling to the finite presentation model.
  /// Missing or unrecognized values remain unknown; they must never be
  /// presented as received or sent.
  static func canonical(_ rawValue: String?) -> DeliveryState {
    guard let rawValue else { return .unknown }
    let normalized = rawValue
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased()
      .replacingOccurrences(of: "_", with: "-")
    return DeliveryState(rawValue: normalized) ?? .unknown
  }

  var label: String {
    switch self {
    case .received: "Reçu"
    case .draft: "Brouillon temporaire"
    case .queued: "En file d’attente"
    case .accepted: "Accepté par le transport"
    case .sent: "Envoyé"
    case .delivered: "Remis au serveur destinataire"
    case .opened: "Ouvert (signal historique)"
    case .temporaryFailure: "Échec temporaire"
    case .permanentFailure: "Échec permanent"
    case .bounced: "Rebond"
    case .complained: "Signalé comme indésirable"
    case .unknown: "État inconnu"
    }
  }

  var symbolName: String {
    switch self {
    case .received: "envelope.fill"
    case .draft: "pencil.circle.fill"
    case .queued: "clock.fill"
    case .accepted: "tray.and.arrow.up.fill"
    case .sent: "paperplane.fill"
    case .delivered: "checkmark.circle.fill"
    case .opened: "eye.fill"
    case .temporaryFailure: "exclamationmark.triangle.fill"
    case .permanentFailure: "xmark.octagon.fill"
    case .bounced: "arrow.uturn.backward.circle.fill"
    case .complained: "hand.raised.fill"
    case .unknown: "questionmark.circle.fill"
    }
  }

  var isTerminalSuccess: Bool {
    self == .delivered || self == .opened
  }

  var isFailure: Bool {
    switch self {
    case .temporaryFailure, .permanentFailure, .bounced, .complained:
      true
    default:
      false
    }
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
  var transportProvider: TransportProvider = .unknown
  var conversations: [Conversation]
  var organizations: [Organization]
  var contacts: [Contact]
  var deals: [Deal]
  var tasks: [CrmTask]
  var strategies: [OutreachStrategy]
  var intakes: [IntakeSubmission]
  var activities: [ActivityEntry]

  /// Honest placeholder for an authenticated session before its first genuine
  /// cache or server payload. Live mode must never expose bundled demo records.
  static let emptyLive = DashboardData(
    mailboxes: [],
    transportState: .configuration,
    transportProvider: .unknown,
    conversations: [],
    organizations: [],
    contacts: [],
    deals: [],
    tasks: [],
    strategies: [],
    intakes: [],
    activities: []
  )
}
