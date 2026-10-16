import Foundation
import Testing
@testable import App27pmCRM

@MainActor
@Suite
struct InboxProjectionTests {
  private let mailboxes = [
    Mailbox(
      id: "mailbox-bonjour",
      address: "bonjour@27pm.org",
      label: "Prospects et clients",
      kind: .sales
    ),
    Mailbox(
      id: "mailbox-admin",
      address: "admin@27pm.org",
      label: "Comptes et opérations",
      kind: .operations
    ),
  ]

  @Test func selectedMailboxKeepsAnAvailableRequest() {
    let selected = InboxProjection.selectedMailboxAddress(
      requested: "admin@27pm.org",
      mailboxes: mailboxes
    )

    #expect(selected == "admin@27pm.org")
  }

  @Test func selectedMailboxFallsBackToFirstAvailableMailbox() {
    let selected = InboxProjection.selectedMailboxAddress(
      requested: "removed@27pm.org",
      mailboxes: mailboxes
    )

    #expect(selected == "bonjour@27pm.org")
  }

  @Test func selectedMailboxUsesFirstAvailableMailboxWithoutPriorSelection() {
    let selected = InboxProjection.selectedMailboxAddress(
      requested: nil,
      mailboxes: mailboxes
    )

    #expect(selected == "bonjour@27pm.org")
  }

  @Test func selectedMailboxReturnsNilWhenNoMailboxIsAvailable() {
    let selected = InboxProjection.selectedMailboxAddress(
      requested: "bonjour@27pm.org",
      mailboxes: []
    )

    #expect(selected == nil)
  }

  @Test func conversationsStayInSelectedMailboxAndSortNewestFirst() {
    let conversations = [
      conversation(
        id: "older-selected",
        mailboxAddress: "bonjour@27pm.org",
        lastActivity: Date(timeIntervalSince1970: 100)
      ),
      conversation(
        id: "newer-other-mailbox",
        mailboxAddress: "admin@27pm.org",
        lastActivity: Date(timeIntervalSince1970: 300)
      ),
      conversation(
        id: "newer-selected",
        mailboxAddress: "bonjour@27pm.org",
        lastActivity: Date(timeIntervalSince1970: 200)
      ),
    ]

    let projected = InboxProjection.conversations(
      conversations,
      mailboxAddress: "bonjour@27pm.org",
      filter: .all,
      query: ""
    )

    #expect(projected.map(\.id) == ["newer-selected", "older-selected"])
  }

  @Test func unreadAndFollowUpFiltersAreIndependent() {
    let conversations = [
      conversation(id: "unread", unread: true),
      conversation(id: "follow-up", followUp: true),
      conversation(id: "both", unread: true, followUp: true),
      conversation(id: "neither"),
    ]

    let unread = InboxProjection.conversations(
      conversations,
      mailboxAddress: "bonjour@27pm.org",
      filter: .unread,
      query: ""
    )
    let followUp = InboxProjection.conversations(
      conversations,
      mailboxAddress: "bonjour@27pm.org",
      filter: .followUp,
      query: ""
    )

    #expect(Set(unread.map(\.id)) == Set(["unread", "both"]))
    #expect(Set(followUp.map(\.id)) == Set(["follow-up", "both"]))
  }

  @Test func conversationsUseIdentifierAsDeterministicDateTieBreaker() {
    let sameActivity = Date(timeIntervalSince1970: 500)
    let conversations = [
      conversation(id: "z-last", lastActivity: sameActivity),
      conversation(id: "a-first", lastActivity: sameActivity),
    ]

    let projected = InboxProjection.conversations(
      conversations,
      mailboxAddress: "bonjour@27pm.org",
      filter: .all,
      query: ""
    )

    #expect(projected.map(\.id) == ["a-first", "z-last"])
  }

