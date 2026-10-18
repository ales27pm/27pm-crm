import Foundation
import Network

// MARK: - Offline dashboard cache

/// File-backed cache of the last successful live dashboard payload. An
/// authenticated device replays this cache instantly on startup so the app
/// opens with the last known real data even without network. Only genuine
/// server payloads are cached — the demo dataset is never cached, and
/// signing out purges the file.
struct CachedDashboard: Codable {
  let rawJSON: Data
  let fetchedAt: Date
}

final class OfflineCache {
  private let fileURL: URL

  init(directory: URL? = nil) {
    let base = directory ?? Self.defaultDirectory()
    fileURL = base.appending(path: "offline-dashboard.json")
    try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
  }

  static func defaultDirectory() -> URL {
    FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
      .appending(path: "27pm-offline")
  }

  func save(rawJSON: Data, fetchedAt: Date = Date()) {
    guard let payload = try? JSONEncoder().encode(CachedDashboard(rawJSON: rawJSON, fetchedAt: fetchedAt)) else { return }
    try? payload.write(to: fileURL, options: .atomic)
  }

  func load() -> CachedDashboard? {
    guard let payload = try? Data(contentsOf: fileURL) else { return nil }
    return try? JSONDecoder().decode(CachedDashboard.self, from: payload)
  }

  func purge() {
    try? FileManager.default.removeItem(at: fileURL)
  }
}

// MARK: - Network monitoring

@Observable
final class NetworkMonitor {
  private(set) var isOnline = true
  /// Fired on the main actor when connectivity returns, so the outbox can
  /// resume sending without waiting for the next manual refresh.
  var onBecomeOnline: (() -> Void)?

  private let monitor = NWPathMonitor()

  init() {
    monitor.pathUpdateHandler = { [weak self] path in
      let online = path.status == .satisfied
      Task { @MainActor in
        guard let self else { return }
        let wasOffline = !self.isOnline
        self.isOnline = online
        if online && wasOffline {
          self.onBecomeOnline?()
        }
      }
    }
    monitor.start(queue: DispatchQueue(label: "org.27pm.crm.network"))
  }
}

// MARK: - Operator-entered fields (server contract pending)

/// Values the operator enters locally for fields the server does not expose
/// yet (phone per contact, address per organization). Server-provided values
/// always take precedence once the contract fields are deployed.
struct LocalFieldRecord: Codable, Equatable {
  var contactPhones: [String: String] = [:]
  var organizationAddresses: [String: String] = [:]
}

@Observable
final class LocalFieldStore {
  private(set) var record: LocalFieldRecord
  private let fileURL: URL

  init(directory: URL? = nil) {
    let base = directory ?? OfflineCache.defaultDirectory()
    fileURL = base.appending(path: "local-fields.json")
    if let data = try? Data(contentsOf: fileURL),
      let decoded = try? JSONDecoder().decode(LocalFieldRecord.self, from: data)
    {
      record = decoded
    } else {
      record = LocalFieldRecord()
    }
  }

  func phone(contactId: String) -> String? {
    guard let phone = record.contactPhones[contactId], !phone.trimmed.isEmpty else { return nil }
    return phone
  }

  func address(organizationId: String) -> String? {
    guard let address = record.organizationAddresses[organizationId], !address.trimmed.isEmpty else { return nil }
    return address
  }

  func setPhone(_ phone: String, contactId: String) {
    record.contactPhones[contactId] = phone.trimmed.isEmpty ? nil : phone.trimmed
    persist()
  }

  func setAddress(_ address: String, organizationId: String) {
    record.organizationAddresses[organizationId] = address.trimmed.isEmpty ? nil : address.trimmed
    persist()
  }

  private func persist() {
    guard let data = try? JSONEncoder().encode(record) else { return }
    try? data.write(to: fileURL, options: .atomic)
  }
}

// MARK: - Outbox queue

enum OutboxKind: String, Codable {
  case attachmentUpload
  case attachmentDownload
  case attachmentDelete
}

/// One pending server operation. `idempotencyKey` guarantees that a retried
/// enqueue (double tap, offline retry, relaunch) can never create a duplicate
/// server entry.
struct OutboxItem: Codable, Identifiable, Equatable {
  let id: String
  let idempotencyKey: String
  let kind: OutboxKind
  let ownerKind: String
  let ownerId: String
  /// Local attachment id for uploads, server attachment id for deletes.
  let subjectId: String
  let label: String
  let createdAt: Date
  var attempts: Int = 0
  /// Earliest instant at which this item may be attempted again. Persisting
  /// this value makes Retry-After survive an app restart.
  var notBefore: Date? = nil
  var lastErrorCode: String? = nil
}

enum OutboxDisposition: Equatable {
  case completed
  case deferred(until: Date, code: String?)
  case paused(code: String?)
  /// Persists the current item and aborts this drain. Used when the shared
  /// authentication session is no longer valid, so later items cannot issue
  /// requests with a session that has already been rejected.
  case pausedAndStop(code: String?)
}

