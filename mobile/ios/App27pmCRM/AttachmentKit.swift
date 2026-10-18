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

/// Authenticated collection metadata, never a storage URL or a local path.
nonisolated struct RemoteAttachmentMetadata: Decodable, Sendable {
  let id: String
  let ownerKind: String
  let ownerId: String
  let fileName: String
  let contentType: String
  let byteSize: Int
  let sha256: String
  let objectVersion: String
  let createdAt: String
}

struct AttachmentRemoteRecord: Codable, Equatable {
  let serverId: String
  var status: AttachmentRemoteStatus
  var retryAt: Date?
  var consecutiveFailures: Int
  var lastErrorCode: String?
  // Optional additions preserve indexes written before remote discovery.
  var expectedSHA256: String? = nil
  var objectVersion: String? = nil
  var remoteOnly: Bool? = nil
  var downloadRequested: Bool? = nil
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
  case emptyFile
  case fileTooLarge
  case unsupportedPhoto
  case invalidFileName
  case invalidRemoteMetadata
  case downloadIntegrityFailed
  case attachmentBlocked

  var errorDescription: String? {
    switch self {
    case .persistenceFailed:
      "La pièce jointe n'a pas pu être enregistrée durablement sur l'appareil."
    case .outboxPersistenceFailed:
      "L'opération de synchronisation n'a pas pu être enregistrée durablement."
    case .emptyFile:
      "Le fichier est vide. Choisissez un fichier contenant des données."
    case .fileTooLarge:
      "Le fichier dépasse la limite de 20 Mio. Choisissez un fichier plus petit."
    case .unsupportedPhoto:
      "Cette image ne peut pas être importée. Utilisez une photo JPEG, PNG ou HEIC."
    case .invalidFileName:
      "Le nom de fichier n'est pas accepté. Renommez le fichier, puis réessayez."
    case .invalidRemoteMetadata:
      "La liste des fichiers du CRM est invalide. Aucun fichier n'a été importé."
    case .downloadIntegrityFailed:
      "Le fichier téléchargé ne correspond pas à la version attendue. Réessayez sa vérification."
    case .attachmentBlocked:
      "Ce fichier est bloqué par le contrôle de sécurité et ne peut pas être téléchargé."
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
  nonisolated static let maximumFileBytes = 20 * 1024 * 1024
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
    if attachment.pendingSync {
      guard let code = outbox?.item(idempotencyKey: "upload-\(attachment.id)")?.lastErrorCode else {
        return "En file"
      }
      switch code {
      case "authentication_required", "authentication_retry_incomplete", "authentication_session_changed":
        return "Connexion requise"
      case "transport_unavailable", "attachment_storage_unavailable", "attachment_transport_disabled":
        return "Envoi interrompu · réessayer"
      case "attachment_validation_failed", "invalid_upload_manifest", "attachment_too_large", "attachment_size_exceeded":
        return "Fichier refusé · vérifier le format et la taille"
      case "attachment_media_type_mismatch", "attachment_media_type_rejected", "attachment_unsupported_media_type", "unsupported_media_type":
        return "Format de fichier non accepté"
      default:
        return "Envoi à reprendre"
      }
    }
    let record = remoteRecords[attachment.id]
    if record?.lastErrorCode == "attachment_blocked" { return "Fichier bloqué" }
    if record?.status == .failed { return "Vérification à reprendre" }
    if record?.remoteOnly == true, record?.downloadRequested != true {
      return "Sur le CRM · non téléchargé"
    }
    switch record?.status {
    case .awaitingVerification, .quarantined:
      return record?.lastErrorCode == nil || record?.lastErrorCode == "attachment_quarantined"
        ? "Analyse en attente" : "Vérification à reprendre"
    case .failed:
      return "Vérification à reprendre"
    case .available, .none:
      return nil
    }
  }

  var storageBytes: Int {
    attachments.filter(hasLocalCopy).reduce(0) { $0 + $1.byteSize }
  }

  var fileCount: Int {
    attachments.count
  }

  // MARK: Adding

  func addPhoto(_ data: Data, ownerKind: AttachmentOwnerKind, ownerId: String) throws -> Attachment {
    try Self.validateSize(data.count)
    let photo = try Self.photoRepresentation(data)
    return try write(
      photo.data,
      ownerKind: ownerKind,
      ownerId: ownerId,
      mediaKind: .photo,
      displayName: "Photo",
      fileExtension: photo.fileExtension,
      mimeType: Self.mimeType(forExtension: photo.fileExtension)
    )
  }

  func addDocument(from sourceURL: URL, ownerKind: AttachmentOwnerKind, ownerId: String) throws -> Attachment {
    let secured = sourceURL.startAccessingSecurityScopedResource()
    defer { if secured { sourceURL.stopAccessingSecurityScopedResource() } }
    // Reject oversized providers before allocating their entire file. The
    // write boundary checks again because a provider can change after stat.
    let resource = try sourceURL.resourceValues(forKeys: [.fileSizeKey, .isRegularFileKey])
    guard resource.isRegularFile != false else { throw AttachmentStoreError.invalidFileName }
    guard let size = resource.fileSize else { throw AttachmentStoreError.invalidFileName }
    try Self.validateSize(size)
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
    try Self.validateSize(data.count)
    guard Self.validFileName(displayName) else { throw AttachmentStoreError.invalidFileName }
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

  func hasLocalCopy(_ attachment: Attachment) -> Bool {
    remoteRecords[attachment.id]?.remoteOnly != true
      && FileManager.default.fileExists(atPath: fileURL(for: attachment).path)
  }

  func fileURL(for attachment: Attachment) -> URL {
    baseDirectory.appending(path: "\(attachment.id).\(attachment.fileExtension)")
  }

  /// Unique, deterministic server filename used only for reconciliation.
  /// The operator-facing original name remains in the local Attachment.
  nonisolated static func remoteUploadFileName(for attachment: Attachment) -> String {
    "\(attachment.id).\(attachment.fileExtension)"
  }

  func data(for attachment: Attachment) -> Data? {
    guard hasLocalCopy(attachment) else { return nil }
    return try? Data(contentsOf: fileURL(for: attachment))
  }

  /// Downsampled thumbnail through ImageIO — full-resolution images are
  /// never decoded into memory for grid display.
  func image(for attachment: Attachment, maxPixel: CGFloat = 640) -> UIImage? {
    guard hasLocalCopy(attachment) else { return nil }
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

  /// Adds a read-only local projection. Discovering metadata never authorizes
  /// transferring bytes, revives a deleted row, or replaces a cached original.
  func importRemoteAttachments(
    _ metadata: [RemoteAttachmentMetadata],
    ownerKind: AttachmentOwnerKind,
    ownerId: String
  ) throws {
    guard UUID(uuidString: ownerId) != nil, metadata.count <= 200 else {
      throw AttachmentStoreError.invalidRemoteMetadata
    }
    // Validate the complete envelope before publishing any partial import.
    let rows = try metadata.map { row -> (RemoteAttachmentMetadata, Date) in
      guard UUID(uuidString: row.id) != nil,
        row.ownerKind == ownerKind.rawValue, row.ownerId == ownerId,
        UUID(uuidString: row.ownerId) != nil,
        Self.validFileName(row.fileName), Self.allowedContentTypes.contains(row.contentType),
        (1...Self.maximumFileBytes).contains(row.byteSize),
        Self.validSHA256(row.sha256), Self.validObjectVersion(row.objectVersion),
        let createdAt = Self.remoteDate(row.createdAt)
      else { throw AttachmentStoreError.invalidRemoteMetadata }
      return (row, createdAt)
    }
    try persistMutation {
      for (row, createdAt) in rows {
        let serverId = row.id.lowercased()
        guard !tombstones.values.contains(where: {
            $0.serverId?.lowercased() == serverId
              || ($0.serverId == nil && $0.ownerKind == ownerKind && $0.ownerId == ownerId
                && $0.uploadFileName == row.fileName)
          }),
          !attachments.contains(where: {
            $0.pendingSync && $0.ownerKind == ownerKind && $0.ownerId == ownerId
              && (Self.remoteUploadFileName(for: $0) == row.fileName || $0.fileName == row.fileName)
          })
        else { continue }
        let existingIds = remoteRecords.filter { $0.value.serverId.lowercased() == serverId }.map(\.key)
        if !existingIds.isEmpty {
          for localId in existingIds {
            guard let index = attachments.firstIndex(where: { $0.id == localId }),
              var record = remoteRecords[localId], record.remoteOnly == true,
              attachments[index].ownerKind == ownerKind, attachments[index].ownerId == ownerId,
              !FileManager.default.fileExists(atPath: fileURL(for: attachments[index]).path)
            else { continue }
            let versionChanged = record.objectVersion != row.objectVersion
            // One object version is immutable: contradictory metadata must
            // never silently rebind an in-flight download or a blocked row.
            guard versionChanged || (record.expectedSHA256 == row.sha256 && attachments[index].byteSize == row.byteSize)
            else { continue }
            attachments[index] = Attachment(
              id: localId, ownerKind: ownerKind, ownerId: ownerId,
              mediaKind: row.contentType.hasPrefix("image/") ? .photo : .document,
              fileName: row.fileName, fileExtension: Self.safeExtension(for: row.fileName),
              byteSize: row.byteSize, createdAt: createdAt, pendingSync: false
            )
            record.expectedSHA256 = row.sha256
            record.objectVersion = row.objectVersion
            if versionChanged {
              record.status = .awaitingVerification
              record.retryAt = nil
              record.consecutiveFailures = 0
              record.lastErrorCode = nil
              record.downloadRequested = false
            }
            remoteRecords[localId] = record
          }
          continue
        }
        let extension_ = Self.safeExtension(for: row.fileName)
        let occupied = attachments.contains(where: { $0.id.lowercased() == serverId })
          || remoteRecords.keys.contains(where: { $0.lowercased() == serverId })
          || tombstones.keys.contains(where: { $0.lowercased() == serverId })
          || FileManager.default.fileExists(atPath: baseDirectory.appending(path: "\(serverId).\(extension_)").path)
        let localId = occupied ? UUID().uuidString.lowercased() : serverId
        let attachment = Attachment(
          id: localId,
          ownerKind: ownerKind,
          ownerId: ownerId,
          mediaKind: row.contentType.hasPrefix("image/") ? .photo : .document,
          fileName: row.fileName,
          fileExtension: extension_,
          byteSize: row.byteSize,
          createdAt: createdAt,
          pendingSync: false
        )
        attachments.append(attachment)
        remoteRecords[localId] = AttachmentRemoteRecord(
          serverId: serverId,
          status: .awaitingVerification,
          retryAt: nil,
          consecutiveFailures: 0,
          lastErrorCode: nil,
          expectedSHA256: row.sha256,
          objectVersion: row.objectVersion,
          remoteOnly: true
        )
      }
    }
  }

  /// Explicit operator intent survives a restart, unlike discovery alone.
  func requestRemoteDownload(localId: String) throws {
    guard let attachment = attachment(id: localId), var record = remoteRecords[localId],
      record.remoteOnly == true
    else { throw AttachmentStoreError.invalidRemoteMetadata }
    guard record.lastErrorCode != "attachment_blocked" else { throw AttachmentStoreError.attachmentBlocked }
    record.downloadRequested = true
    try persistMutation { remoteRecords[localId] = record }
    guard enqueueDownload(attachment, record: record) else {
      // Intent stays durable for reconciliation; no bytes become visible.
      throw AttachmentStoreError.outboxPersistenceFailed
    }
  }

  func retryAttachment(localId: String) throws {
    guard let attachment = attachment(id: localId) else { return }
    guard remoteRecords[localId]?.lastErrorCode != "attachment_blocked" else {
      throw AttachmentStoreError.attachmentBlocked
    }
    if attachment.pendingSync {
      try reconcilePersistentState()
      guard outbox?.retry(idempotencyKey: "upload-\(localId)") ?? true else {
        throw AttachmentStoreError.outboxPersistenceFailed
      }
    } else if var record = remoteRecords[localId] {
      record.status = .awaitingVerification
      record.retryAt = nil
      record.lastErrorCode = nil
      if record.remoteOnly == true { record.downloadRequested = true }
      try persistMutation { remoteRecords[localId] = record }
      guard enqueueDownload(attachment, record: record),
        outbox?.retry(idempotencyKey: "download-\(localId)") ?? true
      else { throw AttachmentStoreError.outboxPersistenceFailed }
    }
  }

  /// Publish downloaded bytes only after their immutable metadata and index
  /// both commit. A failed index write restores the previous disk contents.
  func cacheRemoteDownload(localId: String, data: Data, objectVersion: String) throws {
    guard let attachment = attachment(id: localId), var record = remoteRecords[localId],
      record.lastErrorCode != "attachment_blocked",
      let digest = record.expectedSHA256, record.objectVersion == objectVersion,
      data.count == attachment.byteSize, Self.sha256Hex(data) == digest
    else { throw AttachmentStoreError.downloadIntegrityFailed }
    let destination = fileURL(for: attachment)
    let previousData = try? Data(contentsOf: destination)
    // Never replace an original/cached version with a different byte stream.
    if let previousData, previousData != data { throw AttachmentStoreError.downloadIntegrityFailed }
    try data.write(to: destination, options: .atomic)
    record.remoteOnly = false
    record.downloadRequested = false
    record.status = .available
    record.retryAt = nil
    record.consecutiveFailures = 0
    record.lastErrorCode = nil
    do {
      try persistMutation { remoteRecords[localId] = record }
    } catch {
      if let previousData { try? previousData.write(to: destination, options: .atomic) }
      else { try? FileManager.default.removeItem(at: destination) }
      throw error
    }
  }

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
    record.retryAt = nil
    record.lastErrorCode = code
    try persistMutation { remoteRecords[localId] = record }
  }

  func markBlocked(localId: String) throws {
    guard var record = remoteRecords[localId] else { return }
    record.status = .failed
    record.retryAt = nil
    record.lastErrorCode = "attachment_blocked"
    record.downloadRequested = false
    try persistMutation { remoteRecords[localId] = record }
    guard outbox?.remove(idempotencyKey: "download-\(localId)") ?? true else {
      throw AttachmentStoreError.outboxPersistenceFailed
    }
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
        if record.status != .available, record.lastErrorCode != "attachment_blocked",
          record.remoteOnly != true || record.downloadRequested == true
        {
          guard enqueueDownload(attachment, record: record) else {
            throw AttachmentStoreError.outboxPersistenceFailed
          }
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

  private func enqueueDownload(_ attachment: Attachment, record: AttachmentRemoteRecord) -> Bool {
    outbox?.enqueue(OutboxItem(
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
    )) ?? true
  }

  private nonisolated static func validateSize(_ byteSize: Int) throws {
    guard byteSize > 0 else { throw AttachmentStoreError.emptyFile }
    guard byteSize <= maximumFileBytes else { throw AttachmentStoreError.fileTooLarge }
  }

  private nonisolated static func validFileName(_ value: String) -> Bool {
    !value.isEmpty && value.utf16.count <= 255 && value != "." && value != ".."
      && !value.contains("/") && !value.contains("\\")
      && value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
      && value.precomposedStringWithCompatibilityMapping == value
  }

  private nonisolated static func safeExtension(for fileName: String) -> String {
    let candidate = (fileName as NSString).pathExtension.lowercased()
    guard !candidate.isEmpty, candidate.count <= 12,
      candidate.unicodeScalars.allSatisfy({ CharacterSet.alphanumerics.contains($0) && $0.isASCII })
    else { return "dat" }
    return candidate
  }

  private nonisolated static func validSHA256(_ value: String) -> Bool {
    value.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
  }

  private nonisolated static func validObjectVersion(_ value: String) -> Bool {
    value.range(of: "^[A-Za-z0-9._:-]{1,256}$", options: .regularExpression) != nil
  }

  private nonisolated static func remoteDate(_ value: String) -> Date? {
    guard value.count <= 64 else { return nil }
    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let date = formatter.date(from: value) { return date }
    formatter.formatOptions = [.withInternetDateTime]
    return formatter.date(from: value)
  }

  private nonisolated static let allowedContentTypes: Set<String> = [
    "image/jpeg", "image/png", "image/heic", "application/pdf", "text/plain", "text/csv",
    "application/msword", "application/vnd.ms-excel", "application/zip", "application/octet-stream",
  ]

  private static func photoRepresentation(_ data: Data) throws -> (data: Data, fileExtension: String) {
    if data.starts(with: [0xFF, 0xD8, 0xFF]) { return (data, "jpg") }
    if data.starts(with: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) { return (data, "png") }
    if data.count >= 16, data.subdata(in: 4..<8) == Data("ftyp".utf8) {
      let brands = Set(["heic", "heix", "hevc", "hevx"])
      let boxSize = data.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
      if boxSize >= 16, boxSize <= data.count, boxSize <= 4096 {
        let brandOffsets = [8] + Array(stride(from: 16, to: boxSize - 3, by: 4))
        if brandOffsets.contains(where: { brands.contains(String(decoding: data[$0..<($0 + 4)], as: UTF8.self)) }) {
          return (data, "heic")
        }
      }
    }
    guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else {
      throw AttachmentStoreError.unsupportedPhoto
    }
    try validateSize(jpeg.count)
    return (jpeg, "jpg")
  }

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
