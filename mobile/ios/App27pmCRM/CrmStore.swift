import Foundation
import SwiftUI

// MARK: - Today snapshot (port of app/today-dashboard.ts)

struct TodayFollowUp: Identifiable {
  enum Kind {
    case deal
    case organization
  }

  let id: String
  let kind: Kind
  let title: String
  let organization: String
  let dueDate: Date
  let dealId: String?
  let organizationId: String?
}

struct TodaySnapshot {
  let pendingIntakes: [IntakeSubmission]
  let overdueTasks: [CrmTask]
  let unreadConversations: [Conversation]
  let dueFollowUps: [TodayFollowUp]
  let accountsToPlan: [Organization]
  let atRiskDeals: [Deal]
  let upcomingDeals: [Deal]

  var actionCount: Int {
    pendingIntakes.count
      + overdueTasks.count
      + unreadConversations.count
      + dueFollowUps.count
      + accountsToPlan.count
  }
}

enum AuthenticationReplayError: LocalizedError {
  case sessionAdvanced

  var errorDescription: String? {
    "La session a changé pendant la synchronisation — réessayez."
  }
}

/// Executes one authenticated operation in the logical session that created
/// it. A response from an older login is discarded before refresh, replay or
/// credential mutation, even if another user/session is already live.
@MainActor
enum AuthenticationReplayGate {
  static func run<T>(
    expectedAuthenticationEpoch: UInt64,
    authenticationEpoch: @escaping () -> UInt64,
    sessionIsAuthenticated: @escaping () -> Bool,
    currentAccessToken: () -> String?,
    refreshAuthentication: (_ rejectedAccessToken: String?) async -> Bool,
    purgeAuthentication: (_ rejectedAccessToken: String?) -> Bool,
    operation: () async throws -> T
  ) async throws -> T {
    let verifyExpectedSession: () throws -> Void = {
      guard authenticationEpoch() == expectedAuthenticationEpoch else {
        throw AuthenticationReplayError.sessionAdvanced
      }
      guard sessionIsAuthenticated() else {
        // A failed refresh can synchronously purge DeviceAuth before this owner
        // has transitioned its UI/cache. Preserve `unauthorized` so the owner
        // performs that fail-closed transition; only a changed epoch is stale.
        throw CrmAPIError.unauthorized
      }
    }
    try verifyExpectedSession()
    let firstAccessToken = currentAccessToken()
    do {
      let result = try await operation()
      try verifyExpectedSession()
      return result
    } catch CrmAPIError.unauthorized {
      try verifyExpectedSession()
      let refreshed = await refreshAuthentication(firstAccessToken)
      guard authenticationEpoch() == expectedAuthenticationEpoch else {
        throw AuthenticationReplayError.sessionAdvanced
      }
      guard refreshed else {
        throw CrmAPIError.unauthorized
      }
      try verifyExpectedSession()
      let replayAccessToken = currentAccessToken()
      do {
        let result = try await operation()
        try verifyExpectedSession()
        return result
      } catch CrmAPIError.unauthorized {
        try verifyExpectedSession()
        guard purgeAuthentication(replayAccessToken) else {
          // This replay's 401 belongs to a bearer that another operation has
          // already replaced. Preserve that newer token and stop this request.
          throw AuthenticationReplayError.sessionAdvanced
        }
        throw CrmAPIError.unauthorized
      }
    }
  }
}

// MARK: - Store

/// Observable CRM state. Syncs the live CRM API when the device is
/// authenticated (Authorization Code + PKCE, tokens in the Keychain);
/// otherwise serves the bundled demo dataset as the explicit unauthenticated
/// state. No operator identity is ever fabricated. Nothing ever sends.
@Observable
final class CrmStore {
  typealias DashboardFetchResult = (data: DashboardData, rawJSON: Data)

  let operatorName = "Alexis"

  private(set) var data: DashboardData

  /// Live API vs bundled demo dataset.
  private(set) var mode: DataMode
  private(set) var isSyncing = false
  private(set) var lastSync: Date?
  private(set) var syncError: String?

  /// Drafts composed locally; re-applied after each live refresh so they survive a sync.
  private var pendingDrafts: [String: [CrmMessage]] = [:]

  /// Device authentication (PKCE, tokens in the Keychain).
  let auth: DeviceAuth

