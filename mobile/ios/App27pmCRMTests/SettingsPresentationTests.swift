import Foundation
import Testing
@testable import App27pmCRM

@Suite
struct SettingsPresentationTests {
  @Test func syncRecencyClampsSlightClockSkewInsteadOfShowingNegativeTime() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(Fmt.syncRecency(now.addingTimeInterval(3), to: now) == "à l'instant")
    #expect(Fmt.syncRecency(now, to: now) == "à l'instant")
  }

  @Test func syncRecencyUsesExplicitPastTenseUnits() {
    let now = Date(timeIntervalSince1970: 1_800_000_000)
    #expect(Fmt.syncRecency(now.addingTimeInterval(-12), to: now) == "il y a 12 s")
    #expect(Fmt.syncRecency(now.addingTimeInterval(-90), to: now) == "il y a 1 min")
  }

  @Test func exchangeConfigurationCopyDoesNotClaimMailgunIsActive() {
    let copy = TransportProvider.exchange.settingsDescription(for: .configuration)
    #expect(TransportProvider.exchange.settingsTitle(for: .configuration) == "Microsoft Exchange — envoi désactivé")
    #expect(copy.contains("Microsoft Exchange"))
    #expect(copy.contains("L'envoi reste désactivé"))
    #expect(!copy.contains("Mailgun"))
  }
}