/// Persistent queue of operations waiting for the server. Items survive
/// relaunches; an item leaves the queue only after its handler succeeds, so
/// an interrupted drain (airplane mode, killed app) resumes exactly where it
/// stopped — no duplicates, no loss. While the backend has not deployed the
/// attachment endpoints, the queue simply keeps everything locally.
@Observable
final class OutboxQueue {
  private(set) var items: [OutboxItem] = []
  private(set) var isDraining = false

  private let fileURL: URL

  init(directory: URL? = nil) {
    let base = directory ?? OfflineCache.defaultDirectory()
    fileURL = base.appending(path: "outbox.json")
    if let data = try? Data(contentsOf: fileURL),
      let decoded = try? JSONDecoder().decode([OutboxItem].self, from: data)
    {
      items = decoded
    }
  }

  var pendingCount: Int { items.count }

  var nextAttemptAt: Date? {
    items.compactMap(\.notBefore).min()
  }

  /// Appends an item unless its idempotency key is already queued. When a
  /// durable attachment record carries newer retry state, merge it into the
  /// existing queue item so a crash between the two atomic files cannot erase
  /// a scanner-provided Retry-After deadline.
  @discardableResult
  func enqueue(_ item: OutboxItem) -> Bool {
    let previous = items
    if let index = items.firstIndex(where: { $0.idempotencyKey == item.idempotencyKey }) {
      items[index].attempts = max(items[index].attempts, item.attempts)
      if let incoming = item.notBefore {
        items[index].notBefore = max(items[index].notBefore ?? incoming, incoming)
      }
      if let code = item.lastErrorCode {
        items[index].lastErrorCode = code
      }
      guard items != previous else { return true }
    } else {
      items.append(item)
    }
    guard persist() else {
      items = previous
      return false
    }
    return true
  }

  func contains(idempotencyKey: String) -> Bool {
    items.contains { $0.idempotencyKey == idempotencyKey }
  }

  func item(idempotencyKey: String) -> OutboxItem? {
    items.first { $0.idempotencyKey == idempotencyKey }
  }

  /// Explicit operator retry preserves the same operation identity. Never
  /// manufacture a second upload key after an uncertain network outcome.
  @discardableResult
  func retry(idempotencyKey: String) -> Bool {
    guard let index = items.firstIndex(where: { $0.idempotencyKey == idempotencyKey }) else {
      return false
    }
    let previous = items
    items[index].notBefore = nil
    items[index].lastErrorCode = nil
    guard persist() else {
      items = previous
      return false
    }
    return true
  }

  /// Drops queued items without sending — used when a local attachment is
  /// deleted before it ever synced.
  @discardableResult
  func remove(idempotencyKey: String) -> Bool {
    let previous = items
    items.removeAll { $0.idempotencyKey == idempotencyKey }
    guard items != previous else { return true }
    guard persist() else {
      items = previous
      return false
    }
    return true
  }

  @discardableResult
  func removeAll(where isRemoved: (OutboxItem) -> Bool) -> Bool {
    let previous = items
    items.removeAll(where: isRemoved)
    guard items != previous else { return true }
    guard persist() else {
      items = previous
      return false
    }
    return true
  }

  /// Drains eligible items without ever relying on their array position after
  /// an await. A concurrent local deletion can remove the in-flight item; its
  /// late completion will then be a no-op and can never remove the next item.
  /// Future-deferred items are skipped so a quarantined download cannot block
  /// independent uploads or deletes.
  func drain(
    now: () -> Date = Date.init,
    _ handler: (OutboxItem) async -> OutboxDisposition
  ) async {
    guard !isDraining else { return }
    isDraining = true
    defer { isDraining = false }

    var visited = Set<String>()
    while let item = items.first(where: {
      !visited.contains($0.id) && ($0.notBefore == nil || $0.notBefore! <= now())
    }) {
      visited.insert(item.id)
      let disposition = await handler(item)
      guard let index = items.firstIndex(where: { $0.id == item.id }) else {
        // The item was intentionally removed while the request was suspended.
        continue
      }
      let previous = items
      var shouldStop = false
      switch disposition {
      case .completed:
        items.remove(at: index)
      case .deferred(let retryAt, let code):
        items[index].attempts += 1
        items[index].notBefore = retryAt
        items[index].lastErrorCode = code
      case .paused(let code):
        items[index].attempts += 1
        items[index].notBefore = nil
        items[index].lastErrorCode = code
      case .pausedAndStop(let code):
        items[index].attempts += 1
        items[index].notBefore = nil
        items[index].lastErrorCode = code
        shouldStop = true
      }
      if !persist() {
        items = previous
        break
      }
      if shouldStop { break }
    }
  }

  @discardableResult
  private func persist() -> Bool {
    guard let data = try? JSONEncoder().encode(items) else { return false }
    do {
      try data.write(to: fileURL, options: .atomic)
      return true
    } catch {
      return false
    }
  }
}