  private let apiClient: CrmAPIClient
  private let dashboardFetcher: () async throws -> DashboardFetchResult
  private var attachmentSync: AttachmentSyncCoordinator!
  private var attachmentRetryTask: Task<Void, Never>?
  /// Logical authentication-session identity. Access-token refreshes stay in
  /// the same epoch; logout, invalidation and a fresh sign-in advance it so a
  /// response suspended under an older session can never repopulate UI/cache.
  private var authenticationEpoch: UInt64 = 0

  // MARK: Native capabilities

  /// Persistent queue of operations waiting for the server (uploads,
  /// remote deletes). Drains only once the attachment endpoints of the
  /// server contract are probed and confirmed.
  let outbox: OutboxQueue
  /// Local attachment library (photos, documents) on every support.
  let attachments: AttachmentStore
  /// Operator-entered values for contract fields the server does not
  /// expose yet (contact phones, account addresses).
  let localFields = LocalFieldStore()
  /// Geocoding cache backing the account map and dossier mini-maps.
  let placeIndex = PlaceIndex()
  let network = NetworkMonitor()
  let permissions = PermissionsCenter()
  let reminders = ReminderScheduler()

  private let offlineCache: OfflineCache

  /// Date of the payload currently served when it comes from the offline
  /// cache — shown honestly in the offline banner.
  private(set) var cachedAt: Date?
  /// True only after the server confirmed the attachment endpoints.
  private(set) var serverSupportsAttachments = false
  private(set) var reminderSettings = ReminderSettings.load()

  init(
    data injectedData: DashboardData? = nil,
    auth injectedAuth: DeviceAuth? = nil,
    dashboardFetcher injectedDashboardFetcher: (() async throws -> DashboardFetchResult)? = nil,
    offlineCache injectedOfflineCache: OfflineCache? = nil
  ) {
    let auth = injectedAuth ?? DeviceAuth()
    // Invalid build-time configuration fails closed: local tokens are purged,
    // the device must reconnect, and no authenticated request can be built.
    let configError = CrmAPIConfig.configurationError
    if configError != nil {
      auth.purge()
    }
    let initialMode: DataMode = auth.isAuthenticated ? .live : .demo
    self.data = injectedData
      ?? (initialMode == .live ? DashboardData.emptyLive : DemoData.dashboard())
    self.auth = auth
    let offlineCache = injectedOfflineCache ?? OfflineCache()
    self.offlineCache = offlineCache
    // Live mode only when a device session is restored from the Keychain;
    // otherwise the app starts in the explicit unauthenticated demo state.
    mode = initialMode
    let outbox = OutboxQueue()
    self.outbox = outbox
    attachments = AttachmentStore(outbox: outbox)
    let apiClient = CrmAPIClient(baseURL: CrmAPIConfig.baseURL, accessTokenProvider: { [auth] in
      auth.currentAccessToken()
    })
    self.apiClient = apiClient
    dashboardFetcher = injectedDashboardFetcher ?? {
      try await apiClient.fetchDashboard()
    }
    if let configError {
      syncError = configError
    }
    attachmentSync = AttachmentSyncCoordinator(
      api: apiClient,
      attachments: attachments,
      outbox: outbox,
      authenticationToken: { [auth] in auth.currentAccessToken() },
      authenticationEpoch: { [weak self] in self?.authenticationEpoch ?? UInt64.max },
      refreshAuthentication: { [auth] rejectedAccessToken in
        await auth.refreshTokens(rejectedAccessToken: rejectedAccessToken)
      },
      authenticationRequired: { [weak self, auth] rejectedAccessToken in
        guard auth.purgeIfCurrentAccessToken(rejectedAccessToken) else { return }
        self?.returnToUnauthenticated("Session expirée — reconnectez cet appareil.")
      }
    )
    // Offline first: an authenticated device replays the last known server
    // payload instantly, then refresh() reconciles with the network. The
    // cache only ever holds genuine server payloads.
    if mode == .live, let cached = offlineCache.load(),
      let payload = try? JSONDecoder().decode(DashboardPayloadDTO.self, from: cached.rawJSON)
    {
      self.data = DashboardMapper.map(payload)
      cachedAt = cached.fetchedAt
    }
    network.onBecomeOnline = { [weak self] in
      Task { await self?.syncAttachmentsAfterReconnect() }
    }
    auth.onAuthenticationSucceeded { [weak self] in
      self?.authenticationSessionDidComplete()
    }
  }

