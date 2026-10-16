import CryptoKit
import Foundation
import ImageIO
import UIKit

// MARK: - Model

enum AttachmentOwnerKind: String, Codable {
  case account
  case deal
  case conversation

  var label: String {
    switch self {
    case .account: "Compte"
    case .deal: "Opportunité"
    case .conversation: "Conversation"
    }
  }
}

enum AttachmentMediaKind: String, Codable {
  case photo
  case document
}

struct Attachment: Identifiable, Codable, Hashable {
  let id: String
  let ownerKind: AttachmentOwnerKind
  let ownerId: String
  let mediaKind: AttachmentMediaKind
  /// Display name (original document name, or « Photo »).
  let fileName: String
  let fileExtension: String
  let byteSize: Int
  let createdAt: Date
  /// True until the server confirms the upload. While the attachment
  /// endpoints are not deployed, files stay local with this flag up.
  var pendingSync: Bool
}

enum AttachmentRemoteStatus: String, Codable, Equatable {
  case awaitingVerification
  case quarantined
  case available
  case failed
}

struct AttachmentRemoteRecord: Codable, Equatable {
  let serverId: String
  var status: AttachmentRemoteStatus
  var retryAt: Date?
  var consecutiveFailures: Int
  var lastErrorCode: String?
}

struct AttachmentTombstone: Codable, Equatable {
  let localId: String
  let ownerKind: AttachmentOwnerKind
  let ownerId: String
  let uploadFileName: String
  /// Content identity lets one server object safely back multiple identical
  /// local attachments. Deletion is deferred until the final local reference
  /// disappears, even when one duplicate has not received its POST response.
  let contentSHA256: String?
  var serverId: String?
}

enum AttachmentStoreError: LocalizedError {
  case persistenceFailed
  case outboxPersistenceFailed

  var errorDescription: String? {
    switch self {
    case .persistenceFailed:
      "La pièce jointe n'a pas pu être enregistrée durablement sur l'appareil."
    case .outboxPersistenceFailed:
      "L'opération de synchronisation n'a pas pu être enregistrée durablement."
    }
  }
}

// MARK: - Store

/// Local attachment library: files on disk (Documents/Attachments) plus a
/// persisted index. Adding an attachment enqueues its upload in the outbox;
/// deleting a synced attachment enqueues its server-side deletion. Nothing
/// ever leaves the device before the server contract endpoints are probed
/// and confirmed by CrmStore.
@Observable
final class AttachmentStore {
  private(set) var attachments: [Attachment] = []

  private let baseDirectory: URL
  private let indexURL: URL
  private let outbox: OutboxQueue?
  private let thumbnailCache = NSCache<NSString, UIImage>()

  /// Upload acknowledgement and download-verification state are separate.
  /// A 200 POST is durable even while the corresponding file is quarantined.
  private(set) var remoteRecords: [String: AttachmentRemoteRecord] = [:]
  /// A deletion intent survives a suspended POST. If its late response brings
  /// a server ID, that ID is attached to the tombstone and deleted remotely.
  private(set) var tombstones: [String: AttachmentTombstone] = [:]

  private struct IndexFile: Codable {
    var attachments: [Attachment]
    var serverIdentifiers: [String: String]
    var remoteRecords: [String: AttachmentRemoteRecord]
    var tombstones: [String: AttachmentTombstone]

    enum CodingKeys: String, CodingKey {
      case attachments, serverIdentifiers, remoteRecords, tombstones
    }

    init(
      attachments: [Attachment],
      remoteRecords: [String: AttachmentRemoteRecord],
      tombstones: [String: AttachmentTombstone]
    ) {
      self.attachments = attachments
      self.remoteRecords = remoteRecords
      self.tombstones = tombstones
      // Keep the legacy map in the envelope so a rollback build can still
      // address already-uploaded files instead of orphaning remote objects.
      serverIdentifiers = remoteRecords.mapValues(\.serverId)
    }

