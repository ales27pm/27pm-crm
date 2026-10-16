import Foundation
import Testing
@testable import App27pmCRM

@Suite
struct MailDashboardMappingTests {
  @MainActor
  @Test func conversationActivityUsesCanonicalThenNewestMessageThenDistantPast() throws {
    let json = """
      {
        "mailboxes": [],
        "transportState": "configuration",
        "transportProvider": "exchange",
        "conversations": [
          {
            "id": "canonical",
            "mailboxAddress": "bonjour@27pm.org",
            "subject": "Canonique",
            "lastActivityAt": "2026-10-20T12:00:00Z",
            "unread": false,
            "followUp": false,
            "messages": [
              { "id": "m1", "direction": "inbound", "sentAtIso": "2026-10-15T12:00:00Z", "body": "Un" }
            ]
          },
          {
            "id": "newest-message",
            "mailboxAddress": "bonjour@27pm.org",
            "subject": "Messages",
            "unread": false,
            "followUp": false,
            "messages": [
              { "id": "new", "direction": "inbound", "sentAtIso": "2026-10-18T12:00:00Z", "body": "Nouveau" },
              { "id": "old", "direction": "inbound", "sentAtIso": "2026-10-10T12:00:00Z", "body": "Ancien" }
            ]
          },
          {
            "id": "undated",
            "mailboxAddress": "bonjour@27pm.org",
            "subject": "Sans date",
            "unread": false,
            "followUp": false,
            "messages": []
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
      now: Date(timeIntervalSince1970: 9_999_999)
    )

    let canonical = try #require(dashboard.conversations.first { $0.id == "canonical" })
    let newest = try #require(dashboard.conversations.first { $0.id == "newest-message" })
    let undated = try #require(dashboard.conversations.first { $0.id == "undated" })
    let canonicalDate = try #require(ApiDate.parse("2026-10-20T12:00:00Z"))
    let newestDate = try #require(ApiDate.parse("2026-10-18T12:00:00Z"))

    #expect(canonical.lastActivity == canonicalDate)
    #expect(newest.lastActivity == newestDate)
    #expect(undated.lastActivity == Date.distantPast)
  }
}