  enum DataMode {
    case demo
    case live
  }

  /// Opaque proof that an attachment UI action began in one authenticated
  /// logical session. Callers must revalidate it after every suspension before
  /// exposing or mutating customer attachment state.
  struct AttachmentSessionContext: Hashable, Sendable {
    fileprivate let authenticationEpoch: UInt64
  }

  /// Customer attachment names and bytes stay durable across logout, but are
  /// rendered and actionable only while the device has an authenticated live
  /// session. Demo mode never becomes an alternate local-file browser.
  var canAccessAttachments: Bool {
    guard case .live = mode else { return false }
    return auth.isAuthenticated
  }

  /// Read-only identity for customer-data UI state. Logout and every fresh
  /// login advance it, forcing navigation paths, sheets and value-backed
  /// drafts from the prior session to be destroyed instead of surviving into
  /// the next operator session.
  var uiSessionRevision: UInt64 { authenticationEpoch }

  func isCurrentUISessionRevision(_ revision: UInt64) -> Bool {
    isActiveAuthenticationEpoch(revision)
  }

  func captureAttachmentSessionContext() -> AttachmentSessionContext? {
    guard canAccessAttachments else { return nil }
    return AttachmentSessionContext(authenticationEpoch: authenticationEpoch)
  }

  func isCurrentAttachmentSession(_ context: AttachmentSessionContext) -> Bool {
    isActiveAuthenticationEpoch(context.authenticationEpoch)
  }

  // MARK: Sync

  /// Pulls the live dashboard from the CRM API (live mode only). On an expired
  /// access token the refresh token is rotated once; a failed rotation returns
  /// the app to the explicit unauthenticated state.
  func refresh() async {
    await refresh(expectedAuthenticationEpoch: authenticationEpoch)
  }

  private func refresh(expectedAuthenticationEpoch requestEpoch: UInt64) async {
    guard isActiveAuthenticationEpoch(requestEpoch) else { return }
    isSyncing = true
    defer { isSyncing = false }
    do {
      let result = try await withOneAuthenticationReplay(
        expectedAuthenticationEpoch: requestEpoch
      ) {
        try await dashboardFetcher()
      }
      guard mode == .live,
        auth.isAuthenticated,
        authenticationEpoch == requestEpoch
      else { return }
      data = result.data
      applyPendingDrafts()
      offlineCache.save(rawJSON: result.rawJSON)
      cachedAt = Date()
      lastSync = Date()
      syncError = nil
      await syncCapabilitiesAndReminders(expectedAuthenticationEpoch: requestEpoch)
    } catch CrmAPIError.unauthorized {
      guard mode == .live, authenticationEpoch == requestEpoch else { return }
      returnToUnauthenticated("Session expirée — reconnectez cet appareil.")
    } catch {
      guard mode == .live, authenticationEpoch == requestEpoch else { return }
      syncError = Self.syncMessage(for: error)
    }
  }

  /// Executes one authenticated request, rotates the single-use refresh token
  /// at most once, then replays exactly once. A second 401 is an authentication
  /// boundary, never permission to recurse into another token rotation.
  private func withOneAuthenticationReplay<T>(
    expectedAuthenticationEpoch: UInt64,
    _ operation: () async throws -> T
  ) async throws -> T {
    try await AuthenticationReplayGate.run(
      expectedAuthenticationEpoch: expectedAuthenticationEpoch,
      authenticationEpoch: { [weak self] in
        self?.authenticationEpoch ?? UInt64.max
      },
      sessionIsAuthenticated: { [weak self] in
        self?.canAccessAttachments == true
      },
      currentAccessToken: { [auth] in auth.currentAccessToken() },
      refreshAuthentication: { [auth] rejectedAccessToken in
        await auth.refreshTokens(rejectedAccessToken: rejectedAccessToken)
      },
      purgeAuthentication: { [auth] rejectedAccessToken in
        auth.purgeIfCurrentAccessToken(rejectedAccessToken)
      },
      operation: operation
    )
  }