    init(from decoder: Decoder) throws {
      let values = try decoder.container(keyedBy: CodingKeys.self)
      attachments = try values.decode([Attachment].self, forKey: .attachments)
      serverIdentifiers = try values.decodeIfPresent([String: String].self, forKey: .serverIdentifiers) ?? [:]
      remoteRecords = try values.decodeIfPresent(
        [String: AttachmentRemoteRecord].self,
        forKey: .remoteRecords
      ) ?? serverIdentifiers.mapValues {
        AttachmentRemoteRecord(
          serverId: $0,
          status: .awaitingVerification,
          retryAt: nil,
          consecutiveFailures: 0,
          lastErrorCode: nil
        )
      }
      tombstones = try values.decodeIfPresent(
        [String: AttachmentTombstone].self,
        forKey: .tombstones
      ) ?? [:]
    }
  }

  init(directory: URL? = nil, outbox: OutboxQueue? = nil) {
    let base = directory
      ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        .appending(path: "Attachments")
    baseDirectory = base
    indexURL = base.appending(path: "index.json")
    self.outbox = outbox
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
    if let data = try? Data(contentsOf: indexURL),
      let decoded = try? JSONDecoder().decode(IndexFile.self, from: data)
    {
      attachments = decoded.attachments
      remoteRecords = decoded.remoteRecords
      tombstones = decoded.tombstones
    }
  }

  // MARK: Queries

  func attachments(ownerKind: AttachmentOwnerKind, ownerId: String) -> [Attachment] {
    attachments
      .filter { $0.ownerKind == ownerKind && $0.ownerId == ownerId }
      .sorted { $0.createdAt > $1.createdAt }
  }

  func attachment(id: String) -> Attachment? {
    attachments.first { $0.id == id }
  }

  func remoteRecord(localId: String) -> AttachmentRemoteRecord? {
    remoteRecords[localId]
  }

  func statusLabel(for attachment: Attachment) -> String? {
    guard !attachment.pendingSync else { return "En file" }
    switch remoteRecords[attachment.id]?.status {
    case .awaitingVerification, .quarantined:
      return "En vérification / fichier bloqué"
    case .failed:
      return "Synchronisation à reprendre"
    case .available, .none:
      return nil
    }
  }

  var storageBytes: Int {
    attachments.reduce(0) { $0 + $1.byteSize }
  }

  var fileCount: Int {
    attachments.count
  }

  // MARK: Adding

  func addPhoto(_ data: Data, ownerKind: AttachmentOwnerKind, ownerId: String) throws -> Attachment {
    try write(
      data,
      ownerKind: ownerKind,
      ownerId: ownerId,
      mediaKind: .photo,
      displayName: "Photo",
      fileExtension: "jpg",
      mimeType: "image/jpeg"
    )
  }

  func addDocument(from sourceURL: URL, ownerKind: AttachmentOwnerKind, ownerId: String) throws -> Attachment {
    let secured = sourceURL.startAccessingSecurityScopedResource()
    defer { if secured { sourceURL.stopAccessingSecurityScopedResource() } }
    let data = try Data(contentsOf: sourceURL)
    let displayName = sourceURL.lastPathComponent
    let fileExtension = sourceURL.pathExtension.lowercased()
    return try write(
      data,
      ownerKind: ownerKind,
      ownerId: ownerId,
      mediaKind: .document,
      displayName: displayName,
      fileExtension: fileExtension,
      mimeType: Self.mimeType(forExtension: fileExtension)
    )
  }

