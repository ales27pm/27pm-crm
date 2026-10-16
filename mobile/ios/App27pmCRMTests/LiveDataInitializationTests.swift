import Foundation
import Testing
@testable import App27pmCRM

@Suite(.serialized)
@MainActor
struct LiveDataInitializationTests {
  @Test func authenticatedSessionWithoutCacheStartsWithHonestEmptyLiveData() {
    let directory = FileManager.default.temporaryDirectory
      .appending(path: "live-empty-\(UUID().uuidString)", directoryHint: .isDirectory)
    defer { try? FileManager.default.removeItem(at: directory) }

    let persistence = DeviceTokenPersistence(
      read: { account in
        account == DeviceAuth.accessTokenAccount ? "test-access-token" : nil
      },
      save: { _, _ in },
      delete: { _ in true }
    )
    let auth = DeviceAuth(tokenPersistence: persistence)
    let store = CrmStore(
      auth: auth,
      offlineCache: OfflineCache(directory: directory)
    )

    if case .demo = store.mode {
      Issue.record("Une session authentifiée doit démarrer en mode live")
    }
    #expect(store.data.mailboxes.isEmpty)
    #expect(store.data.conversations.isEmpty)
    #expect(store.data.organizations.isEmpty)
    #expect(store.data.contacts.isEmpty)
    #expect(store.data.deals.isEmpty)
    #expect(store.data.tasks.isEmpty)
    #expect(store.data.strategies.isEmpty)
    #expect(store.data.intakes.isEmpty)
    #expect(store.data.activities.isEmpty)
  }
}