  private func applyPendingDrafts() {
    for (conversationId, drafts) in pendingDrafts where !drafts.isEmpty {
      guard let index = data.conversations.firstIndex(where: { $0.id == conversationId }) else { continue }
      let existingIds = Set(data.conversations[index].messages.map(\.id))
      let missing = drafts.filter { !existingIds.contains($0.id) }
      guard !missing.isEmpty else { continue }
      data.conversations[index].messages.append(contentsOf: missing)
      if let last = missing.last {
        data.conversations[index].preview = last.body.replacingOccurrences(of: "\n", with: " ")
        data.conversations[index].lastActivity = last.sentAt
      }
    }
  }

  private static func syncMessage(for error: Error) -> String {
    if let localized = error as? LocalizedError, let message = localized.errorDescription {
      return message
    }
    return "Synchronisation CRM impossible — vérifiez la connexion et réessayez."
  }

  /// Optimistic mutation followed by a background re-sync in live mode.
  private func runRemote(_ operation: @escaping (CrmAPIClient) async throws -> Void) {
    let requestEpoch = authenticationEpoch
    guard isActiveAuthenticationEpoch(requestEpoch) else { return }
    Task {
      guard isActiveAuthenticationEpoch(requestEpoch) else { return }
      do {
        try await withOneAuthenticationReplay(
          expectedAuthenticationEpoch: requestEpoch
        ) {
          try await operation(apiClient)
        }
        guard isActiveAuthenticationEpoch(requestEpoch) else { return }
        await refresh(expectedAuthenticationEpoch: requestEpoch)
      } catch CrmAPIError.unauthorized {
        guard case .live = mode, authenticationEpoch == requestEpoch else { return }
        returnToUnauthenticated("Session expirée — reconnectez cet appareil.")
      } catch {
        guard isActiveAuthenticationEpoch(requestEpoch) else { return }
        syncError = Self.syncMessage(for: error)
      }
    }
  }

  // MARK: Device authentication

  /// Opens the system authentication session (Authorization Code + PKCE).
  func signIn() {
    auth.startAuthentication()
  }

  /// Validates the universal link callback — exact host, port, protocol and
  /// state — and completes the device sign-in; anything else is refused.
  func handleCallback(_ url: URL) async {
    _ = await auth.handleCallback(url)
  }

