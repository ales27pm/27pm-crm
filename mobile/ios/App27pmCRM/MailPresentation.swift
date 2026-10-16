import Foundation

/// User-selected inbox subset. Kept outside the view so filtering can be
/// verified without rendering SwiftUI.
enum InboxFilter: String, CaseIterable, Identifiable {
  case all = "Tous"
  case unread = "Non lus"
  case followUp = "Relances"

  var id: String { rawValue }
}

struct InboxEmptyState: Equatable {
  let title: String
  let message: String
}

/// Deterministic presentation projection for the inbox. The view owns only
/// the operator's requested selection and delegates fallback/filtering here.
enum InboxProjection {
  static func selectedMailboxAddress(
    requested: String?,
    mailboxes: [Mailbox]
  ) -> String? {
    if let requested, mailboxes.contains(where: { $0.address == requested }) {
      return requested
    }
    return mailboxes.first?.address
  }

  static func conversations(
    _ conversations: [Conversation],
    mailboxAddress: String?,
    filter: InboxFilter,
    query: String
  ) -> [Conversation] {
    guard let mailboxAddress else { return [] }
    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)

    return conversations
      .filter { $0.mailboxAddress == mailboxAddress }
      .filter { conversation in
        switch filter {
        case .all: true
        case .unread: conversation.unread
        case .followUp: conversation.followUp
        }
      }
      .filter { conversation in
        guard !trimmedQuery.isEmpty else { return true }
        return conversation.contactName.localizedStandardContains(trimmedQuery)
          || conversation.contactEmail.localizedStandardContains(trimmedQuery)
          || conversation.organization.localizedStandardContains(trimmedQuery)
          || conversation.subject.localizedStandardContains(trimmedQuery)
          || conversation.preview.localizedStandardContains(trimmedQuery)
      }
      .sorted { left, right in
        if left.lastActivity == right.lastActivity {
          return left.id < right.id
        }
        return left.lastActivity > right.lastActivity
      }
  }

  static func emptyState(
    mailboxes: [Mailbox],
    mailboxAddress: String?,
    filter: InboxFilter,
    query: String
  ) -> InboxEmptyState {
    guard !mailboxes.isEmpty, mailboxAddress != nil else {
      return InboxEmptyState(
        title: "Aucune boîte disponible",
        message: "La liste des boîtes courriel n’est pas disponible pour le moment."
      )
    }

    let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
    if !trimmedQuery.isEmpty {
      return InboxEmptyState(
        title: "Aucun résultat",
        message: "Aucune conversation ne correspond à « \(trimmedQuery) » dans cette boîte."
      )
    }

    switch filter {
    case .all:
      return InboxEmptyState(
        title: "Boîte vide",
        message: "Aucune conversation dans cette boîte."
      )
    case .unread:
      return InboxEmptyState(
        title: "Tout est lu",
        message: "Aucune conversation non lue dans cette boîte."
      )
    case .followUp:
      return InboxEmptyState(
        title: "Aucune relance",
        message: "Aucune conversation à relancer dans cette boîte."
      )
    }
  }
}

/// Identity passed to the reply sheet. The sheet resolves fresh conversation
/// data from the store instead of holding a stale snapshot.
struct DraftComposeRoute: Identifiable, Equatable {
  let id: String
}
