import Foundation
import XCTest
@testable import App27pmCRM

@MainActor
private final class AttachmentTransportStub: AttachmentAPITransport {
  enum StubError: Error { case disconnected }

  var uploadResults: [Result<AttachmentHTTPResult, Error>] = []
  var downloadResults: [Result<AttachmentHTTPResult, Error>] = []
  var deleteResults: [Result<AttachmentHTTPResult, Error>] = []
  var listResults: [Result<AttachmentHTTPResult, Error>] = []
  private(set) var uploadCalls: [(data: Data, name: String, key: String)] = []
  private(set) var downloadIDs: [String] = []
  private(set) var deleteIDs: [String] = []
  private(set) var listRequests: [(ownerKind: String, ownerId: String)] = []

  func uploadAttachment(
    fileData: Data,
    fileName: String,
    mimeType: String,
    ownerKind: String,
    ownerId: String,
    idempotencyKey: String
  ) async throws -> AttachmentHTTPResult {
    uploadCalls.append((fileData, fileName, idempotencyKey))
    return try next(&uploadResults)
  }

  func downloadAttachment(id: String) async throws -> AttachmentHTTPResult {
    downloadIDs.append(id)
    return try next(&downloadResults)
  }

  func deleteAttachment(id: String) async throws -> AttachmentHTTPResult {
    deleteIDs.append(id)
    return try next(&deleteResults)
  }

  func listAttachments(ownerKind: String, ownerId: String) async throws -> AttachmentHTTPResult {
    listRequests.append((ownerKind, ownerId))
    return try next(&listResults)
  }

  private func next(
    _ results: inout [Result<AttachmentHTTPResult, Error>]
  ) throws -> AttachmentHTTPResult {
    guard !results.isEmpty else { throw StubError.disconnected }
    return try results.removeFirst().get()
  }
}

@MainActor
private final class SuspendedUploadTransport: AttachmentAPITransport {
  private(set) var uploadCalls = 0
  private(set) var deleteIDs: [String] = []
  var firstContinuation: CheckedContinuation<AttachmentHTTPResult, Never>?

