import XCTest
@testable import App27pmCRM

// Xcode 26 / Swift 6.2 can crash when synchronous XCTest methods deallocate
// MainActor-isolated objects (swiftlang/swift#85663). Store-owning tests stay
// MainActor-isolated and async until that runtime defect is fixed upstream.
final class AttachmentStoreTests: XCTestCase {
  @MainActor
  func testDeletionSnapshotExcludesFilesDiscoveredAfterConfirmation() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    let confirmedIDs = store.attachments.map(\.id)
    let laterID = "5724f5bf-a05e-471c-af4d-a5ed640e24a2"
    try store.importRemoteAttachments([metadata(id: laterID)], ownerKind: .account, ownerId: ownerID)
    for id in confirmedIDs {
      if let attachment = store.attachment(id: id) { try store.delete(attachment) }
    }
    XCTAssertEqual(store.attachments.count, 1)
    XCTAssertEqual(store.remoteRecord(localId: store.attachments[0].id)?.serverId, laterID)
    XCTAssertEqual(outbox.items.map(\.subjectId), [remoteID])
  }

  private func tempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private let jpegBytes = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10])
  private let ownerID = "e0df9e2a-61c9-4c64-b802-a5b66a601c1d"
  private let remoteID = "72db58dc-8156-45f1-93b5-c7581c224d32"
  private let abcSHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"

  private func metadata(
    id: String = "72db58dc-8156-45f1-93b5-c7581c224d32",
    ownerKind: String = "account",
    ownerId: String = "e0df9e2a-61c9-4c64-b802-a5b66a601c1d",
    fileName: String = "rapport.txt",
    contentType: String = "text/plain",
    byteSize: Int = 3,
    sha256: String = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    objectVersion: String = "version-1",
    createdAt: String = "2026-10-18T04:50:00.000Z"
  ) -> RemoteAttachmentMetadata {
    RemoteAttachmentMetadata(
      id: id, ownerKind: ownerKind, ownerId: ownerId, fileName: fileName,
      contentType: contentType, byteSize: byteSize, sha256: sha256,
      objectVersion: objectVersion, createdAt: createdAt
    )
  }

  @MainActor
  private func queueItem(_ attachment: Attachment, code: String) -> OutboxItem {
    OutboxItem(
      id: UUID().uuidString,
      idempotencyKey: "upload-\(attachment.id)", kind: .attachmentUpload,
      ownerKind: attachment.ownerKind.rawValue, ownerId: attachment.ownerId,
      subjectId: attachment.id, label: attachment.fileName, createdAt: Date(), lastErrorCode: code
    )
  }

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

  @MainActor
  func testPendingUploadErrorsAreNotMaskedAsQueued() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    let attachment = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: ownerID)
    XCTAssertEqual(store.statusLabel(for: attachment), "En file")
    for (code, label) in [
      ("attachment_validation_failed", "Fichier refusé · vérifier le format et la taille"),
      ("invalid_upload_manifest", "Fichier refusé · vérifier le format et la taille"),
      ("attachment_unsupported_media_type", "Format de fichier non accepté"),
      ("attachment_media_type_rejected", "Format de fichier non accepté"),
      ("authentication_required", "Connexion requise"),
      ("transport_unavailable", "Envoi interrompu · réessayer"),
      ("upload_rejected", "Envoi à reprendre"),
    ] {
      XCTAssertTrue(outbox.enqueue(queueItem(attachment, code: code)))
      XCTAssertEqual(store.statusLabel(for: attachment), label)
    }
    try store.retryAttachment(localId: attachment.id)
    XCTAssertEqual(store.statusLabel(for: attachment), "En file")
    XCTAssertEqual(outbox.items.count, 1)
  }

  @MainActor
  func testSizeFailuresDoNotWriteFilesIndexOrQueue() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    for bytes in [Data(), Data(repeating: 0, count: AttachmentStore.maximumFileBytes + 1)] {
      XCTAssertThrowsError(try store.addPhoto(bytes, ownerKind: .account, ownerId: ownerID))
    }
    let source = directory.appending(path: "grand.pdf")
    XCTAssertTrue(FileManager.default.createFile(atPath: source.path, contents: Data()))
    let handle = try FileHandle(forWritingTo: source)
    try handle.truncate(atOffset: UInt64(AttachmentStore.maximumFileBytes + 1))
    try handle.close()
    XCTAssertThrowsError(try store.addDocument(from: source, ownerKind: .account, ownerId: ownerID))
    XCTAssertEqual(store.fileCount, 0)
    XCTAssertEqual(outbox.pendingCount, 0)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.appending(path: "att").path), [])
  }

  @MainActor
  func testPhotosPreservePNGAndHEICBytesAndExtensions() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    let png = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0])
    let heic = Data([0, 0, 0, 20]) + Data("ftypheic".utf8) + Data([0, 0, 0, 0]) + Data("mif1".utf8)
    for (bytes, extension_, mime) in [(png, "png", "image/png"), (heic, "heic", "image/heic")] {
      let attachment = try store.addPhoto(bytes, ownerKind: .account, ownerId: ownerID)
      XCTAssertEqual(attachment.fileExtension, extension_)
      XCTAssertEqual(AttachmentStore.mimeType(forExtension: attachment.fileExtension), mime)
      XCTAssertEqual(store.data(for: attachment), bytes)
    }
    XCTAssertThrowsError(try store.addPhoto(Data("not a photograph".utf8), ownerKind: .account, ownerId: ownerID))
  }

  @MainActor
  func testRemoteMetadataIsVisibleAfterRestartWithoutAnyTransfer() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.reconcilePersistentState()
    let attachment = try XCTUnwrap(store.attachment(id: remoteID))
    XCTAssertEqual(attachment.fileName, "rapport.txt")
    XCTAssertFalse(attachment.pendingSync)
    XCTAssertFalse(store.hasLocalCopy(attachment))
    XCTAssertNil(store.data(for: attachment))
    XCTAssertEqual(store.storageBytes, 0)
    XCTAssertEqual(store.statusLabel(for: attachment), "Sur le CRM · non téléchargé")
    XCTAssertEqual(store.remoteRecord(localId: remoteID)?.expectedSHA256, abcSHA256)
    XCTAssertEqual(outbox.pendingCount, 0)
    let reloaded = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try reloaded.reconcilePersistentState()
    XCTAssertEqual(reloaded.fileCount, 1)
    XCTAssertTrue(reloaded.remoteRecord(localId: remoteID)?.remoteOnly == true)
    XCTAssertEqual(outbox.pendingCount, 0)
  }

  @MainActor
  func testRemoteImportDeduplicatesAndDoesNotReplaceAnExistingVersion() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    try store.importRemoteAttachments([metadata(), metadata()], ownerKind: .account, ownerId: ownerID)
    try store.cacheRemoteDownload(localId: remoteID, data: Data("abc".utf8), objectVersion: "version-1")
    try store.importRemoteAttachments(
      [metadata(fileName: "new-name.txt", byteSize: 4, objectVersion: "version-2")],
      ownerKind: .account, ownerId: ownerID
    )
    XCTAssertEqual(store.fileCount, 1)
    XCTAssertEqual(store.attachment(id: remoteID)?.fileName, "rapport.txt")
    XCTAssertEqual(store.remoteRecord(localId: remoteID)?.objectVersion, "version-1")
    XCTAssertEqual(store.data(for: try XCTUnwrap(store.attachment(id: remoteID))), Data("abc".utf8))
  }

  @MainActor
  func testUncachedMetadataRefreshUpdatesSameLocalIDButRequiresNewDownloadIntent() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.requestRemoteDownload(localId: remoteID)
    try store.markQuarantined(localId: remoteID, retryAt: Date().addingTimeInterval(60))
    let newDigest = "88d4266fd4e6338d13b845fcf289579d209c897823b9217da3e161936f031589"
    try store.importRemoteAttachments([
      metadata(fileName: "nouveau.txt", byteSize: 4, sha256: newDigest, objectVersion: "version-2"),
    ], ownerKind: .account, ownerId: ownerID)
    try store.reconcilePersistentState()
    let attachment = try XCTUnwrap(store.attachment(id: remoteID))
    XCTAssertEqual(store.fileCount, 1)
    XCTAssertEqual(attachment.fileName, "nouveau.txt")
    XCTAssertEqual(attachment.byteSize, 4)
    let record = try XCTUnwrap(store.remoteRecord(localId: remoteID))
    XCTAssertEqual(record.expectedSHA256, newDigest)
    XCTAssertEqual(record.objectVersion, "version-2")
    XCTAssertEqual(record.status, .awaitingVerification)
    XCTAssertEqual(record.consecutiveFailures, 0)
    XCTAssertNil(record.retryAt)
    XCTAssertNil(record.lastErrorCode)
    XCTAssertFalse(record.downloadRequested ?? true)
    XCTAssertTrue(outbox.items.isEmpty)
    XCTAssertEqual(store.statusLabel(for: attachment), "Sur le CRM · non téléchargé")
    // A response that was already in flight for the old version is stale.
    XCTAssertThrowsError(try store.cacheRemoteDownload(localId: remoteID, data: Data("abc".utf8), objectVersion: "version-1"))
    XCTAssertFalse(store.hasLocalCopy(attachment))
    try store.requestRemoteDownload(localId: remoteID)
    try store.cacheRemoteDownload(localId: remoteID, data: Data("abcd".utf8), objectVersion: "version-2")
    XCTAssertEqual(store.data(for: attachment), Data("abcd".utf8))
  }

  @MainActor
  func testSameVersionRefreshPreservesRequestedDownloadAndBlockedVerdict() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.requestRemoteDownload(localId: remoteID)
    try store.importRemoteAttachments([metadata(fileName: "renomme.txt")], ownerKind: .account, ownerId: ownerID)
    XCTAssertTrue(store.remoteRecord(localId: remoteID)?.downloadRequested == true)
    try store.markBlocked(localId: remoteID)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.reconcilePersistentState()
    XCTAssertEqual(store.remoteRecord(localId: remoteID)?.lastErrorCode, "attachment_blocked")
    XCTAssertEqual(store.remoteRecord(localId: remoteID)?.status, .failed)
    XCTAssertTrue(outbox.items.isEmpty)
    try store.importRemoteAttachments([metadata(objectVersion: "version-2")], ownerKind: .account, ownerId: ownerID)
    try store.reconcilePersistentState()
    XCTAssertEqual(store.remoteRecord(localId: remoteID)?.status, .awaitingVerification)
    XCTAssertNil(store.remoteRecord(localId: remoteID)?.lastErrorCode)
    XCTAssertTrue(outbox.items.isEmpty)
  }

  @MainActor
  func testContradictorySameVersionCannotChangeUncachedChecksumOrSize() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.markBlocked(localId: remoteID)
    try store.importRemoteAttachments([
      metadata(byteSize: 4, sha256: String(repeating: "a", count: 64)),
    ], ownerKind: .account, ownerId: ownerID)
    XCTAssertEqual(store.attachment(id: remoteID)?.byteSize, 3)
    XCTAssertEqual(store.remoteRecord(localId: remoteID)?.expectedSHA256, abcSHA256)
    XCTAssertEqual(store.remoteRecord(localId: remoteID)?.lastErrorCode, "attachment_blocked")
  }

  @MainActor
  func testRemoteImportUsesSafeIndependentLocalPathWhenServerIDCollides() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    let original = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: ownerID)
    try store.importRemoteAttachments([metadata(id: original.id)], ownerKind: .account, ownerId: ownerID)
    let remote = try XCTUnwrap(store.attachments.first { $0.id != original.id })
    XCTAssertNotEqual(remote.id.lowercased(), original.id.lowercased())
    XCTAssertNotNil(UUID(uuidString: remote.id))
    XCTAssertEqual(store.remoteRecord(localId: remote.id)?.serverId, original.id.lowercased())
    XCTAssertNotEqual(store.fileURL(for: remote), store.fileURL(for: original))
    XCTAssertEqual(store.data(for: original), jpegBytes)
  }

  @MainActor
  func testMalformedRemoteEnvelopeNeverImportsPartialRows() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    let invalid = [
      metadata(id: "../../outside"), metadata(ownerKind: "deal"), metadata(ownerId: UUID().uuidString),
      metadata(fileName: "../rapport.txt"), metadata(fileName: "bad\\rapport.txt"),
      metadata(fileName: "bad\nname.txt"), metadata(contentType: "text/javascript"),
      metadata(byteSize: 0), metadata(byteSize: AttachmentStore.maximumFileBytes + 1),
      metadata(sha256: "invalid"), metadata(objectVersion: "../version"), metadata(createdAt: "yesterday"),
    ]
    for row in invalid {
      XCTAssertThrowsError(try store.importRemoteAttachments([metadata(), row], ownerKind: .account, ownerId: ownerID))
      XCTAssertEqual(store.fileCount, 0)
    }
  }

  @MainActor
  func testRemoteImportDoesNotResurrectKnownOrUnresolvedTombstones() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.delete(try XCTUnwrap(store.attachment(id: remoteID)))
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    XCTAssertEqual(store.fileCount, 0)

    let pending = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: ownerID)
    try store.delete(pending)
    try store.importRemoteAttachments(
      [metadata(id: UUID().uuidString, fileName: AttachmentStore.remoteUploadFileName(for: pending))],
      ownerKind: .account, ownerId: ownerID
    )
    XCTAssertEqual(store.fileCount, 0)
    XCTAssertEqual(store.tombstones.count, 2)
  }

  @MainActor
  func testRemoteImportWaitsForPendingLocalUploadAcknowledgement() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    let original = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: ownerID)
    try store.importRemoteAttachments(
      [metadata(fileName: AttachmentStore.remoteUploadFileName(for: original))],
      ownerKind: .account, ownerId: ownerID
    )
    XCTAssertEqual(store.fileCount, 1)
    XCTAssertTrue(store.attachment(id: original.id)?.pendingSync == true)
    XCTAssertEqual(store.data(for: original), jpegBytes)
    try store.recordUploadAcknowledgement(
      localId: original.id, serverId: remoteID, ownerKind: .account, ownerId: ownerID,
      uploadFileName: AttachmentStore.remoteUploadFileName(for: original)
    )
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    XCTAssertEqual(store.fileCount, 1)
    XCTAssertEqual(store.data(for: original), jpegBytes)
  }

  @MainActor
  func testRemoteDownloadRequiresIntentAndCachesOnlyMatchingHashSizeAndVersion() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.requestRemoteDownload(localId: remoteID)
    XCTAssertTrue(outbox.contains(idempotencyKey: "download-\(remoteID)"))
    let reloaded = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try reloaded.reconcilePersistentState()
    XCTAssertTrue(reloaded.remoteRecord(localId: remoteID)?.downloadRequested == true)
    for (bytes, version) in [(Data("ab".utf8), "version-1"), (Data("abd".utf8), "version-1"), (Data("abc".utf8), "version-2")] {
      XCTAssertThrowsError(try reloaded.cacheRemoteDownload(localId: remoteID, data: bytes, objectVersion: version))
    }
    let attachment = try XCTUnwrap(reloaded.attachment(id: remoteID))
    XCTAssertFalse(reloaded.hasLocalCopy(attachment))
    try reloaded.cacheRemoteDownload(localId: remoteID, data: Data("abc".utf8), objectVersion: "version-1")
    XCTAssertTrue(reloaded.hasLocalCopy(attachment))
    XCTAssertEqual(reloaded.data(for: attachment), Data("abc".utf8))
    XCTAssertEqual(reloaded.remoteRecord(localId: remoteID)?.status, .available)
    XCTAssertFalse(reloaded.remoteRecord(localId: remoteID)?.downloadRequested ?? true)
    try reloaded.reconcilePersistentState()
    XCTAssertEqual(outbox.pendingCount, 0)
  }

  @MainActor
  func testRemoteCacheDoesNotExposeBytesIfIndexPersistenceFails() async throws {
    let directory = tempDirectory()
    let store = AttachmentStore(directory: directory)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    let attachment = try XCTUnwrap(store.attachment(id: remoteID))
    let indexURL = directory.appending(path: "index.json")
    try FileManager.default.removeItem(at: indexURL)
    try FileManager.default.createDirectory(at: indexURL, withIntermediateDirectories: false)
    XCTAssertThrowsError(try store.cacheRemoteDownload(localId: remoteID, data: Data("abc".utf8), objectVersion: "version-1"))
    XCTAssertTrue(store.remoteRecord(localId: remoteID)?.remoteOnly == true)
    XCTAssertFalse(store.hasLocalCopy(attachment))
    XCTAssertNil(store.data(for: attachment))
    XCTAssertFalse(FileManager.default.fileExists(atPath: store.fileURL(for: attachment).path))
  }

  @MainActor
  func testRemoteCacheNeverOverwritesConflictingLocalBytes() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    let attachment = try XCTUnwrap(store.attachment(id: remoteID))
    let original = Data("original private bytes".utf8)
    try original.write(to: store.fileURL(for: attachment), options: .atomic)
    XCTAssertThrowsError(try store.cacheRemoteDownload(localId: remoteID, data: Data("abc".utf8), objectVersion: "version-1"))
    XCTAssertEqual(try Data(contentsOf: store.fileURL(for: attachment)), original)
    XCTAssertFalse(store.hasLocalCopy(attachment))
    XCTAssertNil(store.data(for: attachment))
  }

  @MainActor
  func testBlockedFileDoesNotRetryOrRequeueAfterRestart() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let store = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try store.importRemoteAttachments([metadata()], ownerKind: .account, ownerId: ownerID)
    try store.requestRemoteDownload(localId: remoteID)
    try store.markBlocked(localId: remoteID)
    let attachment = try XCTUnwrap(store.attachment(id: remoteID))
    XCTAssertEqual(store.statusLabel(for: attachment), "Fichier bloqué")
    XCTAssertThrowsError(try store.retryAttachment(localId: remoteID))
    XCTAssertThrowsError(try store.requestRemoteDownload(localId: remoteID))
    XCTAssertThrowsError(try store.cacheRemoteDownload(localId: remoteID, data: Data("abc".utf8), objectVersion: "version-1"))
    let reloaded = AttachmentStore(directory: directory.appending(path: "att"), outbox: outbox)
    try reloaded.reconcilePersistentState()
    XCTAssertNil(reloaded.remoteRecord(localId: remoteID)?.retryAt)
    XCTAssertEqual(outbox.pendingCount, 0)
    XCTAssertFalse(reloaded.hasLocalCopy(attachment))
  }

  @MainActor
  func testPendingAnalysisAndVerificationFailureHaveDifferentLabels() async throws {
    let store = AttachmentStore(directory: tempDirectory())
    let original = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: ownerID)
    try store.recordUploadAcknowledgement(
      localId: original.id, serverId: remoteID, ownerKind: .account, ownerId: ownerID,
      uploadFileName: AttachmentStore.remoteUploadFileName(for: original)
    )
    let attachment = try XCTUnwrap(store.attachment(id: original.id))
    try store.markQuarantined(localId: attachment.id, retryAt: Date().addingTimeInterval(60))
    XCTAssertEqual(store.statusLabel(for: attachment), "Analyse en attente")
    try store.markVerificationFailed(localId: attachment.id, code: "download_integrity_failed")
    XCTAssertEqual(store.statusLabel(for: attachment), "Vérification à reprendre")
  }

  @MainActor
  func testLegacyRemoteRecordWithoutNewFieldsStillDecodesAndReconciles() async throws {
    let directory = tempDirectory()
    let outbox = OutboxQueue(directory: directory)
    let storeDirectory = directory.appending(path: "att")
    let store = AttachmentStore(directory: storeDirectory, outbox: outbox)
    let attachment = try store.addPhoto(jpegBytes, ownerKind: .account, ownerId: ownerID)
    var index = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: storeDirectory.appending(path: "index.json"))) as? [String: Any])
    index["remoteRecords"] = [attachment.id: [
      "serverId": remoteID, "status": "awaitingVerification", "consecutiveFailures": 0,
    ]]
    try JSONSerialization.data(withJSONObject: index).write(to: storeDirectory.appending(path: "index.json"), options: .atomic)
    let reloaded = AttachmentStore(directory: storeDirectory, outbox: outbox)
    XCTAssertEqual(reloaded.fileCount, 1)
    XCTAssertNil(reloaded.remoteRecord(localId: attachment.id)?.remoteOnly)
    XCTAssertNil(reloaded.remoteRecord(localId: attachment.id)?.downloadRequested)
    XCTAssertNil(reloaded.remoteRecord(localId: attachment.id)?.expectedSHA256)
    XCTAssertNil(reloaded.remoteRecord(localId: attachment.id)?.objectVersion)
    XCTAssertTrue(reloaded.hasLocalCopy(attachment))
    try reloaded.reconcilePersistentState()
    XCTAssertFalse(outbox.contains(idempotencyKey: "upload-\(attachment.id)"))
    XCTAssertTrue(outbox.contains(idempotencyKey: "download-\(attachment.id)"))
  }
}
