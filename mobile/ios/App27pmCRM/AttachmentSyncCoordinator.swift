import CryptoKit
import Foundation
import NativeAttachmentPolicy
import Observation

enum AttachmentCollectionState: Equatable {
  case idle, loading, loaded, failed
}

/// Owns the attachment-only HTTP state machine. The reviewed policy decides
/// before any authentication action, so only a first 401 can rotate tokens.
/// Storage/scanner states (423/5xx), authorization failures and validation
/// errors can never masquerade as token expiry.
@MainActor
@Observable
final class AttachmentSyncCoordinator {
  private let api: AttachmentAPITransport
  private let attachments: AttachmentStore
  private let outbox: OutboxQueue
  private let authenticationToken: () -> String?
  private let authenticationEpoch: () -> UInt64
  private let refreshAuthentication: (_ rejectedAccessToken: String?) async -> Bool
  private let authenticationRequired: (_ rejectedAccessToken: String?) -> Void
  private let now: () -> Date
  private var isReconciling = false
  /// The epoch of the most recent trigger received while another pass was
  /// suspended. Tagging the trigger prevents an old-session wake-up from being
  /// replayed after logout, while preserving a genuine new-session wake-up.
  private var pendingReconcileEpoch: UInt64?
  private var abortCurrentDrain = false
  private var sessionEpochChanged = false
  private struct CollectionKey: Hashable {
    let kind: AttachmentOwnerKind
    let id: String
  }
  private var collectionRequests: [CollectionKey: UInt64] = [:]
  private var collectionStates: [CollectionKey: AttachmentCollectionState] = [:]

  func collectionState(ownerKind: AttachmentOwnerKind, ownerId: String) -> AttachmentCollectionState {
    collectionStates[CollectionKey(kind: ownerKind, id: ownerId)] ?? .idle
  }

