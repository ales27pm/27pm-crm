import XCTest
@testable import App27pmCRM

// Xcode 26 / Swift 6.2 can crash when synchronous XCTest methods deallocate
// MainActor-isolated objects (swiftlang/swift#85663). Store-owning tests stay
// MainActor-isolated and async until that runtime defect is fixed upstream.
final class AttachmentStoreTests: XCTestCase {
  private func tempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private let jpegBytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])

  @MainActor
  func testAddPhotoPersistsFileIndexAndOutboxItem() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)

    let attachment = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-1")

    XCTAssertTrue(FileManager.default.fileExists(atPath: store.fileURL(for: attachment).path))
    XCTAssertEqual(store.attachments(ownerKind: .account, ownerId: "org-1").count, 1)
    XCTAssertTrue(attachment.pendingSync)
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))
  }

  @MainActor
  func testIndexSurvivesAStoreReload() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    let attachment = try store.addPhoto(jpegBytes, ownerKind: .deal, ownerId: "deal-1")

    let reloaded = AttachmentStore(directory: directory.appending(path: "att"), outbox: nil)
    XCTAssertEqual(reloaded.attachments.count, 1)
    XCTAssertEqual(reloaded.attachment(id: attachment.id)?.ownerKind, .deal)
  }

  @MainActor
  func testOwnerFilteringIsolatesAccountsDealsAndConversations() async throws {
    let store = AttachmentStore(directory: tempDirectory(), outbox: nil)
    _ = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-1")
    _ = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-2")
    _ = try store.addPhoto(jpegBytes, ownerKind: .deal, ownerId: "org-1")

    XCTAssertEqual(store.attachments(ownerKind: .account, ownerId: "org-1").count, 1)
    XCTAssertEqual(store.attachments(ownerKind: .account, ownerId: "org-2").count, 1)
    XCTAssertEqual(store.attachments(ownerKind: .deal, ownerId: "org-1").count, 1)
    XCTAssertEqual(store.attachments(ownerKind: .conversation, ownerId: "org-1").count, 0)
  }

  @MainActor
  func testDeleteRemovesFileAndItsQueuedUpload() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    let attachment = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-1")

    try store.delete(attachment)

    XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL(for: attachment).path))
    XCTAssertEqual(store.fileCount, 0)
    XCTAssertFalse(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))
  }

  @MainActor
  func testMarkSyncedClearsPendingFlagAndEnqueuesDeleteOnRemoval() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    let attachment = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-1")

    try store.recordUploadAcknowledgement(
      localId: attachment.id,
      serverId: "72db58dc-8156-45f1-93b5-c7581c224d32",
      ownerKind: attachment.ownerKind,
      ownerId: attachment.ownerId,
      uploadFileName: attachment.fileName
    )
    XCTAssertFalse(store.attachment(id: attachment.id)?.pendingSync ?? true)

    try store.delete(attachment)
    XCTAssertTrue(outbox.contains(idempotencyKey: "delete-72db58dc-8156-45f1-93b5-c7581c224d32"))
  }

  @MainActor
  func testDeleteAllRemovesFilesAndPendingUploads() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    let first = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-1")
    let second = try store.addPhoto(jpegBytes, ownerKind: .conversation, ownerId: "conv-1")

    try store.deleteAll()

    XCTAssertEqual(store.fileCount, 0)
    XCTAssertEqual(store.storageBytes, 0)
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL(for: first).path))
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL(for: second).path))
    XCTAssertFalse(outbox.contains(idempotencyKey: "upload-\(first.id)"))
    XCTAssertFalse(outbox.contains(idempotencyKey: "upload-\(second.id)"))
  }

  @MainActor
  func testKnownServerDeleteWaitsForIdenticalPendingLocalReference() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    let first = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-1")
    let second = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: "org-1")
    let serverID = "72db58dc-8156-45f1-93b5-c7581c224d32"
    try store.recordUploadAcknowledgement(
      localId: first.id,
      serverId: serverID,
      ownerKind: first.ownerKind,
      ownerId: first.ownerId,
      uploadFileName: AttachmentStore.remoteUploadFileName(for: first)
    )
    try store.markDownloadVerified(localId: first.id)

    try store.delete(first)
    try store.reconcilePersistentState()
    XCTAssertFalse(outbox.contains(idempotencyKey: "delete-\(serverID)"))
    XCTAssertTrue(outbox.contains(idempotencyKey: "upload-\(second.id)"))

    try store.delete(second)
    try store.reconcilePersistentState()
    XCTAssertTrue(outbox.contains(idempotencyKey: "delete-\(serverID)"))
    try store.completeRemoteDelete(serverId: serverID)
    XCTAssertTrue(store.tombstones.isEmpty)
  }

  func testMimeTypeMapping() {
    XCTAssertEqual(AttachmentStore.mimeType(forExtension: "jpg"), "image/jpeg")
    XCTAssertEqual(AttachmentStore.mimeType(forExtension: "pdf"), "application/pdf")
    XCTAssertEqual(AttachmentStore.mimeType(forExtension: ""), "application/octet-stream")
  }
}