  @Test func searchTrimsQueryAndMatchesContactOrganizationOrSubject() {
    let conversations = [
      conversation(id: "contact", contactName: "Josée Tremblay"),
      conversation(id: "organization", organization: "Atelier Québec"),
      conversation(id: "subject", subject: "Refonte du portail"),
      conversation(id: "unrelated", contactName: "Marc Roy", subject: "Facture"),
    ]

    let contactMatches = InboxProjection.conversations(
      conversations,
      mailboxAddress: "bonjour@27pm.org",
      filter: .all,
      query: "  josee  "
    )
    let organizationMatches = InboxProjection.conversations(
      conversations,
      mailboxAddress: "bonjour@27pm.org",
      filter: .all,
      query: "québec"
    )
    let subjectMatches = InboxProjection.conversations(
      conversations,
      mailboxAddress: "bonjour@27pm.org",
      filter: .all,
      query: "PORTAIL"
    )

    #expect(contactMatches.map(\.id) == ["contact"])
    #expect(organizationMatches.map(\.id) == ["organization"])
    #expect(subjectMatches.map(\.id) == ["subject"])
  }

  @Test func noSelectedMailboxProducesNoConversation() {
    let projected = InboxProjection.conversations(
      [conversation(id: "conversation")],
      mailboxAddress: nil,
      filter: .all,
      query: ""
    )

    #expect(projected.isEmpty)
  }

  @Test func emptyStateExplainsThatNoMailboxIsAvailable() {
    let state = InboxProjection.emptyState(
      mailboxes: [],
      mailboxAddress: nil,
      filter: .all,
      query: ""
    )

    #expect(state == InboxEmptyState(
      title: "Aucune boîte disponible",
      message: "La liste des boîtes courriel n’est pas disponible pour le moment."
    ))
  }

  @Test func emptyStatePrioritizesTrimmedSearchContext() {
    let state = InboxProjection.emptyState(
      mailboxes: mailboxes,
      mailboxAddress: "bonjour@27pm.org",
      filter: .unread,
      query: "  budget  "
    )

    #expect(state == InboxEmptyState(
      title: "Aucun résultat",
      message: "Aucune conversation ne correspond à « budget » dans cette boîte."
    ))
  }

  @Test func emptyStateDistinguishesUnreadFollowUpAndEmptyMailbox() {
    let unread = InboxProjection.emptyState(
      mailboxes: mailboxes,
      mailboxAddress: "bonjour@27pm.org",
      filter: .unread,
      query: ""
    )
    let followUp = InboxProjection.emptyState(
      mailboxes: mailboxes,
      mailboxAddress: "bonjour@27pm.org",
      filter: .followUp,
      query: ""
    )
    let mailbox = InboxProjection.emptyState(
      mailboxes: mailboxes,
      mailboxAddress: "bonjour@27pm.org",
      filter: .all,
      query: ""
    )

    #expect(unread == InboxEmptyState(
      title: "Tout est lu",
      message: "Aucune conversation non lue dans cette boîte."
    ))
    #expect(followUp == InboxEmptyState(
      title: "Aucune relance",
      message: "Aucune conversation à relancer dans cette boîte."
    ))
    #expect(mailbox == InboxEmptyState(
      title: "Boîte vide",
      message: "Aucune conversation dans cette boîte."
    ))
  }

  private func conversation(
    id: String,
    mailboxAddress: String = "bonjour@27pm.org",
    contactName: String = "Client",
    organization: String = "Organisation",
    subject: String = "Sujet",
    unread: Bool = false,
    followUp: Bool = false,
    lastActivity: Date = Date(timeIntervalSince1970: 1_000)
  ) -> Conversation {
    Conversation(
      id: id,
      mailboxAddress: mailboxAddress,
      contactId: "contact-\(id)",
      contactName: contactName,
      contactEmail: "\(id)@example.com",
      organization: organization,
      subject: subject,
      preview: "Aperçu",
      unread: unread,
      followUp: followUp,
      messages: [],
      dealId: nil,
      lastActivity: lastActivity
    )
  }
}