  private func write(
    _ data: Data,
    ownerKind: AttachmentOwnerKind,
    ownerId: String,
    mediaKind: AttachmentMediaKind,
    displayName: String,
    fileExtension: String,
    mimeType: String
  ) throws -> Attachment {
    let id = UUID().uuidString
    let extension_ = fileExtension.isEmpty
      ? (mediaKind == .photo ? "jpg" : "dat")
      : fileExtension
    let diskName = "\(id).\(extension_)"
    try data.write(to: baseDirectory.appending(path: diskName), options: .atomic)

    let attachment = Attachment(
      id: id,
      ownerKind: ownerKind,
      ownerId: ownerId,
      mediaKind: mediaKind,
      fileName: displayName,
      fileExtension: extension_,
      byteSize: data.count,
      createdAt: Date(),
      pendingSync: true
    )
    attachments.append(attachment)
    do {
      try persist()
    } catch {
      attachments.removeAll { $0.id == id }
      try? FileManager.default.removeItem(at: baseDirectory.appending(path: diskName))
      throw error
    }

    let queued = outbox?.enqueue(
      OutboxItem(
        id: UUID().uuidString,
        idempotencyKey: "upload-\(id)",
        kind: .attachmentUpload,
        ownerKind: ownerKind.rawValue,
        ownerId: ownerId,
        subjectId: id,
        label: displayName,
        createdAt: Date()
      )
    ) ?? true
    guard queued else {
      attachments.removeAll { $0.id == id }
      try? persist()
      try? FileManager.default.removeItem(at: baseDirectory.appending(path: diskName))
      throw AttachmentStoreError.outboxPersistenceFailed
    }
    return attachment
  }

  // MARK: Reading

  func fileURL(for attachment: Attachment) -> URL {
    baseDirectory.appending(path: "\(attachment.id).\(attachment.fileExtension)")
  }

  /// Unique, deterministic server filename used only for reconciliation.
  /// The operator-facing original name remains in the local Attachment.
  nonisolated static func remoteUploadFileName(for attachment: Attachment) -> String {
    "\(attachment.id).\(attachment.fileExtension)"
  }

  func data(for attachment: Attachment) -> Data? {
    try? Data(contentsOf: fileURL(for: attachment))
  }