  /// Collection reads share the same serialized authentication/refresh lane
  /// as uploads. A late response from a prior login cannot import metadata.
  func refreshRemoteAttachments(
    ownerKind: AttachmentOwnerKind, ownerId: String,
    expectedAuthenticationEpoch: UInt64
  ) async {
    guard authenticationEpoch() == expectedAuthenticationEpoch else { return }
    let key = CollectionKey(kind: ownerKind, id: ownerId)
    collectionRequests[key] = expectedAuthenticationEpoch
    collectionStates[key] = .loading
    await reconcileAndDrain(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
  }

  init(
    api: AttachmentAPITransport,
    attachments: AttachmentStore,
    outbox: OutboxQueue,
    authenticationToken: @escaping () -> String?,
    authenticationEpoch: @escaping () -> UInt64 = { 0 },
    refreshAuthentication: @escaping (_ rejectedAccessToken: String?) async -> Bool,
    authenticationRequired: @escaping (_ rejectedAccessToken: String?) -> Void,
    now: @escaping () -> Date = Date.init
  ) {
    self.api = api
    self.attachments = attachments
    self.outbox = outbox
    self.authenticationToken = authenticationToken
    self.authenticationEpoch = authenticationEpoch
    self.refreshAuthentication = refreshAuthentication
    self.authenticationRequired = authenticationRequired
    self.now = now
  }

  func reconcileAndDrain(expectedAuthenticationEpoch requestedEpoch: UInt64? = nil) async {
    // MainActor methods are re-entrant across awaits. Serialize the complete
    // reconcile/list/drain transaction so overlapping UI, timer and network
    // triggers cannot rotate one refresh token twice. An overlapping trigger
    // is coalesced into a full follow-up pass so work created while this pass
    // is suspended cannot be stranded until another unrelated event.
    let requestedEpoch = requestedEpoch ?? authenticationEpoch()
    guard !isReconciling else {
      // Once the active session has requested a follow-up, a delayed wake-up
      // tagged with an older epoch must not overwrite and strand that request.
      if pendingReconcileEpoch == authenticationEpoch(),
        requestedEpoch != authenticationEpoch()
      {
        return
      }
      pendingReconcileEpoch = requestedEpoch
      return
    }
    isReconciling = true
    defer {
      isReconciling = false
      // Persistence or authentication can stop a pass before its collection
      // reads run. Never strand the UI in loading with refresh disabled.
      let unprocessed = collectionRequests
      collectionRequests.removeAll()
      // Stale-session requests have been abandoned too. They must not leave
      // a reused collection key loading after the next login.
      for key in unprocessed.keys where collectionStates[key] == .loading {
        collectionStates[key] = .failed
      }
    }

    var passEpoch = requestedEpoch
    var forceUnknownTombstoneReconciliation = false
    while true {
      pendingReconcileEpoch = nil
      abortCurrentDrain = false
      sessionEpochChanged = false
      await reconcileAndDrainPass(
        forceUnknownTombstoneReconciliation: forceUnknownTombstoneReconciliation,
        expectedAuthenticationEpoch: passEpoch
      )
      guard !abortCurrentDrain,
        let nextEpoch = pendingReconcileEpoch,
        nextEpoch == authenticationEpoch()
      else { break }
      // Only a trigger issued by the currently active session may request the
      // follow-up pass. A stale trigger from the logged-out epoch is discarded.
      passEpoch = nextEpoch
      forceUnknownTombstoneReconciliation = true
    }
  }

  private func reconcileAndDrainPass(
    forceUnknownTombstoneReconciliation: Bool,
    expectedAuthenticationEpoch: UInt64
  ) async {
    guard authenticationEpoch() == expectedAuthenticationEpoch else {
      sessionEpochChanged = true
      return
    }
    do {
      try attachments.reconcilePersistentState()
    } catch {
      return
    }
    await reconcileUnknownTombstones(
      force: forceUnknownTombstoneReconciliation,
      expectedAuthenticationEpoch: expectedAuthenticationEpoch
    )
    guard !abortCurrentDrain, !sessionEpochChanged else { return }
    await reconcileRemoteCollections(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    guard !abortCurrentDrain, !sessionEpochChanged else { return }
    do {
      try attachments.reconcilePersistentState()
    } catch {
      return
    }
    await outbox.drain(now: now) { [weak self] item in
      guard let self else { return .paused(code: "coordinator_unavailable") }
      return await handle(item, expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    }
  }

  private struct RemoteCollectionEnvelope: Decodable {
    let attachments: [RemoteAttachmentMetadata]
  }

  private func reconcileRemoteCollections(expectedAuthenticationEpoch: UInt64) async {
    let requests = collectionRequests
    for (key, epoch) in requests {
      guard epoch == expectedAuthenticationEpoch else {
        if epoch != authenticationEpoch(), collectionRequests[key] == epoch {
          collectionRequests.removeValue(forKey: key)
          if collectionStates[key] == .loading { collectionStates[key] = .failed }
        }
        continue
      }
      collectionRequests.removeValue(forKey: key)
      let outcome = await request(
        operation: .download, consecutiveFailures: 0,
        expectedAuthenticationEpoch: expectedAuthenticationEpoch
      ) { [api] in
        try await api.listAttachments(ownerKind: key.kind.rawValue, ownerId: key.id)
      }
      guard authenticationEpoch() == expectedAuthenticationEpoch else {
        // This key was removed before the request suspended, so the outer
        // unprocessed-request cleanup cannot see it. Preserve a replacement
        // queued by the current login; otherwise settle the abandoned load.
        if collectionRequests[key] != authenticationEpoch() {
          collectionStates[key] = .failed
        }
        return
      }
      switch outcome {
      case .response(.success, let response):
        do {
          guard response.body.count <= ChunkedAttachmentContract.maxCollectionBytes,
            response.contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces).lowercased()
              == "application/json"
          else { throw RemoteCollectionError.invalid }
          let envelope = try JSONDecoder().decode(RemoteCollectionEnvelope.self, from: response.body)
          guard envelope.attachments.count <= 200 else { throw RemoteCollectionError.invalid }
          try attachments.importRemoteAttachments(envelope.attachments, ownerKind: key.kind, ownerId: key.id)
          collectionStates[key] = .loaded
        } catch {
          collectionStates[key] = .failed
        }
      case .sessionChanged:
        if authenticationEpoch() == expectedAuthenticationEpoch, collectionRequests[key] == nil {
          collectionStates[key] = .failed
        }
        return
      default:
        collectionStates[key] = .failed
      }
      guard !abortCurrentDrain, !sessionEpochChanged else { return }
    }
  }

  private enum RemoteCollectionError: Error { case invalid }

  private func handle(
    _ item: OutboxItem,
    expectedAuthenticationEpoch: UInt64
  ) async -> OutboxDisposition {
    guard !abortCurrentDrain else {
      return .pausedAndStop(code: "authentication_required")
    }
    guard !sessionEpochChanged,
      authenticationEpoch() == expectedAuthenticationEpoch
    else {
      sessionEpochChanged = true
      return .pausedAndStop(code: "authentication_session_changed")
    }
    if Self.isReconciliationItem(item) {
      // Due reconciliation records are normally consumed or moved forward by
      // reconcileUnknownTombstones() before the ordinary drain begins. Keep a
      // durable bounded retry if that hand-off could not be persisted.
      let retryAt = Self.fallbackRetryAt(
        consecutiveFailures: item.attempts,
        now: now()
      )
      return .deferred(until: retryAt, code: "tombstone_reconciliation_pending")
    }
    switch item.kind {
    case .attachmentUpload:
      return await upload(item, expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    case .attachmentDownload:
      return await download(item, expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    case .attachmentDelete:
      return await delete(item, expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    }
  }

  private func upload(
    _ item: OutboxItem,
    expectedAuthenticationEpoch: UInt64
  ) async -> OutboxDisposition {
    guard let attachment = attachments.attachment(id: item.subjectId) else {
      // A concurrent deletion removes this item itself. If it is still here,
      // keep it for diagnosis instead of claiming an upload succeeded.
      return .paused(code: "local_attachment_missing")
    }
    if attachments.remoteRecord(localId: attachment.id) != nil {
      // Crash after durable ACK but before queue removal: repair locally and
      // never issue another POST.
      return ensureDownloadQueued(for: attachment)
        ? .completed
        : .paused(code: "outbox_persistence_failed")
    }
    guard let fileData = attachments.data(for: attachment) else {
      return .paused(code: "local_file_missing")
    }
    let uploadName = AttachmentStore.remoteUploadFileName(for: attachment)
    let outcome = await request(
      operation: .upload,
      consecutiveFailures: item.attempts,
      expectedAuthenticationEpoch: expectedAuthenticationEpoch
    ) { [api] in
      try await api.uploadAttachment(
        fileData: fileData,
        fileName: uploadName,
        mimeType: AttachmentStore.mimeType(forExtension: attachment.fileExtension),
        ownerKind: item.ownerKind,
        ownerId: item.ownerId,
        idempotencyKey: item.idempotencyKey
      )
    }
    switch outcome {
    case .response(.success, let response):
      guard let serverId = Self.uploadedID(from: response.body) else {
        return .paused(code: "invalid_upload_acknowledgement")
      }
      do {
        try attachments.recordUploadAcknowledgement(
          localId: attachment.id,
          serverId: serverId,
          ownerKind: attachment.ownerKind,
          ownerId: attachment.ownerId,
          uploadFileName: uploadName
        )
      } catch {
        return .paused(code: "attachment_ack_persistence_failed")
      }
      // If the local file was removed while POST was suspended, the durable
      // tombstone now has the server ID and reconciliation will enqueue delete.
      if attachments.attachment(id: attachment.id) == nil {
        do {
          try attachments.reconcilePersistentState()
          return .completed
        } catch {
          return .paused(code: "outbox_persistence_failed")
        }
      }
      return ensureDownloadQueued(for: attachment)
        ? .completed
        : .paused(code: "outbox_persistence_failed")
    case .response(.quarantined(let retryAt), let response):
      return .deferred(until: retryAt, code: Self.errorCode(from: response.body) ?? "attachment_quarantined")
    case .response(.retryLater(let retryAt), let response):
      return .deferred(until: retryAt, code: Self.errorCode(from: response.body))
    case .response(.authenticationRequired, _):
      return .pausedAndStop(code: "authentication_required")
    case .response(.forbidden, let response):
      return .paused(code: Self.errorCode(from: response.body) ?? "forbidden")
    case .response(.notFound, let response):
      return .paused(code: Self.errorCode(from: response.body) ?? "not_found")
    case .response(.rejected(let code), _):
      return .paused(code: code ?? "upload_rejected")
    case .response(.refreshAuthenticationOnce, _):
      // request(...) consumes this decision internally.
      return .paused(code: "authentication_retry_incomplete")
    case .transportRetry(let retryAt):
      return .deferred(until: retryAt, code: "transport_unavailable")
    case .sessionChanged:
      return .pausedAndStop(code: "authentication_session_changed")
    }
  }

  private func download(
    _ item: OutboxItem,
    expectedAuthenticationEpoch: UInt64
  ) async -> OutboxDisposition {
    guard let attachment = attachments.attachment(id: item.subjectId) else {
      return .completed
    }
    guard let remote = attachments.remoteRecord(localId: attachment.id) else {
      return .paused(code: "server_identifier_missing")
    }
    let isRemoteDownload = remote.remoteOnly == true && remote.downloadRequested == true
    let localData = attachments.data(for: attachment)
    guard isRemoteDownload || localData != nil else {
      return .paused(code: "local_file_missing")
    }
    let outcome = await request(
      operation: .download,
      consecutiveFailures: item.attempts,
      expectedAuthenticationEpoch: expectedAuthenticationEpoch
    ) { [api] in
      try await api.downloadAttachment(id: remote.serverId)
    }
    switch outcome {
    case .response(.success, let response):
      if isRemoteDownload {
        do {
          guard let version = response.objectVersion else {
            throw RemoteCollectionError.invalid
          }
          try attachments.cacheRemoteDownload(
            localId: attachment.id, data: response.body, objectVersion: version
          )
          return .completed
        } catch {
          try? attachments.markVerificationFailed(localId: attachment.id, code: "download_integrity_mismatch")
          return .paused(code: "download_integrity_mismatch")
        }
      }
      guard let localData,
        Self.isByteIdentical(response, to: localData, expectedLength: attachment.byteSize)
      else {
        let retryAt = AttachmentHTTPPolicy.decide(
          status: 503,
          operation: .download,
          consecutiveFailures: item.attempts,
          now: now()
        ).retryAt ?? now().addingTimeInterval(30)
        try? attachments.deferVerification(
          localId: attachment.id,
          retryAt: retryAt,
          code: "download_integrity_mismatch"
        )
        return .deferred(until: retryAt, code: "download_integrity_mismatch")
      }
      do {
        try attachments.markDownloadVerified(localId: attachment.id)
        return .completed
      } catch {
        return .paused(code: "attachment_state_persistence_failed")
      }
    case .response(.quarantined(let retryAt), let response):
      let code = Self.errorCode(from: response.body) ?? "attachment_quarantined"
      if code == "attachment_blocked" {
        do {
          try attachments.markBlocked(localId: attachment.id)
          return .completed
        } catch {
          return .paused(code: "attachment_state_persistence_failed")
        }
      }
      do {
        try attachments.markQuarantined(localId: attachment.id, retryAt: retryAt, code: code)
      } catch {
        return .paused(code: "attachment_state_persistence_failed")
      }
      return .deferred(until: retryAt, code: code)
    case .response(.retryLater(let retryAt), let response):
      let code = Self.errorCode(from: response.body)
      try? attachments.deferVerification(localId: attachment.id, retryAt: retryAt, code: code)
      return .deferred(until: retryAt, code: code)
    case .response(.authenticationRequired, _):
      return .pausedAndStop(code: "authentication_required")
    case .response(.forbidden, let response):
      let code = Self.errorCode(from: response.body) ?? "forbidden"
      try? attachments.markVerificationFailed(localId: attachment.id, code: code)
      return .paused(code: code)
    case .response(.notFound, let response):
      let code = Self.errorCode(from: response.body) ?? "not_found"
      try? attachments.markVerificationFailed(localId: attachment.id, code: code)
      return .paused(code: code)
    case .response(.rejected(let code), _):
      let resolved = code ?? "download_rejected"
      try? attachments.markVerificationFailed(localId: attachment.id, code: resolved)
      return .paused(code: resolved)
    case .response(.refreshAuthenticationOnce, _):
      return .paused(code: "authentication_retry_incomplete")
    case .transportRetry(let retryAt):
      try? attachments.deferVerification(
        localId: attachment.id,
        retryAt: retryAt,
        code: "transport_unavailable"
      )
      return .deferred(until: retryAt, code: "transport_unavailable")
    case .sessionChanged:
      return .pausedAndStop(code: "authentication_session_changed")
    }
  }

  private func delete(
    _ item: OutboxItem,
    expectedAuthenticationEpoch: UInt64
  ) async -> OutboxDisposition {
    // Server deduplication can make several local files share one durable ID.
    // Removing one local copy must not delete bytes still referenced by
    // another; the persisted tombstone will enqueue DELETE after the final
    // local reference is removed.
    if attachments.hasActiveReference(toServerId: item.subjectId) {
      return .completed
    }
    let outcome = await request(
      operation: .delete,
      consecutiveFailures: item.attempts,
      expectedAuthenticationEpoch: expectedAuthenticationEpoch
    ) { [api] in
      try await api.deleteAttachment(id: item.subjectId)
    }
    switch outcome {
    case .response(.success, _):
      do {
        try attachments.completeRemoteDelete(serverId: item.subjectId)
        return .completed
      } catch {
        return .paused(code: "tombstone_persistence_failed")
      }
    case .response(.quarantined(let retryAt), let response),
      .response(.retryLater(let retryAt), let response):
      return .deferred(until: retryAt, code: Self.errorCode(from: response.body))
    case .response(.authenticationRequired, _):
      return .pausedAndStop(code: "authentication_required")
    case .response(.forbidden, let response):
      return .paused(code: Self.errorCode(from: response.body) ?? "forbidden")
    case .response(.notFound, _):
      // The policy already maps DELETE 404 to success, but keep this branch
      // exhaustive if that policy evolves.
      do {
        try attachments.completeRemoteDelete(serverId: item.subjectId)
        return .completed
      } catch {
        return .paused(code: "tombstone_persistence_failed")
      }
    case .response(.rejected(let code), _):
      return .paused(code: code ?? "delete_rejected")
    case .response(.refreshAuthenticationOnce, _):
      return .paused(code: "authentication_retry_incomplete")
    case .transportRetry(let retryAt):
      return .deferred(until: retryAt, code: "transport_unavailable")
    case .sessionChanged:
      return .pausedAndStop(code: "authentication_session_changed")
    }
  }

  private enum RequestOutcome {
    case response(AttachmentHTTPDecision, AttachmentHTTPResult)
    case transportRetry(Date)
    case sessionChanged
  }

  private func request(
    operation: AttachmentOperation,
    consecutiveFailures: Int,
    expectedAuthenticationEpoch: UInt64,
    perform: () async throws -> AttachmentHTTPResult
  ) async -> RequestOutcome {
    var alreadyRefreshed = false
    while true {
      guard !Task.isCancelled else { return .sessionChanged }
      guard authenticationEpoch() == expectedAuthenticationEpoch else {
        sessionEpochChanged = true
        return .sessionChanged
      }
      // Capture the exact bearer before the transport builds its request.
      // If its 401 arrives after another operation rotated that bearer,
      // DeviceAuth can replay with the current session without rotating again.
      let requestAccessToken = authenticationToken()
      let response: AttachmentHTTPResult
      do {
        response = try await perform()
      } catch let error as CrmAPIError {
        guard authenticationEpoch() == expectedAuthenticationEpoch else {
          sessionEpochChanged = true
          return .sessionChanged
        }
        if case .http(let status, let code) = error,
          (400...599).contains(status), status != 401
        {
          let body = (try? JSONEncoder().encode(["error": code])) ?? Data()
          let response = AttachmentHTTPResult(
            status: status, body: body, retryAfter: nil,
            contentType: "application/json", contentLength: body.count, effectiveURL: nil
          )
          return .response(AttachmentHTTPPolicy.decide(
            status: status, operation: operation, body: body,
            alreadyRefreshed: alreadyRefreshed, consecutiveFailures: consecutiveFailures, now: now()
          ), response)
        }
        let fallback = AttachmentHTTPPolicy.decide(
          status: 503, operation: operation,
          consecutiveFailures: consecutiveFailures, now: now()
        )
        return .transportRetry(fallback.retryAt ?? now().addingTimeInterval(30))
      } catch {
        guard authenticationEpoch() == expectedAuthenticationEpoch else {
          sessionEpochChanged = true
          return .sessionChanged
        }
        let decision = AttachmentHTTPPolicy.decide(
          status: 503,
          operation: operation,
          consecutiveFailures: consecutiveFailures,
          now: now()
        )
        if case .retryLater(let retryAt) = decision { return .transportRetry(retryAt) }
        return .transportRetry(now().addingTimeInterval(30))
      }
      guard !Task.isCancelled else { return .sessionChanged }
      guard authenticationEpoch() == expectedAuthenticationEpoch else {
        sessionEpochChanged = true
        return .sessionChanged
      }
      let decision = AttachmentHTTPPolicy.decide(
        status: response.status,
        operation: operation,
        body: response.body,
        retryAfter: response.retryAfter,
        alreadyRefreshed: alreadyRefreshed,
        consecutiveFailures: consecutiveFailures,
        now: now()
      )
      switch decision {
      case .refreshAuthenticationOnce:
        // The decision above is evaluated before the token lifecycle is
        // touched. This path can execute at most once for one operation.
        alreadyRefreshed = true
        let refreshed = await refreshAuthentication(requestAccessToken)
        guard authenticationEpoch() == expectedAuthenticationEpoch else {
          sessionEpochChanged = true
          return .sessionChanged
        }
        guard refreshed else {
          abortCurrentDrain = true
          authenticationRequired(requestAccessToken)
          return .response(.authenticationRequired, response)
        }
      case .authenticationRequired:
        abortCurrentDrain = true
        authenticationRequired(requestAccessToken)
        return .response(decision, response)
      default:
        return .response(decision, response)
      }
    }
  }

  private func ensureDownloadQueued(for attachment: Attachment) -> Bool {
    let record = attachments.remoteRecord(localId: attachment.id)
    return outbox.enqueue(OutboxItem(
      id: UUID().uuidString,
      idempotencyKey: "download-\(attachment.id)",
      kind: .attachmentDownload,
      ownerKind: attachment.ownerKind.rawValue,
      ownerId: attachment.ownerId,
      subjectId: attachment.id,
      label: attachment.fileName,
      createdAt: Date(),
      attempts: record?.consecutiveFailures ?? 0,
      notBefore: record?.retryAt,
      lastErrorCode: record?.lastErrorCode
    ))
  }

  /// A process can die after the backend commits a POST but before the
  /// suspended response gives a locally-deleted file its server ID. The
  /// deterministic UUID filename makes the read-only collection response an
  /// unambiguous recovery ledger; no content or private storage key is needed.
  private func reconcileUnknownTombstones(
    force: Bool,
    expectedAuthenticationEpoch: UInt64
  ) async {
    let unresolved = attachments.tombstones.values.filter { $0.serverId == nil }
    let groups = Dictionary(grouping: unresolved) {
      "\($0.ownerKind.rawValue)\u{1F}\($0.ownerId)"
    }
    let activeKeys = Set(groups.values.compactMap { tombstones in
      tombstones.first.map(Self.reconciliationKey)
    })
    // A successful late acknowledgement or a user deletion can make a wake-up
    // record obsolete before it is due. Remove only those stale records.
    _ = outbox.removeAll { item in
      Self.isReconciliationItem(item)
        && !activeKeys.contains(item.idempotencyKey)
    }

    for tombstones in groups.values {
      guard let first = tombstones.first else { continue }
      let retryKey = Self.reconciliationKey(first)
      let priorRetry = outbox.item(idempotencyKey: retryKey)
      if !force, let notBefore = priorRetry?.notBefore, notBefore > now() {
        continue
      }
      let outcome = await request(
        operation: .download,
        consecutiveFailures: priorRetry?.attempts ?? 0,
        expectedAuthenticationEpoch: expectedAuthenticationEpoch
      ) { [api] in
        try await api.listAttachments(
          ownerKind: first.ownerKind.rawValue,
          ownerId: first.ownerId
        )
      }

      let response: AttachmentHTTPResult
      switch outcome {
      case .response(.success, let successfulResponse):
        response = successfulResponse
      case .response(.quarantined(let retryAt), let failedResponse),
        .response(.retryLater(let retryAt), let failedResponse):
        scheduleUnknownTombstoneRetry(
          first,
          priorRetry: priorRetry,
          retryAt: retryAt,
          code: Self.errorCode(from: failedResponse.body) ?? "attachment_list_unavailable"
        )
        continue
      case .transportRetry(let retryAt):
        scheduleUnknownTombstoneRetry(
          first,
          priorRetry: priorRetry,
          retryAt: retryAt,
          code: "transport_unavailable"
        )
        continue
      case .sessionChanged:
        return
      case .response(.authenticationRequired, _):
        return
      case .response(.refreshAuthenticationOnce, _):
        return
      case .response(.forbidden, let failedResponse),
        .response(.notFound, let failedResponse),
        .response(.rejected, let failedResponse):
        // Permanent contract/authz failures stay fail-closed. A later explicit
        // capability or connectivity trigger may re-check them, but no hot
        // automatic loop is created.
        _ = outbox.remove(idempotencyKey: retryKey)
        _ = failedResponse
        continue
      }

      guard let envelope = try? JSONDecoder().decode(
        RemoteAttachmentEnvelope.self,
        from: response.body
      ) else {
        scheduleUnknownTombstoneRetry(
          first,
          priorRetry: priorRetry,
          retryAt: Self.fallbackRetryAt(
            consecutiveFailures: priorRetry?.attempts ?? 0,
            now: now()
          ),
          code: "invalid_attachment_list"
        )
        continue
      }
      for tombstone in tombstones {
        let matches = envelope.attachments.filter {
          guard $0.ownerKind == tombstone.ownerKind.rawValue,
            $0.ownerId == tombstone.ownerId
          else { return false }
          if let contentSHA256 = tombstone.contentSHA256 {
            return $0.sha256 == contentSHA256
          }
          // Legacy tombstones created before the checksum field existed keep
          // the deterministic filename fallback. New tombstones fail closed
          // unless the authenticated list provides the exact digest.
          return $0.fileName == tombstone.uploadFileName
        }
        guard matches.count == 1, UUID(uuidString: matches[0].id) != nil else { continue }
        try? attachments.recordUploadAcknowledgement(
          localId: tombstone.localId,
          serverId: matches[0].id.lowercased(),
          ownerKind: tombstone.ownerKind,
          ownerId: tombstone.ownerId,
          uploadFileName: tombstone.uploadFileName
        )
      }

      let stillUnresolved = attachments.tombstones.values.contains {
        $0.serverId == nil
          && $0.ownerKind == first.ownerKind
          && $0.ownerId == first.ownerId
      }
      if stillUnresolved {
        // A committed POST can become visible to the list endpoint shortly
        // after its response was lost. Persist a bounded poll deadline so the
        // existing app scheduler wakes even with an otherwise empty outbox.
        scheduleUnknownTombstoneRetry(
          first,
          priorRetry: priorRetry,
          retryAt: Self.fallbackRetryAt(
            consecutiveFailures: priorRetry?.attempts ?? 0,
            now: now()
          ),
          code: "attachment_acknowledgement_not_visible"
        )
      } else {
        _ = outbox.remove(idempotencyKey: retryKey)
      }
    }
  }

  private func scheduleUnknownTombstoneRetry(
    _ tombstone: AttachmentTombstone,
    priorRetry: OutboxItem?,
    retryAt: Date,
    code: String
  ) {
    _ = outbox.enqueue(OutboxItem(
      id: priorRetry?.id ?? UUID().uuidString,
      idempotencyKey: Self.reconciliationKey(tombstone),
      // Reuse the established download raw value for rollback compatibility:
      // an older build safely discards this missing-local-id sentinel instead
      // of failing to decode the entire durable outbox on an unknown case.
      kind: .attachmentDownload,
      ownerKind: tombstone.ownerKind.rawValue,
      ownerId: tombstone.ownerId,
      subjectId: tombstone.localId,
      label: tombstone.uploadFileName,
      createdAt: priorRetry?.createdAt ?? now(),
      attempts: (priorRetry?.attempts ?? 0) + 1,
      notBefore: retryAt,
      lastErrorCode: code
    ))
  }

  private static func reconciliationKey(_ tombstone: AttachmentTombstone) -> String {
    let group = Data("\(tombstone.ownerKind.rawValue)\u{1F}\(tombstone.ownerId)".utf8)
    let digest = SHA256.hash(data: group).map { String(format: "%02x", $0) }.joined()
    return "attachment-reconciliation-\(digest)"
  }

  private static func isReconciliationItem(_ item: OutboxItem) -> Bool {
    item.kind == .attachmentDownload
      && item.idempotencyKey.hasPrefix("attachment-reconciliation-")
  }

  private static func fallbackRetryAt(
    consecutiveFailures: Int,
    now: Date
  ) -> Date {
    AttachmentHTTPPolicy.decide(
      status: 503,
      operation: .download,
      consecutiveFailures: consecutiveFailures,
      now: now
    ).retryAt ?? now.addingTimeInterval(30)
  }

  private struct UploadAcknowledgement: Decodable { let id: String }
  private struct ErrorEnvelope: Decodable { let error: String? }
  private struct RemoteAttachmentEnvelope: Decodable {
    let attachments: [TombstoneAttachmentMetadata]
  }
  private struct TombstoneAttachmentMetadata: Decodable {
    let id: String
    let ownerKind: String
    let ownerId: String
    let fileName: String
    let sha256: String?
  }

  private static func uploadedID(from data: Data) -> String? {
    guard let value = try? JSONDecoder().decode(UploadAcknowledgement.self, from: data),
      UUID(uuidString: value.id) != nil
    else { return nil }
    return value.id.lowercased()
  }

  private static func errorCode(from data: Data) -> String? {
    guard data.count <= 4096 else { return nil }
    return (try? JSONDecoder().decode(ErrorEnvelope.self, from: data))?.error
  }

  private static func isByteIdentical(
    _ response: AttachmentHTTPResult,
    to localData: Data,
    expectedLength: Int
  ) -> Bool {
    guard response.body.count == expectedLength,
      response.body.count == localData.count,
      response.contentLength.map({ $0 == response.body.count }) ?? true
    else { return false }
    return SHA256.hash(data: response.body) == SHA256.hash(data: localData)
  }
}

private extension AttachmentHTTPDecision {
  var retryAt: Date? {
    switch self {
    case .quarantined(let retryAt), .retryLater(let retryAt): retryAt
    default: nil
    }
  }
}