  /// One transition point for both callback delivery mechanisms: app
  /// `onOpenURL` and a callback consumed directly by ASWebAuthenticationSession.
  /// The epoch advances before any refresh can suspend, invalidating work and
  /// UI state from the previous logical session.
  private func authenticationSessionDidComplete() {
    // Every successful authorization-code exchange is a new logical session,
    // including an explicit re-authentication while another session was live.
    authenticationEpoch &+= 1
    mode = .live
    // Never carry the unauthenticated demo dashboard across the live boundary.
    // A genuine cache may be replayed; otherwise the first live frame is empty
    // until refresh returns authoritative server data.
    if let cached = offlineCache.load(),
      let payload = try? JSONDecoder().decode(DashboardPayloadDTO.self, from: cached.rawJSON)
    {
      data = DashboardMapper.map(payload)
      cachedAt = cached.fetchedAt
    } else {
      data = .emptyLive
      cachedAt = nil
    }
    let expectedAuthenticationEpoch = authenticationEpoch
    Task { [weak self] in
      await self?.refresh(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    }
  }

  /// Purges local credentials/UI first, then revokes the captured server
  /// session on a best-effort basis without holding customer data onscreen.
  func signOut() async {
    await auth.signOut(afterLocalPurge: { [weak self] in
      self?.returnToUnauthenticated(authenticationAlreadyPurged: true)
    })
  }

  /// Returns the app to the explicit unauthenticated (demo) state.
  private func returnToUnauthenticated(
    _ message: String? = nil,
    authenticationAlreadyPurged: Bool = false
  ) {
    // A second 401 after the one permitted replay invalidates the local
    // session as well as the UI mode. Keeping rotated tokens here would make
    // the next process launch incorrectly restore a live session.
    if !authenticationAlreadyPurged {
      auth.purge()
    }
    authenticationEpoch &+= 1
    mode = .demo
    data = DemoData.dashboard()
    pendingDrafts = [:]
    lastSync = nil
    isSyncing = false
    syncError = message
    offlineCache.purge()
    cachedAt = nil
    serverSupportsAttachments = false
    attachmentRetryTask?.cancel()
    attachmentRetryTask = nil
    reminders.cancelAll()
  }

  // MARK: Native capabilities

  /// Probes the server contract, then drains the outbox when the attachment
  /// endpoints are live. Until then everything stays queued locally —
  /// nothing is ever sent to an unconfirmed destination.
  private func syncCapabilitiesAndReminders(expectedAuthenticationEpoch: UInt64) async {
    let supportsAttachments = await apiClient.probeAttachmentsSupport()
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
    serverSupportsAttachments = supportsAttachments
    await drainOutboxIfPossibleNow(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
    await rescheduleReminders(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
  }

  /// A new local file is a sync trigger, not merely a future-refresh hint.
  /// Re-probing is safe/read-only and lets an app launched before activation
  /// discover the newly enabled contract without losing its queued upload.
  func attachmentWasAdded() {
    let expectedAuthenticationEpoch = authenticationEpoch
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch), network.isOnline else { return }
    Task {
      guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
      if !serverSupportsAttachments {
        let supportsAttachments = await apiClient.probeAttachmentsSupport()
        guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
        serverSupportsAttachments = supportsAttachments
      }
      await drainOutboxIfPossibleNow(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    }
  }

  func attachmentCollectionState(ownerKind: AttachmentOwnerKind, ownerId: String) -> AttachmentCollectionState {
    attachmentSync.collectionState(ownerKind: ownerKind, ownerId: ownerId)
  }

  func refreshRemoteAttachments(
    ownerKind: AttachmentOwnerKind, ownerId: String, context: AttachmentSessionContext
  ) async {
    guard isCurrentAttachmentSession(context), network.isOnline else { return }
    if !serverSupportsAttachments {
      let supported = await apiClient.probeAttachmentsSupport()
      guard isCurrentAttachmentSession(context) else { return }
      serverSupportsAttachments = supported
    }
    guard serverSupportsAttachments else { return }
    await attachmentSync.refreshRemoteAttachments(
      ownerKind: ownerKind, ownerId: ownerId,
      expectedAuthenticationEpoch: context.authenticationEpoch
    )
    guard isCurrentAttachmentSession(context) else { return }
    scheduleNextAttachmentAttempt(expectedAuthenticationEpoch: context.authenticationEpoch)
  }

  func requestAttachmentDownload(_ attachment: Attachment, context: AttachmentSessionContext) throws {
    guard isCurrentAttachmentSession(context) else { return }
    try attachments.requestRemoteDownload(localId: attachment.id)
    attachmentWasAdded()
  }

  func retryAttachment(_ attachment: Attachment, context: AttachmentSessionContext) throws {
    guard isCurrentAttachmentSession(context) else { return }
    try attachments.retryAttachment(localId: attachment.id)
    attachmentWasAdded()
  }

  func drainOutboxIfPossible() {
    let expectedAuthenticationEpoch = authenticationEpoch
    Task {
      await drainOutboxIfPossibleNow(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
    }
  }

  private func drainOutboxIfPossibleNow(expectedAuthenticationEpoch: UInt64? = nil) async {
    let expectedAuthenticationEpoch = expectedAuthenticationEpoch ?? authenticationEpoch
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
    guard serverSupportsAttachments, network.isOnline else {
      scheduleNextAttachmentAttempt(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
      return
    }
    // Cross-file crash recovery is itself the source of truth for whether
    // work exists. Always run it while the authenticated capability is live:
    // an empty outbox can still need an upload/download rebuilt from the
    // attachment index or a tombstone resolved through the private list API.
    await attachmentSync.reconcileAndDrain(
      expectedAuthenticationEpoch: expectedAuthenticationEpoch
    )
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
    scheduleNextAttachmentAttempt(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
  }

  private func syncAttachmentsAfterReconnect() async {
    let expectedAuthenticationEpoch = authenticationEpoch
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
    // The old capability value may have been observed before activation.
    let supportsAttachments = await apiClient.probeAttachmentsSupport()
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else { return }
    serverSupportsAttachments = supportsAttachments
    await drainOutboxIfPossibleNow(expectedAuthenticationEpoch: expectedAuthenticationEpoch)
  }

  private func scheduleNextAttachmentAttempt(expectedAuthenticationEpoch: UInt64) {
    attachmentRetryTask?.cancel()
    attachmentRetryTask = nil
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch),
      serverSupportsAttachments, network.isOnline,
      let nextAttempt = outbox.nextAttemptAt
    else { return }
    let delay = max(0, nextAttempt.timeIntervalSinceNow)
    attachmentRetryTask = Task { [weak self] in
      do {
        try await Task.sleep(for: .seconds(delay))
      } catch {
        return
      }
      guard !Task.isCancelled else { return }
      await self?.drainOutboxIfPossibleNow(
        expectedAuthenticationEpoch: expectedAuthenticationEpoch
      )
    }
  }

  private func isActiveAuthenticationEpoch(_ expectedAuthenticationEpoch: UInt64) -> Bool {
    guard case .live = mode else { return false }
    return auth.isAuthenticated
      && authenticationEpoch == expectedAuthenticationEpoch
  }

  private func rescheduleReminders(expectedAuthenticationEpoch: UInt64) async {
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else {
      reminders.cancelAll()
      return
    }
    await reminders.sync(
      data: data,
      settings: reminderSettings,
      sessionIsCurrent: { [weak self] in
        self?.isActiveAuthenticationEpoch(expectedAuthenticationEpoch) == true
      }
    )
  }

  func updateReminderSettings(_ settings: ReminderSettings) {
    reminderSettings = settings
    settings.persist()
    let expectedAuthenticationEpoch = authenticationEpoch
    guard isActiveAuthenticationEpoch(expectedAuthenticationEpoch) else {
      reminders.cancelAll()
      return
    }
    Task {
      await rescheduleReminders(
        expectedAuthenticationEpoch: expectedAuthenticationEpoch
      )
    }
  }

  func purgeOfflineCache() {
    offlineCache.purge()
    cachedAt = nil
  }

  // MARK: Server-contract fields

  /// Resolved account address: the server value once deployed, the
  /// operator-entered local value until then.
  func address(for organization: Organization) -> String? {
    if let address = organization.address, !address.trimmed.isEmpty { return address }
    guard canAccessAttachments else { return nil }
    return localFields.address(organizationId: organization.id)
  }

  func city(for organization: Organization) -> String? {
    organization.city
  }

  /// Resolved contact phone: the server value once deployed, the
  /// operator-entered local value until then.
  func phone(for contact: Contact) -> String? {
    if let phone = contact.phone, !phone.trimmed.isEmpty { return phone }
    guard canAccessAttachments else { return nil }
    return localFields.phone(contactId: contact.id)
  }

  // MARK: Derived

  func conversation(_ id: String) -> Conversation? {
    data.conversations.first { $0.id == id }
  }

  func organization(_ id: String) -> Organization? {
    data.organizations.first { $0.id == id }
  }

  func deal(_ id: String) -> Deal? {
    data.deals.first { $0.id == id }
  }

  func contact(id: String) -> Contact? {
    data.contacts.first { $0.id == id }
  }

  func strategy(organizationId: String) -> OutreachStrategy? {
    data.strategies.first { $0.organizationId == organizationId }
  }

  func deals(organizationId: String) -> [Deal] {
    data.deals.filter { $0.organizationId == organizationId }
  }

  func contacts(organizationId: String) -> [Contact] {
    data.contacts.filter { $0.organizationId == organizationId }
  }

  func unreadCount(mailbox address: String) -> Int {
    data.conversations.filter { $0.mailboxAddress == address && $0.unread }.count
  }

  var totalUnreadCount: Int {
    data.conversations.filter { $0.unread }.count
  }

  func todaySnapshot(now: Date = Date()) -> TodaySnapshot {
    let startOfToday = Fmt.startOfDay(for: now)

    let dueDealFollowUps = data.deals
      .filter { deal in
        guard deal.stage != .gagne, let date = deal.nextActionDate else { return false }
        return date <= startOfToday
      }
      .map { deal in
        TodayFollowUp(
          id: "followup-\(deal.id)", kind: .deal, title: deal.nextAction,
          organization: deal.organization, dueDate: deal.nextActionDate ?? now,
          dealId: deal.id, organizationId: nil
        )
      }

    let dueOrgFollowUps = data.organizations
      .filter { organization in
        guard let date = organization.nextFollowUpAt else { return false }
        return date <= startOfToday
      }
      .map { organization in
        TodayFollowUp(
          id: "followup-org-\(organization.id)", kind: .organization,
          title: organization.nextStep ?? "Relever le suivi du compte",
          organization: organization.name, dueDate: organization.nextFollowUpAt ?? now,
          dealId: nil, organizationId: organization.id
        )
      }

    let strategyOrgIds = Set(data.strategies.map { $0.organizationId })
    let accountsToPlan = data.organizations.filter { !strategyOrgIds.contains($0.id) }

    let atRiskDeals = data.deals.filter { deal in
      guard deal.stage != .gagne else { return false }
      if deal.nextAction.trimmed.isEmpty { return true }
      guard let date = deal.nextActionDate else { return true }
      return date < startOfToday
    }

    let upcomingDeals = data.deals
      .filter { deal in
        guard deal.stage != .gagne, let date = deal.nextActionDate else { return false }
        return date > startOfToday
      }
      .sorted { ($0.nextActionDate ?? .distantFuture) < ($1.nextActionDate ?? .distantFuture) }

    return TodaySnapshot(
      pendingIntakes: data.intakes,
      overdueTasks: data.tasks.filter { !$0.completed && ($0.dueDate.map { $0 < startOfToday } ?? false) },
      unreadConversations: data.conversations.filter { $0.unread },
      dueFollowUps: (dueDealFollowUps + dueOrgFollowUps).sorted { $0.dueDate < $1.dueDate },
      accountsToPlan: accountsToPlan,
      atRiskDeals: atRiskDeals,
      upcomingDeals: upcomingDeals
    )
  }

  // MARK: Mutations

  func toggleTask(_ id: String) {
    guard let index = data.tasks.firstIndex(where: { $0.id == id }) else { return }
    data.tasks[index].completed.toggle()
    let completed = data.tasks[index].completed
    runRemote { try await $0.setTask(id, completed: completed) }
  }

  func markRead(_ conversationId: String) {
    setUnread(false, conversationId: conversationId)
  }

  func markUnread(_ conversationId: String) {
    setUnread(true, conversationId: conversationId)
  }

  private func setUnread(_ unread: Bool, conversationId: String) {
    guard let index = data.conversations.firstIndex(where: { $0.id == conversationId }) else { return }
    data.conversations[index].unread = unread
    runRemote { try await $0.setConversation(conversationId, unread: unread) }
  }

  func setStage(_ stage: PipelineStage, dealId: String) {
    guard let index = data.deals.firstIndex(where: { $0.id == dealId }) else { return }
    data.deals[index].stage = stage
    runRemote { try await $0.setDealStage(dealId, stage: stage) }
  }

  func snoozeDeal(_ dealId: String, byDays days: Int = 3, now: Date = Date()) {
    guard let index = data.deals.firstIndex(where: { $0.id == dealId }) else { return }
    let base = data.deals[index].nextActionDate ?? now
    let newDate = Fmt.calendar.date(byAdding: .day, value: days, to: base) ?? base
    data.deals[index].nextActionDate = newDate
    if data.deals[index].nextAction.trimmed.isEmpty {
      data.deals[index].nextAction = "Relance planifiée"
    }
    runRemote { try await $0.snoozeDeal(dealId, until: newDate) }
  }

  /// Appends a local, never-sent draft reply to the conversation.
  func addDraft(conversationId: String, body: String, now: Date = Date()) {
    guard let index = data.conversations.firstIndex(where: { $0.id == conversationId }) else { return }
    let conversation = data.conversations[index]
    let message = CrmMessage(
      id: "m-draft-\(UUID().uuidString.prefix(6))",
      direction: .outbound,
      senderName: "Alexis Boulet",
      senderEmail: conversation.mailboxAddress,
      recipientLabel: conversation.contactName,
      sentAt: now,
      body: body,
      deliveryState: .draft,
      deliveryEvents: []
    )
    data.conversations[index].messages.append(message)
    pendingDrafts[conversationId, default: []].append(message)
    data.conversations[index].preview = body.replacingOccurrences(of: "\n", with: " ")
    data.conversations[index].lastActivity = now
    data.conversations[index].unread = false
  }
}