  /// Downsampled thumbnail through ImageIO — full-resolution images are
  /// never decoded into memory for grid display.
  func image(for attachment: Attachment, maxPixel: CGFloat = 640) -> UIImage? {
    if let cached = thumbnailCache.object(forKey: attachment.id as NSString) {
      return cached
    }
    let options: [CFString: Any] = [
      kCGImageSourceCreateThumbnailFromImageAlways: true,
      kCGImageSourceThumbnailMaxPixelSize: maxPixel,
      kCGImageSourceCreateThumbnailWithTransform: true,
    ]
    guard let source = CGImageSourceCreateWithURL(fileURL(for: attachment) as CFURL, nil),
      let cgImage = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary)
    else { return nil }
    let image = UIImage(cgImage: cgImage)
    thumbnailCache.setObject(image, forKey: attachment.id as NSString)
    return image
  }

  // MARK: Durable sync bookkeeping

  /// Persists the durable POST acknowledgement before the upload queue item
  /// can be removed. When the local attachment was deleted during the POST,
  /// the late acknowledgement is bound to its tombstone instead.
  func recordUploadAcknowledgement(
    localId: String,
    serverId: String,
    ownerKind: AttachmentOwnerKind,
    ownerId: String,
    uploadFileName: String
  ) throws {
    try persistMutation {
      if let index = attachments.firstIndex(where: { $0.id == localId }) {
        attachments[index].pendingSync = false
        remoteRecords[localId] = AttachmentRemoteRecord(
          serverId: serverId,
          status: .awaitingVerification,
          retryAt: nil,
          consecutiveFailures: 0,
          lastErrorCode: nil
        )
      } else {
        var tombstone = tombstones[localId] ?? AttachmentTombstone(
          localId: localId,
          ownerKind: ownerKind,
          ownerId: ownerId,
          uploadFileName: uploadFileName,
          contentSHA256: nil,
          serverId: nil
        )
        tombstone.serverId = serverId
        tombstones[localId] = tombstone
      }
    }
  }

  func markQuarantined(localId: String, retryAt: Date, code: String = "attachment_quarantined") throws {
    guard var record = remoteRecords[localId] else { return }
    record.status = .quarantined
    record.retryAt = retryAt
    record.consecutiveFailures += 1
    record.lastErrorCode = code
    try persistMutation { remoteRecords[localId] = record }
  }

  func deferVerification(localId: String, retryAt: Date, code: String?) throws {
    guard var record = remoteRecords[localId] else { return }
    record.status = .awaitingVerification
    record.retryAt = retryAt
    record.consecutiveFailures += 1
    record.lastErrorCode = code
    try persistMutation { remoteRecords[localId] = record }
  }

  func markDownloadVerified(localId: String) throws {
    guard var record = remoteRecords[localId] else { return }
    record.status = .available
    record.retryAt = nil
    record.consecutiveFailures = 0
    record.lastErrorCode = nil
    try persistMutation { remoteRecords[localId] = record }
  }

  func markVerificationFailed(localId: String, code: String) throws {
    guard var record = remoteRecords[localId] else { return }
    record.status = .failed
    record.lastErrorCode = code
    try persistMutation { remoteRecords[localId] = record }
  }

  // MARK: Deleting

  func delete(_ attachment: Attachment) throws {
    let existing = attachments.first(where: { $0.id == attachment.id }) ?? attachment
    let serverId = remoteRecords[attachment.id]?.serverId ?? tombstones[attachment.id]?.serverId
    let contentSHA256 = data(for: existing).map(Self.sha256Hex)
    try persistMutation {
      tombstones[attachment.id] = AttachmentTombstone(
        localId: attachment.id,
        ownerKind: existing.ownerKind,
        ownerId: existing.ownerId,
        uploadFileName: Self.remoteUploadFileName(for: existing),
        contentSHA256: contentSHA256,
        serverId: serverId
      )
      attachments.removeAll { $0.id == attachment.id }
      remoteRecords.removeValue(forKey: attachment.id)
    }
    try? FileManager.default.removeItem(at: fileURL(for: existing))

    guard outbox?.remove(idempotencyKey: "upload-\(attachment.id)") ?? true,
      outbox?.remove(idempotencyKey: "download-\(attachment.id)") ?? true
    else { throw AttachmentStoreError.outboxPersistenceFailed }
    if let serverId {
      guard outbox?.enqueue(
        OutboxItem(
          id: UUID().uuidString,
          idempotencyKey: "delete-\(serverId)",
          kind: .attachmentDelete,
          ownerKind: attachment.ownerKind.rawValue,
          ownerId: attachment.ownerId,
          subjectId: serverId,
          label: attachment.fileName,
          createdAt: Date()
        )
      ) ?? true else { throw AttachmentStoreError.outboxPersistenceFailed }
    }
  }

  func deleteAll() throws {
    for attachment in attachments {
      try delete(attachment)
    }
  }

  func completeRemoteDelete(serverId: String) throws {
    try persistMutation {
      let deletedFingerprints = Set(
        tombstones.values
          .filter { $0.serverId == serverId }
          .compactMap(Self.fingerprint)
      )
      tombstones = tombstones.filter { _, tombstone in
        guard tombstone.serverId != serverId else { return false }
        guard tombstone.serverId == nil,
          let fingerprint = Self.fingerprint(tombstone)
        else { return true }
        // A duplicate may have been deleted before its deduplicated POST
        // response arrived. The known sibling deletion also satisfies that
        // unresolved tombstone, preventing an unresolvable filename lookup.
        return !deletedFingerprints.contains(fingerprint)
      }
    }
  }

  /// True while another local attachment still depends on this deduplicated
  /// server object. Callers must not send DELETE in that state.
  func hasActiveReference(toServerId serverId: String) -> Bool {
    if remoteRecords.values.contains(where: { $0.serverId == serverId }) {
      return true
    }
    return tombstones.values
      .filter { $0.serverId == serverId }
      .contains(where: hasActiveEquivalentContent)
  }

  /// Repairs all safe cross-file crash windows without making a network call.
  /// In particular, a durable server ID plus a stale upload entry never causes
  /// another POST after relaunch.
  func reconcilePersistentState() throws {
    guard let outbox else { return }
    for attachment in attachments {
      if let record = remoteRecords[attachment.id] {
        guard outbox.remove(idempotencyKey: "upload-\(attachment.id)") else {
          throw AttachmentStoreError.outboxPersistenceFailed
        }
        if record.status != .available {
          guard outbox.enqueue(OutboxItem(
            id: UUID().uuidString,
            idempotencyKey: "download-\(attachment.id)",
            kind: .attachmentDownload,
            ownerKind: attachment.ownerKind.rawValue,
            ownerId: attachment.ownerId,
            subjectId: attachment.id,
            label: attachment.fileName,
            createdAt: Date(),
            attempts: record.consecutiveFailures,
            notBefore: record.retryAt,
            lastErrorCode: record.lastErrorCode
          )) else { throw AttachmentStoreError.outboxPersistenceFailed }
        } else {
          guard outbox.remove(idempotencyKey: "download-\(attachment.id)") else {
            throw AttachmentStoreError.outboxPersistenceFailed
          }
        }
      } else if !outbox.contains(idempotencyKey: "upload-\(attachment.id)") {
        guard outbox.enqueue(OutboxItem(
          id: UUID().uuidString,
          idempotencyKey: "upload-\(attachment.id)",
          kind: .attachmentUpload,
          ownerKind: attachment.ownerKind.rawValue,
          ownerId: attachment.ownerId,
          subjectId: attachment.id,
          label: attachment.fileName,
          createdAt: attachment.createdAt
        )) else { throw AttachmentStoreError.outboxPersistenceFailed }
      }
    }
    for tombstone in tombstones.values {
      guard outbox.remove(idempotencyKey: "upload-\(tombstone.localId)"),
        outbox.remove(idempotencyKey: "download-\(tombstone.localId)")
      else { throw AttachmentStoreError.outboxPersistenceFailed }
      if let serverId = tombstone.serverId {
        if hasActiveReference(toServerId: serverId) {
          guard outbox.remove(idempotencyKey: "delete-\(serverId)") else {
            throw AttachmentStoreError.outboxPersistenceFailed
          }
          continue
        }
        guard outbox.enqueue(OutboxItem(
          id: UUID().uuidString,
          idempotencyKey: "delete-\(serverId)",
          kind: .attachmentDelete,
          ownerKind: tombstone.ownerKind.rawValue,
          ownerId: tombstone.ownerId,
          subjectId: serverId,
          label: tombstone.uploadFileName,
          createdAt: Date()
        )) else { throw AttachmentStoreError.outboxPersistenceFailed }
      }
    }
  }

  // MARK: Plumbing

  private func persistMutation(_ mutation: () -> Void) throws {
    let previousAttachments = attachments
    let previousRemoteRecords = remoteRecords
    let previousTombstones = tombstones
    mutation()
    do {
      try persist()
    } catch {
      attachments = previousAttachments
      remoteRecords = previousRemoteRecords
      tombstones = previousTombstones
      throw error
    }
  }

  private func persist() throws {
    let envelope = IndexFile(
      attachments: attachments,
      remoteRecords: remoteRecords,
      tombstones: tombstones
    )
    do {
      let data = try JSONEncoder().encode(envelope)
      try data.write(to: indexURL, options: .atomic)
    } catch {
      throw AttachmentStoreError.persistenceFailed
    }
  }

  nonisolated static func mimeType(forExtension fileExtension: String) -> String {
    switch fileExtension {
    case "jpg", "jpeg": "image/jpeg"
    case "png": "image/png"
    case "heic": "image/heic"
    case "pdf": "application/pdf"
    case "txt": "text/plain"
    case "csv": "text/csv"
    case "doc", "docx": "application/msword"
    case "xls", "xlsx": "application/vnd.ms-excel"
    case "zip": "application/zip"
    default: "application/octet-stream"
    }
  }

  private func hasActiveEquivalentContent(to tombstone: AttachmentTombstone) -> Bool {
    guard let expectedSHA256 = tombstone.contentSHA256 else { return false }
    return attachments.contains { attachment in
      guard attachment.ownerKind == tombstone.ownerKind,
        attachment.ownerId == tombstone.ownerId,
        let bytes = data(for: attachment)
      else { return false }
      return Self.sha256Hex(bytes) == expectedSHA256
    }
  }

  private nonisolated static func fingerprint(_ tombstone: AttachmentTombstone) -> String? {
    guard let digest = tombstone.contentSHA256 else { return nil }
    return "\(tombstone.ownerKind.rawValue)\u{1F}\(tombstone.ownerId)\u{1F}\(digest)"
  }

  private nonisolated static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }
}