  func uploadAttachment(
    fileData: Data,
    fileName: String,
    mimeType: String,
    ownerKind: String,
    ownerId: String,
    idempotencyKey: String
  ) async throws -> AttachmentHTTPResult {
    uploadCalls += 1
    if uploadCalls == 1 {
      return await withCheckedContinuation { firstContinuation = $0 }
    }
    return Self.json(503, #"{"error":"attachments_unavailable"}"#)
  }

  func downloadAttachment(id: String) async throws -> AttachmentHTTPResult {
    Self.json(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60")
  }

  func deleteAttachment(id: String) async throws -> AttachmentHTTPResult {
    deleteIDs.append(id)
    return Self.json(204, "")
  }

  func listAttachments(ownerKind: String, ownerId: String) async throws -> AttachmentHTTPResult {
    Self.json(200, #"{"attachments":[]}"#)
  }

  func resumeFirstUpload(id: String) {
    firstContinuation?.resume(returning: Self.json(200, #"{"id":"\#(id)"}"#))
    firstContinuation = nil
  }

  func resumeFirstUpload(status: Int, body: String) {
    firstContinuation?.resume(returning: Self.json(status, body))
    firstContinuation = nil
  }

  private static func json(
    _ status: Int,
    _ body: String,
    retryAfter: String? = nil
  ) -> AttachmentHTTPResult {
    AttachmentHTTPResult(
      status: status,
      body: Data(body.utf8),
      retryAfter: retryAfter,
      contentType: "application/json",
      contentLength: nil,
      effectiveURL: URL(string: "https://crm.27pm.org/api/mobile/attachments")
    )
  }
}

@MainActor
private final class SuspendedListTransport: AttachmentAPITransport {
  private(set) var listCalls = 0
  private(set) var deleteIDs: [String] = []
  var firstContinuation: CheckedContinuation<AttachmentHTTPResult, Never>?
  var subsequentListResults: [Result<AttachmentHTTPResult, Error>] = []
  var deleteResults: [Result<AttachmentHTTPResult, Error>] = []

  func uploadAttachment(
    fileData: Data,
    fileName: String,
    mimeType: String,
    ownerKind: String,
    ownerId: String,
    idempotencyKey: String
  ) async throws -> AttachmentHTTPResult {
    Self.json(503, #"{"error":"attachments_unavailable"}"#)
  }

  func downloadAttachment(id: String) async throws -> AttachmentHTTPResult {
    Self.json(503, #"{"error":"attachments_unavailable"}"#)
  }

  func deleteAttachment(id: String) async throws -> AttachmentHTTPResult {
    deleteIDs.append(id)
    return try next(&deleteResults)
  }

  func listAttachments(ownerKind: String, ownerId: String) async throws -> AttachmentHTTPResult {
    listCalls += 1
    if listCalls == 1 {
      return await withCheckedContinuation { firstContinuation = $0 }
    }
    return try next(&subsequentListResults)
  }

  func resumeFirstList(with response: AttachmentHTTPResult? = nil) {
    firstContinuation?.resume(returning: response ?? Self.json(200, #"{"attachments":[]}"#))
    firstContinuation = nil
  }

  private func next(
    _ results: inout [Result<AttachmentHTTPResult, Error>]
  ) throws -> AttachmentHTTPResult {
    guard !results.isEmpty else { throw AttachmentTransportStub.StubError.disconnected }
    return try results.removeFirst().get()
  }

  private static func json(_ status: Int, _ body: String) -> AttachmentHTTPResult {
    AttachmentHTTPResult(
      status: status,
      body: Data(body.utf8),
      retryAfter: nil,
      contentType: "application/json",
      contentLength: nil,
      effectiveURL: URL(string: "https://crm.27pm.org/api/mobile/attachments")
    )
  }
}

@MainActor
private final class TestClock {
  var value: Date
  init(_ value: Date) { self.value = value }
}

@MainActor
private final class AuthenticationEpochProbe {
  var value: UInt64
  init(_ value: UInt64) { self.value = value }
}

@MainActor
private final class AuthenticationProbe {
  var refreshResults: [Bool] = []
  var currentToken: String? = "access-original"
  private(set) var refreshCount = 0
  private(set) var requiredCount = 0
  private(set) var rejectedRefreshTokens: [String?] = []
  private(set) var rejectedRequiredTokens: [String?] = []

  func refresh(rejectedAccessToken: String?) async -> Bool {
    refreshCount += 1
    rejectedRefreshTokens.append(rejectedAccessToken)
    let refreshed = refreshResults.isEmpty ? false : refreshResults.removeFirst()
    if refreshed {
      currentToken = "access-rotated-\(refreshCount)"
    }
    return refreshed
  }

  func requireAuthentication(rejectedAccessToken: String?) {
    requiredCount += 1
    rejectedRequiredTokens.append(rejectedAccessToken)
  }
}

final class AttachmentSyncCoordinatorTests: XCTestCase {
  private let bytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
  private let serverID = "72db58dc-8156-45f1-93b5-c7581c224d32"

  private func tempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func response(
    _ status: Int,
    _ body: String,
    retryAfter: String? = nil,
    contentLength: Int? = nil
  ) -> AttachmentHTTPResult {
    AttachmentHTTPResult(
      status: status,
      body: Data(body.utf8),
      retryAfter: retryAfter,
      contentType: "application/json",
      contentLength: contentLength,
      effectiveURL: URL(string: "https://crm.27pm.org/api/mobile/attachments")
    )
  }

  private func binaryResponse(_ data: Data) -> AttachmentHTTPResult {
    AttachmentHTTPResult(
      status: 200,
      body: data,
      retryAfter: nil,
      contentType: "image/jpeg",
      contentLength: data.count,
      effectiveURL: URL(string: "https://crm.27pm.org/api/mobile/attachments/\(serverID)/file")
    )
  }

  @MainActor
  private func coordinator(
    api: AttachmentAPITransport,
    store: AttachmentStore,
    outbox: OutboxQueue,
    auth: AuthenticationProbe,
    clock: TestClock,
    authenticationEpoch: @escaping () -> UInt64 = { 0 }
  ) -> AttachmentSyncCoordinator {
    AttachmentSyncCoordinator(
      api: api,
      attachments: store,
      outbox: outbox,
      authenticationToken: { auth.currentToken },
      authenticationEpoch: authenticationEpoch,
      refreshAuthentication: { await auth.refresh(rejectedAccessToken: $0) },
      authenticationRequired: { auth.requireAuthentication(rejectedAccessToken: $0) },
      now: { clock.value }
    )
  }

  @MainActor
  func testSessionEpochChangeDiscardsLate401AndStaleCoalescedTrigger() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-session-a")
    let api = SuspendedUploadTransport()
    let auth = AuthenticationProbe()
    let epoch = AuthenticationEpochProbe(1)
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(
      api: api,
      store: store,
      outbox: outbox,
      auth: auth,
      clock: clock,
      authenticationEpoch: { epoch.value }
    )

    let firstPass = Task {
      await sync.reconcileAndDrain(expectedAuthenticationEpoch: 1)
    }
    while api.firstContinuation == nil { await Task.yield() }

    // This overlap still belongs to session A. Once logout advances the epoch,
    // it must not turn into a pass under the next session.
    await sync.reconcileAndDrain(expectedAuthenticationEpoch: 1)
    epoch.value = 2
    auth.currentToken = "access-session-b"
    api.resumeFirstUpload(
      status: 401,
      body: #"{"error":"authentication_required"}"#
    )
    await firstPass.value

    XCTAssertEqual(api.uploadCalls, 1)
    XCTAssertEqual(auth.refreshCount, 0)
    XCTAssertEqual(auth.requiredCount, 0)
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))
    XCTAssertEqual(outbox.items.first?.lastErrorCode, "authentication_session_changed")
    XCTAssertNil(store.remoteRecord(localId: attachment.id))
    XCTAssertEqual(store.data(for: attachment), bytes)
  }

  @MainActor
  func testExplicitNewSessionTriggerRunsOneFreshPassAfterOldPassStops() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-session-a")
    let api = SuspendedUploadTransport()
    let auth = AuthenticationProbe()
    let epoch = AuthenticationEpochProbe(1)
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(
      api: api,
      store: store,
      outbox: outbox,
      auth: auth,
      clock: clock,
      authenticationEpoch: { epoch.value }
    )

    let firstPass = Task {
      await sync.reconcileAndDrain(expectedAuthenticationEpoch: 1)
    }
    while api.firstContinuation == nil { await Task.yield() }

    epoch.value = 2
    auth.currentToken = "access-session-b"
    // Unlike the stale trigger above, this explicit B trigger must be retained
    // and executed as a distinct pass after A has stopped.
    await sync.reconcileAndDrain(expectedAuthenticationEpoch: 2)
    api.resumeFirstUpload(
      status: 401,
      body: #"{"error":"authentication_required"}"#
    )
    await firstPass.value

    XCTAssertEqual(api.uploadCalls, 2)
    XCTAssertEqual(auth.refreshCount, 0)
    XCTAssertEqual(auth.requiredCount, 0)
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))
    XCTAssertNil(store.remoteRecord(localId: attachment.id))
    XCTAssertEqual(store.data(for: attachment), bytes)
  }

  @MainActor
  func testStaleTriggerCannotOverwritePendingNewSessionPass() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    _ = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-session-a")
    let api = SuspendedUploadTransport()
    let auth = AuthenticationProbe()
    let epoch = AuthenticationEpochProbe(1)
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(
      api: api,
      store: store,
      outbox: outbox,
      auth: auth,
      clock: clock,
      authenticationEpoch: { epoch.value }
    )

    let firstPass = Task {
      await sync.reconcileAndDrain(expectedAuthenticationEpoch: 1)
    }
    while api.firstContinuation == nil { await Task.yield() }

    epoch.value = 2
    await sync.reconcileAndDrain(expectedAuthenticationEpoch: 2)
    // A delayed timer/wake-up from A must not replace B in the coalescing slot.
    await sync.reconcileAndDrain(expectedAuthenticationEpoch: 1)
    api.resumeFirstUpload(
      status: 401,
      body: #"{"error":"authentication_required"}"#
    )
    await firstPass.value

    XCTAssertEqual(api.uploadCalls, 2)
    XCTAssertEqual(auth.refreshCount, 0)
    XCTAssertEqual(auth.requiredCount, 0)
  }

  @MainActor
  func test423AfterDurableUploadPreservesBytesIDsQueueAndDoesNotRefreshOrRepost() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let api = AttachmentTransportStub()
    api.uploadResults = [.success(response(200, #"{"id":"\#(serverID)"}"#))]
    api.downloadResults = [.success(response(
      423,
      #"{"error":"attachment_quarantined"}"#,
      retryAfter: "60"
    ))]
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let auth = AuthenticationProbe()

    await coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    XCTAssertEqual(store.data(for: attachment), bytes)
    XCTAssertEqual(store.remoteRecord(localId: attachment.id)?.serverId, serverID)
    XCTAssertEqual(store.remoteRecord(localId: attachment.id)?.status, .quarantined)
    XCTAssertEqual(store.remoteRecord(localId: attachment.id)?.retryAt, clock.value.addingTimeInterval(60))
    XCTAssertEqual(
      store.attachment(id: attachment.id).flatMap(store.statusLabel),
      "En vérification / fichier bloqué"
    )
    XCTAssertEqual(outbox.items.map(\.kind), [.attachmentDownload])
    XCTAssertEqual(api.uploadCalls.count, 1)
    XCTAssertEqual(api.downloadIDs, [serverID])
    XCTAssertEqual(auth.refreshCount, 0)
    XCTAssertEqual(auth.requiredCount, 0)
  }

  @MainActor
  func testLaterByteIdenticalDownloadBecomesAvailableWithoutAnotherUpload() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let api = AttachmentTransportStub()
    api.uploadResults = [.success(response(200, #"{"id":"\#(serverID)"}"#))]
    api.downloadResults = [
      .success(response(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60")),
      .success(binaryResponse(bytes)),
    ]
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let auth = AuthenticationProbe()
    let sync = coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)

    await sync.reconcileAndDrain()
    clock.value.addTimeInterval(61)
    await sync.reconcileAndDrain()

    XCTAssertEqual(store.remoteRecord(localId: attachment.id)?.status, .available)
    XCTAssertNil(store.attachment(id: attachment.id).flatMap(store.statusLabel))
    XCTAssertEqual(store.data(for: attachment), bytes)
    XCTAssertEqual(outbox.pendingCount, 0)
    XCTAssertEqual(api.uploadCalls.count, 1)
    XCTAssertEqual(api.downloadIDs.count, 2)
  }

  @MainActor
  func test401RefreshesAndReplaysExactlyOnce() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    _ = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let api = AttachmentTransportStub()
    api.uploadResults = [
      .success(response(401, #"{"error":"authentication_required"}"#)),
      .success(response(200, #"{"id":"\#(serverID)"}"#)),
    ]
    api.downloadResults = [.success(response(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60"))]
    let auth = AuthenticationProbe()
    auth.refreshResults = [true]
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))

    await coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    XCTAssertEqual(api.uploadCalls.count, 2)
    XCTAssertEqual(auth.refreshCount, 1)
    XCTAssertEqual(auth.requiredCount, 0)
    XCTAssertEqual(auth.rejectedRefreshTokens.compactMap { $0 }, ["access-original"])
  }

  @MainActor
  func testSecond401RequiresAuthenticationAndKeepsUploadQueued() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let api = AttachmentTransportStub()
    api.uploadResults = [
      .success(response(401, #"{"error":"authentication_required"}"#)),
      .success(response(401, #"{"error":"authentication_required"}"#)),
    ]
    let auth = AuthenticationProbe()
    auth.refreshResults = [true]
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))

    await coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    XCTAssertEqual(api.uploadCalls.count, 2)
    XCTAssertEqual(auth.refreshCount, 1)
    XCTAssertEqual(auth.requiredCount, 1)
    XCTAssertEqual(auth.rejectedRefreshTokens.compactMap { $0 }, ["access-original"])
    XCTAssertEqual(auth.rejectedRequiredTokens.compactMap { $0 }, ["access-rotated-1"])
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))
    XCTAssertTrue(attachment.pendingSync)
  }

  @MainActor
  func testSecond401StopsDrainBeforeAnyLaterAttachmentRequest() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let first = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let second = try store.addPhoto(bytes + Data([0x01]), ownerKind: .account, ownerId: "org-2")
    let api = AttachmentTransportStub()
    api.uploadResults = [
      .success(response(401, #"{"error":"authentication_required"}"#)),
      .success(response(401, #"{"error":"authentication_required"}"#)),
    ]
    let auth = AuthenticationProbe()
    auth.refreshResults = [true, true]
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))

    await coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    XCTAssertEqual(api.uploadCalls.count, 2, "only the first attachment may be replayed")
    XCTAssertEqual(auth.refreshCount, 1)
    XCTAssertEqual(auth.requiredCount, 1)
    XCTAssertEqual(outbox.items.first { $0.subjectId == first.id }?.attempts, 1)
    XCTAssertEqual(outbox.items.first { $0.subjectId == second.id }?.attempts, 0)
  }

  @MainActor
  func test403And503NeverRefreshAuthentication() async throws {
    for status in [403, 503] {
      let root = tempDirectory()
      let outbox = OutboxQueue(directory: root)
      let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
      _ = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
      let api = AttachmentTransportStub()
      api.uploadResults = [.success(response(status, #"{"error":"blocked"}"#))]
      let auth = AuthenticationProbe()
      let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))

      await coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
        .reconcileAndDrain()

      XCTAssertEqual(auth.refreshCount, 0, "status \(status) must not refresh")
    }
  }

  @MainActor
  func testInterruptedPostSurvivesRestartAndDeduplicatedRetryRecordsOneServerID() async throws {
    let root = tempDirectory()
    let firstOutbox = OutboxQueue(directory: root)
    let firstStore = AttachmentStore(directory: root.appending(path: "attachments"), outbox: firstOutbox)
    let attachment = try firstStore.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let firstAPI = AttachmentTransportStub()
    firstAPI.uploadResults = [.failure(AttachmentTransportStub.StubError.disconnected)]
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let auth = AuthenticationProbe()
    await coordinator(api: firstAPI, store: firstStore, outbox: firstOutbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    let restartedOutbox = OutboxQueue(directory: root)
    let restartedStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: restartedOutbox
    )
    let retryAPI = AttachmentTransportStub()
    retryAPI.uploadResults = [.success(response(200, #"{"id":"\#(serverID)"}"#))]
    retryAPI.downloadResults = [.success(response(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60"))]
    clock.value.addTimeInterval(31)
    await coordinator(api: retryAPI, store: restartedStore, outbox: restartedOutbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    XCTAssertEqual(firstAPI.uploadCalls.first?.data, bytes)
    XCTAssertEqual(retryAPI.uploadCalls.first?.data, bytes)
    XCTAssertEqual(firstAPI.uploadCalls.first?.key, retryAPI.uploadCalls.first?.key)
    XCTAssertEqual(restartedStore.remoteRecord(localId: attachment.id)?.serverId, serverID)
    XCTAssertEqual(retryAPI.uploadCalls.count, 1)
  }

  @MainActor
  func testOfflineTransportFailureThenOnlineRecoveryKeepsOriginalAndAcknowledgesOnce() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let api = AttachmentTransportStub()
    api.uploadResults = [
      .failure(AttachmentTransportStub.StubError.disconnected),
      .success(response(200, #"{"id":"\#(serverID)"}"#)),
    ]
    api.downloadResults = [
      .success(response(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60"))
    ]
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)

    await sync.reconcileAndDrain()
    XCTAssertEqual(store.data(for: attachment), bytes)
    XCTAssertNil(store.remoteRecord(localId: attachment.id))
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))

    clock.value.addTimeInterval(31)
    await sync.reconcileAndDrain()

    XCTAssertEqual(api.uploadCalls.count, 2)
    XCTAssertEqual(api.uploadCalls[0].key, api.uploadCalls[1].key)
    XCTAssertEqual(store.data(for: attachment), bytes)
    XCTAssertEqual(store.remoteRecord(localId: attachment.id)?.serverId, serverID)
    XCTAssertEqual(store.remoteRecord(localId: attachment.id)?.status, .quarantined)
    XCTAssertEqual(auth.refreshCount, 0)
  }

  @MainActor
  func testCrashAfterAckBeforeQueueRemovalRepairsWithoutRepost() async throws {
    let root = tempDirectory()
    let firstOutbox = OutboxQueue(directory: root)
    let firstStore = AttachmentStore(directory: root.appending(path: "attachments"), outbox: firstOutbox)
    let attachment = try firstStore.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try firstStore.recordUploadAcknowledgement(
      localId: attachment.id,
      serverId: serverID,
      ownerKind: attachment.ownerKind,
      ownerId: attachment.ownerId,
      uploadFileName: "Photo.jpg"
    )
    XCTAssertTrue(firstOutbox.contains(idempotencyKey: "upload-\(attachment.id)"))

    let restartedOutbox = OutboxQueue(directory: root)
    let restartedStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: restartedOutbox
    )
    let api = AttachmentTransportStub()
    api.downloadResults = [.success(response(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60"))]
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    await coordinator(api: api, store: restartedStore, outbox: restartedOutbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    XCTAssertEqual(api.uploadCalls.count, 0)
    XCTAssertFalse(restartedOutbox.contains(idempotencyKey: "upload-\(attachment.id)"))
    XCTAssertTrue(restartedOutbox.contains(idempotencyKey: "download-\(attachment.id)"))
  }

  @MainActor
  func testEmptyOutboxAfterAckCrashRebuildsDownloadVerification() async throws {
    let root = tempDirectory()
    let firstOutbox = OutboxQueue(directory: root)
    let firstStore = AttachmentStore(directory: root.appending(path: "attachments"), outbox: firstOutbox)
    let attachment = try firstStore.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try firstStore.recordUploadAcknowledgement(
      localId: attachment.id,
      serverId: serverID,
      ownerKind: attachment.ownerKind,
      ownerId: attachment.ownerId,
      uploadFileName: AttachmentStore.remoteUploadFileName(for: attachment)
    )
    // Model termination after upload-* removal but before download-* enqueue.
    XCTAssertTrue(firstOutbox.remove(idempotencyKey: "upload-\(attachment.id)"))
    XCTAssertEqual(firstOutbox.pendingCount, 0)

    let restartedOutbox = OutboxQueue(directory: root)
    let restartedStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: restartedOutbox
    )
    let api = AttachmentTransportStub()
    api.downloadResults = [
      .success(response(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60"))
    ]
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    await coordinator(
      api: api,
      store: restartedStore,
      outbox: restartedOutbox,
      auth: auth,
      clock: clock
    ).reconcileAndDrain()

    XCTAssertEqual(api.downloadIDs, [serverID])
    XCTAssertTrue(restartedOutbox.contains(idempotencyKey: "download-\(attachment.id)"))
    XCTAssertEqual(restartedStore.remoteRecord(localId: attachment.id)?.status, .quarantined)
  }

  @MainActor
  func testCrashAfterRetryStateWriteMergesRetryAfterIntoExistingQueueItem() async throws {
    let root = tempDirectory()
    let firstOutbox = OutboxQueue(directory: root)
    let firstStore = AttachmentStore(directory: root.appending(path: "attachments"), outbox: firstOutbox)
    let attachment = try firstStore.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try firstStore.recordUploadAcknowledgement(
      localId: attachment.id,
      serverId: serverID,
      ownerKind: attachment.ownerKind,
      ownerId: attachment.ownerId,
      uploadFileName: AttachmentStore.remoteUploadFileName(for: attachment)
    )
    try firstStore.reconcilePersistentState()
    let retryAt = Date(timeIntervalSince1970: 1_791_126_600)
    // Model a process death after the attachment index commits quarantine but
    // before the queue file receives its matching notBefore value.
    try firstStore.markQuarantined(localId: attachment.id, retryAt: retryAt)
    XCTAssertNil(firstOutbox.items.first?.notBefore)

    let restartedOutbox = OutboxQueue(directory: root)
    let restartedStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: restartedOutbox
    )
    let api = AttachmentTransportStub()
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    await coordinator(
      api: api,
      store: restartedStore,
      outbox: restartedOutbox,
      auth: auth,
      clock: clock
    ).reconcileAndDrain()

    XCTAssertEqual(api.downloadIDs, [])
    XCTAssertEqual(restartedOutbox.items.first?.notBefore, retryAt)
    XCTAssertEqual(restartedOutbox.items.first?.lastErrorCode, "attachment_quarantined")
  }

  @MainActor
  func testCrashAfterVerifiedDownloadRemovesStaleQueueItemWithoutAnotherGET() async throws {
    let root = tempDirectory()
    let firstOutbox = OutboxQueue(directory: root)
    let firstStore = AttachmentStore(directory: root.appending(path: "attachments"), outbox: firstOutbox)
    let attachment = try firstStore.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try firstStore.recordUploadAcknowledgement(
      localId: attachment.id,
      serverId: serverID,
      ownerKind: attachment.ownerKind,
      ownerId: attachment.ownerId,
      uploadFileName: AttachmentStore.remoteUploadFileName(for: attachment)
    )
    try firstStore.reconcilePersistentState()
    try firstStore.markDownloadVerified(localId: attachment.id)
    XCTAssertTrue(firstOutbox.contains(idempotencyKey: "download-\(attachment.id)"))

    let restartedOutbox = OutboxQueue(directory: root)
    let restartedStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: restartedOutbox
    )
    let api = AttachmentTransportStub()
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    await coordinator(
      api: api,
      store: restartedStore,
      outbox: restartedOutbox,
      auth: auth,
      clock: clock
    ).reconcileAndDrain()

    XCTAssertEqual(api.downloadIDs, [])
    XCTAssertEqual(restartedOutbox.pendingCount, 0)
    XCTAssertEqual(restartedStore.remoteRecord(localId: attachment.id)?.status, .available)
  }

  @MainActor
  func testDeleteDuringSuspendedPostKeepsSecondItemAndCleansLateAcknowledgement() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let first = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let second = try store.addPhoto(bytes + Data([0x01]), ownerKind: .account, ownerId: "org-2")
    let api = SuspendedUploadTransport()
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)

    let task = Task { await sync.reconcileAndDrain() }
    while api.firstContinuation == nil { await Task.yield() }
    try store.delete(first)
    api.resumeFirstUpload(id: serverID)
    await task.value

    XCTAssertNotNil(store.attachment(id: second.id))
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(second.id)"))
    XCTAssertFalse(outbox.contains(idempotencyKey: "upload-\(first.id)"))
    XCTAssertEqual(api.deleteIDs, [serverID])
    XCTAssertNil(store.tombstones[first.id])
  }

  @MainActor
  func testMissingLocalFilePausesRatherThanAcknowledgingUpload() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try FileManager.default.removeItem(at: store.fileURL(for: attachment))
    let api = AttachmentTransportStub()
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))

    await coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
      .reconcileAndDrain()

    XCTAssertEqual(api.uploadCalls.count, 0)
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))
    XCTAssertEqual(outbox.items.first?.lastErrorCode, "local_file_missing")
    XCTAssertTrue(store.attachment(id: attachment.id)?.pendingSync ?? false)
  }

  @MainActor
  func testRestartResolvesUnknownDeletionTombstoneFromAuthenticatedList() async throws {
    let root = tempDirectory()
    let firstOutbox = OutboxQueue(directory: root)
    let firstStore = AttachmentStore(directory: root.appending(path: "attachments"), outbox: firstOutbox)
    let attachment = try firstStore.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let uploadName = AttachmentStore.remoteUploadFileName(for: attachment)

    // Model a local deletion while a POST was in flight, followed by process
    // death before its committed response delivered the durable server ID.
    try firstStore.delete(attachment)
    XCTAssertNil(firstStore.tombstones[attachment.id]?.serverId)
    let digest = try XCTUnwrap(firstStore.tombstones[attachment.id]?.contentSHA256)

    let restartedOutbox = OutboxQueue(directory: root)
    let restartedStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: restartedOutbox
    )
    XCTAssertEqual(restartedOutbox.pendingCount, 0, "reconciliation must run even with an empty outbox")
    let api = AttachmentTransportStub()
    api.listResults = [.success(response(
      200,
      #"{"attachments":[{"id":"\#(serverID)","ownerKind":"account","ownerId":"org-1","fileName":"winner-from-other-device.jpg","byteSize":6,"sha256":"\#(digest)","createdAt":"2026-10-08T00:00:00Z"}]}"#
    ))]
    api.deleteResults = [.success(response(204, ""))]
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))

    await coordinator(
      api: api,
      store: restartedStore,
      outbox: restartedOutbox,
      auth: auth,
      clock: clock
    ).reconcileAndDrain()

    XCTAssertEqual(api.listRequests.count, 1)
    XCTAssertEqual(api.deleteIDs, [serverID])
    XCTAssertTrue(restartedStore.tombstones.isEmpty)
    XCTAssertEqual(api.uploadCalls.count, 0)
    XCTAssertEqual(restartedOutbox.pendingCount, 0)
    XCTAssertNotEqual(uploadName, "winner-from-other-device.jpg")
  }

  @MainActor
  func testOverlappingTriggerCoalescesFollowUpWorkAddedDuringActiveRun() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let firstAttachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try store.delete(firstAttachment)
    XCTAssertEqual(outbox.pendingCount, 0)
    let firstDigest = try XCTUnwrap(store.tombstones[firstAttachment.id]?.contentSHA256)

    let api = SuspendedListTransport()
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
    let first = Task { await sync.reconcileAndDrain() }
    while api.firstContinuation == nil { await Task.yield() }

    // This work arrives after the first pass captured its tombstone groups.
    // Its trigger must be coalesced into a complete second pass, not dropped.
    let secondBytes = bytes + Data([0x01])
    let secondAttachment = try store.addPhoto(
      secondBytes,
      ownerKind: .account,
      ownerId: "org-1"
    )
    try store.delete(secondAttachment)
    let secondDigest = try XCTUnwrap(store.tombstones[secondAttachment.id]?.contentSHA256)
    let secondServerID = "59dfb60f-4708-4249-a224-0f351f85c8bc"
    api.subsequentListResults = [.success(response(
      200,
      #"{"attachments":[{"id":"\#(secondServerID)","ownerKind":"account","ownerId":"org-1","fileName":"second.jpg","byteSize":7,"sha256":"\#(secondDigest)","createdAt":"2026-10-08T00:00:01Z"}]}"#
    ))]
    api.deleteResults = [
      .success(response(204, "")),
      .success(response(204, "")),
    ]
    let overlapping = Task { await sync.reconcileAndDrain() }
    await overlapping.value

    XCTAssertEqual(api.listCalls, 1)
    XCTAssertEqual(auth.refreshCount, 0)
    api.resumeFirstList(with: response(
      200,
      #"{"attachments":[{"id":"\#(serverID)","ownerKind":"account","ownerId":"org-1","fileName":"first.jpg","byteSize":6,"sha256":"\#(firstDigest)","createdAt":"2026-10-08T00:00:00Z"}]}"#
    ))
    await first.value

    XCTAssertEqual(api.listCalls, 2)
    XCTAssertEqual(Set(api.deleteIDs), Set([serverID, secondServerID]))
    XCTAssertTrue(store.tombstones.isEmpty)
    XCTAssertEqual(outbox.pendingCount, 0)
  }

  @MainActor
  func testTransientListFailurePersistsBoundedWakeUpAcrossRestart() async throws {
    let root = tempDirectory()
    let firstOutbox = OutboxQueue(directory: root)
    let firstStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: firstOutbox
    )
    let attachment = try firstStore.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try firstStore.delete(attachment)
    let digest = try XCTUnwrap(firstStore.tombstones[attachment.id]?.contentSHA256)
    let api = AttachmentTransportStub()
    api.listResults = [.failure(AttachmentTransportStub.StubError.disconnected)]
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))

    await coordinator(
      api: api,
      store: firstStore,
      outbox: firstOutbox,
      auth: auth,
      clock: clock
    ).reconcileAndDrain()

    let wakeUp = try XCTUnwrap(
      firstOutbox.items.first {
        $0.idempotencyKey.hasPrefix("attachment-reconciliation-")
      }
    )
    XCTAssertEqual(wakeUp.notBefore, clock.value.addingTimeInterval(30))
    XCTAssertEqual(wakeUp.attempts, 1)
    XCTAssertEqual(wakeUp.lastErrorCode, "transport_unavailable")
    XCTAssertEqual(firstOutbox.nextAttemptAt, wakeUp.notBefore)

    // The deadline is file-backed and therefore still drives the app's
    // existing nextAttemptAt scheduler after process restart.
    let restartedOutbox = OutboxQueue(directory: root)
    let restartedStore = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: restartedOutbox
    )
    XCTAssertEqual(restartedOutbox.items, firstOutbox.items)
    XCTAssertEqual(restartedOutbox.nextAttemptAt, wakeUp.notBefore)

    clock.value.addTimeInterval(30)
    let retryAPI = AttachmentTransportStub()
    retryAPI.listResults = [.success(response(
      200,
      #"{"attachments":[{"id":"\#(serverID)","ownerKind":"account","ownerId":"org-1","fileName":"winner.jpg","byteSize":6,"sha256":"\#(digest)","createdAt":"2026-10-08T00:00:00Z"}]}"#
    ))]
    retryAPI.deleteResults = [.success(response(204, ""))]
    await coordinator(
      api: retryAPI,
      store: restartedStore,
      outbox: restartedOutbox,
      auth: auth,
      clock: clock
    ).reconcileAndDrain()

    XCTAssertEqual(retryAPI.listRequests.count, 1)
    XCTAssertEqual(retryAPI.deleteIDs, [serverID])
    XCTAssertTrue(restartedStore.tombstones.isEmpty)
    XCTAssertNil(restartedOutbox.nextAttemptAt)
  }

  @MainActor
  func testDelayedListVisibilityPersistsAndAdvancesWakeUpDeadline() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try store.delete(attachment)
    let digest = try XCTUnwrap(store.tombstones[attachment.id]?.contentSHA256)
    let api = AttachmentTransportStub()
    api.listResults = [
      .success(response(200, #"{"attachments":[]}"#)),
      .success(response(200, #"{"attachments":[]}"#)),
      .success(response(
        200,
        #"{"attachments":[{"id":"\#(serverID)","ownerKind":"account","ownerId":"org-1","fileName":"visible-later.jpg","byteSize":6,"sha256":"\#(digest)","createdAt":"2026-10-08T00:00:00Z"}]}"#
      )),
    ]
    api.deleteResults = [.success(response(204, ""))]
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)

    await sync.reconcileAndDrain()
    let firstWake = try XCTUnwrap(outbox.nextAttemptAt)
    XCTAssertEqual(firstWake, clock.value.addingTimeInterval(30))

    clock.value = firstWake
    await sync.reconcileAndDrain()
    let secondWake = try XCTUnwrap(outbox.nextAttemptAt)
    XCTAssertEqual(secondWake, clock.value.addingTimeInterval(60))
    XCTAssertEqual(
      outbox.items.first {
        $0.idempotencyKey.hasPrefix("attachment-reconciliation-")
      }?.attempts,
      2
    )

    clock.value = secondWake
    await sync.reconcileAndDrain()

    XCTAssertEqual(api.listRequests.count, 3)
    XCTAssertEqual(api.deleteIDs, [serverID])
    XCTAssertTrue(store.tombstones.isEmpty)
    XCTAssertNil(outbox.nextAttemptAt)
  }

  @MainActor
  func testDeduplicatedServerIDIsDeletedOnlyAfterFinalLocalReference() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let first = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    let second = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    for attachment in [first, second] {
      try store.recordUploadAcknowledgement(
        localId: attachment.id,
        serverId: serverID,
        ownerKind: attachment.ownerKind,
        ownerId: attachment.ownerId,
        uploadFileName: AttachmentStore.remoteUploadFileName(for: attachment)
      )
      try store.markDownloadVerified(localId: attachment.id)
    }
    try store.reconcilePersistentState()

    try store.delete(first)
    let api = AttachmentTransportStub()
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    let sync = coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
    await sync.reconcileAndDrain()

    XCTAssertEqual(api.deleteIDs, [])
    XCTAssertNotNil(store.tombstones[first.id])
    XCTAssertEqual(store.remoteRecord(localId: second.id)?.serverId, serverID)

    try store.delete(second)
    api.deleteResults = [.success(response(204, ""))]
    await sync.reconcileAndDrain()

    XCTAssertEqual(api.deleteIDs, [serverID])
    XCTAssertTrue(store.tombstones.isEmpty)
    XCTAssertEqual(outbox.pendingCount, 0)
  }

  @MainActor
  func testDelete204Then404IsIdempotentAcrossRestart() async throws {
    let root = tempDirectory()
    let outbox = OutboxQueue(directory: root)
    let store = AttachmentStore(directory: root.appending(path: "attachments"), outbox: outbox)
    let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: "org-1")
    try store.recordUploadAcknowledgement(
      localId: attachment.id,
      serverId: serverID,
      ownerKind: attachment.ownerKind,
      ownerId: attachment.ownerId,
      uploadFileName: "Photo.jpg"
    )
    try store.delete(attachment)
    let api = AttachmentTransportStub()
    api.deleteResults = [.success(response(204, ""))]
    let auth = AuthenticationProbe()
    let clock = TestClock(Date(timeIntervalSince1970: 1_791_126_000))
    await coordinator(api: api, store: store, outbox: outbox, auth: auth, clock: clock)
      .reconcileAndDrain()
    XCTAssertTrue(store.tombstones.isEmpty)

    // A repeated delivery of the same durable delete after restart remains
    // safe; server 404 is policy-level success.
    XCTAssertTrue(outbox.enqueue(OutboxItem(
      id: UUID().uuidString,
      idempotencyKey: "delete-\(serverID)",
      kind: .attachmentDelete,
      ownerKind: attachment.ownerKind.rawValue,
      ownerId: attachment.ownerId,
      subjectId: serverID,
      label: attachment.fileName,
      createdAt: clock.value
    )))
    let retryAPI = AttachmentTransportStub()
    retryAPI.deleteResults = [.success(response(404, #"{"error":"not_found"}"#))]
    await coordinator(api: retryAPI, store: store, outbox: outbox, auth: auth, clock: clock)
      .reconcileAndDrain()
    XCTAssertTrue(store.tombstones.isEmpty)
    XCTAssertEqual(retryAPI.deleteIDs, [serverID])
  }
}
