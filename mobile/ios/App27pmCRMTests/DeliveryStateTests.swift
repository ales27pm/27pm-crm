import Foundation
import Testing
@testable import App27pmCRM

@Suite
struct DeliveryStateTests {
  @Test func canonicalDecodesEveryServerDeliveryState() {
    #expect(DeliveryState.canonical("received") == .received)
    #expect(DeliveryState.canonical("draft") == .draft)
    #expect(DeliveryState.canonical("queued") == .queued)
    #expect(DeliveryState.canonical("accepted") == .accepted)
    #expect(DeliveryState.canonical("sent") == .sent)
    #expect(DeliveryState.canonical("delivered") == .delivered)
    #expect(DeliveryState.canonical("opened") == .opened)
    #expect(DeliveryState.canonical("temporary-failure") == .temporaryFailure)
    #expect(DeliveryState.canonical("permanent-failure") == .permanentFailure)
    #expect(DeliveryState.canonical("bounced") == .bounced)
    #expect(DeliveryState.canonical("complained") == .complained)
  }

  @Test func canonicalKeepsMissingOrUnsupportedServerStatesExplicitlyUnknown() {
    #expect(DeliveryState.canonical(nil) == .unknown)
    #expect(DeliveryState.canonical("") == .unknown)
    #expect(DeliveryState.canonical("provider-specific-state") == .unknown)
  }

  @MainActor
  @Test func dashboardMapperUsesCanonicalStatesForMessagesAndEvents() throws {
    let json = """
      {
        "mailboxes": [],
        "transportState": "configuration",
        "transportProvider": "exchange",
        "conversations": [
          {
            "id": "conversation-1",
            "mailboxAddress": "bonjour@27pm.org",
            "subject": "État de livraison",
            "unread": false,
            "followUp": false,
            "messages": [
              {
                "id": "message-known",
                "direction": "outbound",
                "body": "Connu",
                "deliveryState": "permanent-failure",
                "deliveryEvents": [
                  { "state": "complained", "occurredAt": "2026-10-15T12:01:00Z" }
                ]
              },
              {
                "id": "message-unknown",
                "direction": "outbound",
                "body": "Inconnu",
                "deliveryState": "provider-specific-state",
                "deliveryEvents": [
                  { "state": "provider-specific-event", "occurredAt": "2026-10-15T12:02:00Z" }
                ]
              }
            ]
          }
        ],
        "organizations": [],
        "contacts": [],
        "deals": [],
        "tasks": [],
        "strategies": [],
        "intakes": [],
        "activities": []
      }
      """
    let payload = try JSONDecoder().decode(
      DashboardPayloadDTO.self,
      from: Data(json.utf8)
    )
    let dashboard = DashboardMapper.map(
      payload,
      now: Date(timeIntervalSince1970: 1_000)
    )
    let messages = try #require(dashboard.conversations.first?.messages)

    #expect(messages.map(\.deliveryState) == [.permanentFailure, .unknown])
    #expect(messages[0].deliveryEvents.map(\.state) == [.complained])
    #expect(messages[1].deliveryEvents.map(\.state) == [.unknown])
  }

  @Test func canonicalNormalizesWhitespaceCaseAndKnownSeparatorVariant() {
    #expect(DeliveryState.canonical("  DELIVERED  ") == .delivered)
    #expect(DeliveryState.canonical(" Temporary-Failure ") == .temporaryFailure)
    #expect(DeliveryState.canonical("temporary_failure") == .temporaryFailure)
  }

  @Test func failureClassificationCoversEveryFailureAndNoSuccessState() {
    let failures: [DeliveryState] = [
      .temporaryFailure,
      .permanentFailure,
      .bounced,
      .complained,
    ]
    let nonFailures: [DeliveryState] = [
      .received,
      .draft,
      .queued,
      .accepted,
      .sent,
      .delivered,
      .opened,
      .unknown,
    ]

    #expect(failures.allSatisfy { $0.isFailure })
    #expect(nonFailures.allSatisfy { !$0.isFailure })
  }

  @Test func everyDeliveryStateHasCanonicalAccessiblePresentation() {
    let presentations: [(state: DeliveryState, label: String, symbolName: String)] = [
      (.received, "Reçu", "envelope.fill"),
      (.draft, "Brouillon temporaire", "pencil.circle.fill"),
      (.queued, "En file d’attente", "clock.fill"),
      (.accepted, "Accepté par le transport", "tray.and.arrow.up.fill"),
      (.sent, "Envoyé", "paperplane.fill"),
      (.delivered, "Remis au serveur destinataire", "checkmark.circle.fill"),
      (.opened, "Ouvert (signal historique)", "eye.fill"),
      (.temporaryFailure, "Échec temporaire", "exclamationmark.triangle.fill"),
      (.permanentFailure, "Échec permanent", "xmark.octagon.fill"),
      (.bounced, "Rebond", "arrow.uturn.backward.circle.fill"),
      (.complained, "Signalé comme indésirable", "hand.raised.fill"),
      (.unknown, "État inconnu", "questionmark.circle.fill"),
    ]

    for presentation in presentations {
      #expect(presentation.state.label == presentation.label)
      #expect(presentation.state.symbolName == presentation.symbolName)
    }
  }
}
