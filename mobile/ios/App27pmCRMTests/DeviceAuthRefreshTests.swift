import AuthenticationServices
import Foundation
import Testing
@testable import App27pmCRM

@MainActor
private final class InMemoryDeviceTokenVault {
  private(set) var values: [String: String]
  private(set) var deletedAccounts: [String] = []

  init(accessToken: String? = nil, refreshToken: String? = nil) {
    var values: [String: String] = [:]
    values[DeviceAuth.accessTokenAccount] = accessToken
    values[DeviceAuth.refreshTokenAccount] = refreshToken
    self.values = values
  }

  var persistence: DeviceTokenPersistence {
    DeviceTokenPersistence(
      read: { [weak self] in self?.values[$0] },
      save: { [weak self] value, account in self?.values[account] = value },
      delete: { [weak self] account in
        guard let self else { return true }
        deletedAccounts.append(account)
        values.removeValue(forKey: account)
        return true
      }
    )
  }
}

@MainActor
private final class SuspendedRefreshExchange {
  enum Failure: Error {
    case concurrentRefreshTokenReuse
  }

  private(set) var receivedTokens: [String] = []
  private var firstContinuation: CheckedContinuation<Void, Never>?
  private var firstResponseCompleted = false

  func exchange(_ refreshToken: String) async throws -> DeviceTokenPair {
    receivedTokens.append(refreshToken)
    switch receivedTokens.count {
    case 1:
      await withCheckedContinuation { continuation in
        firstContinuation = continuation
      }
      firstResponseCompleted = true
      return DeviceTokenPair(
        accessToken: "access-rotated-once",
        refreshToken: "refresh-rotated-once"
      )
    case 2 where firstResponseCompleted:
      return DeviceTokenPair(
        accessToken: "access-rotated-twice",
        refreshToken: "refresh-rotated-twice"
      )
    default:
      // Without a global single-flight, a second caller can reuse the first
      // rotating token while request one is suspended. Model the backend's
      // invalid_grant response so the regression would purge the session.
      throw Failure.concurrentRefreshTokenReuse
    }
  }

  func waitUntilFirstRequestStarts() async {
    while receivedTokens.isEmpty {
      await Task.yield()
    }
  }

  func releaseFirstResponse() {
    firstContinuation?.resume()
    firstContinuation = nil
  }
}

@MainActor
private final class ImmediateRefreshExchange {
  private(set) var receivedTokens: [String] = []

  func exchange(_ refreshToken: String) async throws -> DeviceTokenPair {
    receivedTokens.append(refreshToken)
    return DeviceTokenPair(
      accessToken: "access-after-dashboard-401",
      refreshToken: "refresh-after-dashboard-401"
    )
  }
}

@MainActor
private final class UnauthorizedThenUnavailableDashboard {
  private(set) var requestCount = 0

  func fetch() async throws -> CrmStore.DashboardFetchResult {
    requestCount += 1
    if requestCount == 1 {
      throw CrmAPIError.unauthorized
    }
    // Stop after the authenticated replay without entering capability or
    // reminder work; this test is about the shared auth boundary.
    throw CrmAPIError.http(status: 503, code: "test_transport_unavailable")
  }
}

@MainActor
private final class SuspendedSuccessfulDashboard {
  private var continuation: CheckedContinuation<CrmStore.DashboardFetchResult, Never>?

  func fetch() async throws -> CrmStore.DashboardFetchResult {
    await withCheckedContinuation { self.continuation = $0 }
  }

  func waitUntilRequestStarts() async {
    while continuation == nil {
      await Task.yield()
    }
  }

  func resume(with result: CrmStore.DashboardFetchResult) {
    continuation?.resume(returning: result)
    continuation = nil
  }
}

@MainActor
private final class SuspendedLogoutRevocation {
  private(set) var receivedTokens: [String] = []
  private var continuation: CheckedContinuation<Void, Never>?

  func revoke(_ accessToken: String) async {
    receivedTokens.append(accessToken)
    await withCheckedContinuation { self.continuation = $0 }
  }

  func waitUntilRequestStarts() async {
    while continuation == nil {
      await Task.yield()
    }
  }

  func resume() {
    continuation?.resume()
    continuation = nil
  }
}

@MainActor
private final class FixedAuthAnchorProvider: AuthPresentationAnchorProvider {
  override func resolveAnchor() -> ASPresentationAnchor? {
    ASPresentationAnchor()
  }
}

@MainActor
private final class SuspendedAuthorizationExchange {
  private(set) var receivedCodes: [String] = []
  private(set) var receivedVerifiers: [String] = []
  private var continuation: CheckedContinuation<DeviceTokenPair, Never>?

  func exchange(code: String, verifier: String) async throws -> DeviceTokenPair {
    receivedCodes.append(code)
    receivedVerifiers.append(verifier)
    return await withCheckedContinuation { continuation = $0 }
  }

  func waitUntilRequestStarts() async {
    while continuation == nil {
      await Task.yield()
    }
  }

  func resume(with pair: DeviceTokenPair) {
    continuation?.resume(returning: pair)
    continuation = nil
  }
}

/// Models a PATCH-like authenticated mutation whose first response is held
/// until the test replaces session A with session B.
@MainActor
private final class SuspendedUnauthorizedMutation {
  private(set) var accessTokens: [String?] = []
  private var firstContinuation: CheckedContinuation<Void, Never>?

  func perform(accessToken: String?) async throws {
    accessTokens.append(accessToken)
    if accessTokens.count == 1 {
      await withCheckedContinuation { firstContinuation = $0 }
    }
    throw CrmAPIError.unauthorized
  }

  func waitUntilFirstRequestStarts() async {
    while firstContinuation == nil {
      await Task.yield()
    }
  }

  func resumeFirstRequest() {
    firstContinuation?.resume()
    firstContinuation = nil
  }
}

@MainActor
private final class ReplaySessionProbe {
  var epoch: UInt64 = 1
  var isAuthenticated = true
  var accessToken: String? = "access-session-a"
  private(set) var refreshCount = 0
  private(set) var purgeCount = 0

  func refresh(rejectedAccessToken: String?) async -> Bool {
    refreshCount += 1
    return true
  }

  func purge(rejectedAccessToken: String?) -> Bool {
    purgeCount += 1
    return true
  }
}

/// Keeps one attachment request in flight with the old bearer until a
/// dashboard request has completed the rotation. Its delayed 401 then proves
/// that the attachment path reuses the new session instead of rotating again.
@MainActor
private final class DelayedOldBearerAttachmentTransport: AttachmentAPITransport {
  private let accessToken: () -> String?
  private(set) var uploadTokens: [String?] = []
  private var firstUploadContinuation: CheckedContinuation<AttachmentHTTPResult, Never>?

  init(accessToken: @escaping () -> String?) {
    self.accessToken = accessToken
  }

  func uploadAttachment(
    fileData: Data,
    fileName: String,
    mimeType: String,
    ownerKind: String,
    ownerId: String,
    idempotencyKey: String
  ) async throws -> AttachmentHTTPResult {
    uploadTokens.append(accessToken())
    if uploadTokens.count == 1 {
      return await withCheckedContinuation { firstUploadContinuation = $0 }
    }
    return Self.json(200, #"{"id":"72db58dc-8156-45f1-93b5-c7581c224d32"}"#)
  }

  func downloadAttachment(id: String) async throws -> AttachmentHTTPResult {
    Self.json(423, #"{"error":"attachment_quarantined"}"#, retryAfter: "60")
  }

  func deleteAttachment(id: String) async throws -> AttachmentHTTPResult {
    Self.json(204, "")
  }

  func listAttachments(ownerKind: String, ownerId: String) async throws -> AttachmentHTTPResult {
    Self.json(200, #"{"attachments":[]}"#)
  }

  func waitUntilFirstUploadStarts() async {
    while firstUploadContinuation == nil {
      await Task.yield()
    }
  }

  func releaseFirstUploadWithOldBearer401() {
    firstUploadContinuation?.resume(returning: Self.json(
      401,
      #"{"error":"authentication_required"}"#
    ))
    firstUploadContinuation = nil
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

/// Regression proofs for the rotating-token race shared by dashboard and
/// attachment callers. These tests exercise the real DeviceAuth lifecycle,
/// including durable credential replacement and fail-closed purge behavior.
@MainActor
@Suite(.serialized)
struct DeviceAuthRefreshTests {
  @Test func supersededAuthorizationExchangeCannotResurrectOrClearNewAttempt() async {
    let vault = InMemoryDeviceTokenVault()
    let exchange = SuspendedAuthorizationExchange()
    let challengeA = PKCE.Challenge(
      verifier: "verifier-session-a-abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
      challenge: "challenge-session-a",
      state: "state-session-a"
    )
    let challengeB = PKCE.Challenge(
      verifier: "verifier-session-b-abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
      challenge: "challenge-session-b",
      state: "state-session-b"
    )
    var challenges = [challengeA, challengeB]
    let auth = DeviceAuth(
      anchorProvider: FixedAuthAnchorProvider(),
      startSession: { _, _ in true },
      tokenPersistence: vault.persistence,
      challengeFactory: { challenges.removeFirst() },
      authorizationExchange: { try await exchange.exchange(code: $0, verifier: $1) }
    )

    auth.startAuthentication()
    let oldCallback = URL(
      string: "https://crm.27pm.org/mobile/oauth/callback?code=code-a&state=state-session-a"
    )!
    let oldExchange = Task { @MainActor in await auth.handleCallback(oldCallback) }
    await exchange.waitUntilRequestStarts()

    // Logout invalidates A. Starting B before A's token response arrives also
    // proves A cannot clear B's in-progress browser state in its completion.
    auth.purge()
    auth.startAuthentication()
    #expect(auth.isAuthenticating)

    exchange.resume(with: DeviceTokenPair(
      accessToken: "late-access-session-a",
      refreshToken: "late-refresh-session-a"
    ))
    let oldResult = await oldExchange.value

    #expect(!oldResult)
    #expect(vault.values[DeviceAuth.accessTokenAccount] == nil)
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == nil)
    #expect(!auth.isAuthenticated)
    #expect(auth.isAuthenticating, "La tentative B ne doit pas être effacée par A")
    auth.purge()
  }

  @Test func oldPKCEStateCannotEnterExchangeAfterNewAttemptStarts() async {
    let vault = InMemoryDeviceTokenVault()
    let challengeA = PKCE.Challenge(
      verifier: "verifier-session-a-abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
      challenge: "challenge-session-a",
      state: "state-session-a"
    )
    let challengeB = PKCE.Challenge(
      verifier: "verifier-session-b-abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
      challenge: "challenge-session-b",
      state: "state-session-b"
    )
    var challenges = [challengeA, challengeB]
    var exchangeCount = 0
    let auth = DeviceAuth(
      anchorProvider: FixedAuthAnchorProvider(),
      startSession: { _, _ in true },
      tokenPersistence: vault.persistence,
      challengeFactory: { challenges.removeFirst() },
      authorizationExchange: { _, _ in
        exchangeCount += 1
        return DeviceTokenPair(accessToken: "unexpected", refreshToken: "unexpected")
      }
    )

    auth.startAuthentication()
    auth.purge()
    auth.startAuthentication()
    let oldResult = await auth.handleCallback(URL(
      string: "https://crm.27pm.org/mobile/oauth/callback?code=old&state=state-session-a"
    )!)

    #expect(!oldResult)
    #expect(exchangeCount == 0)
    #expect(auth.isAuthenticating)
    #expect(vault.values[DeviceAuth.accessTokenAccount] == nil)
    auth.purge()
  }

  @Test func newAuthorizationWithoutRefreshTokenDeletesPriorCredential() async {
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-session-a",
      refreshToken: "refresh-session-a"
    )
    let challenge = PKCE.Challenge(
      verifier: "verifier-session-b-abcdefghijklmnopqrstuvwxyz0123456789ABCDE",
      challenge: "challenge-session-b",
      state: "state-session-b"
    )
    let auth = DeviceAuth(
      anchorProvider: FixedAuthAnchorProvider(),
      startSession: { _, _ in true },
      tokenPersistence: vault.persistence,
      challengeFactory: { challenge },
      authorizationExchange: { _, _ in
        DeviceTokenPair(accessToken: "access-session-b", refreshToken: nil)
      }
    )

    auth.startAuthentication()
    let result = await auth.handleCallback(URL(
      string: "https://crm.27pm.org/mobile/oauth/callback?code=code-b&state=state-session-b"
    )!)

    #expect(result)
    #expect(auth.isAuthenticated)
    #expect(vault.values[DeviceAuth.accessTokenAccount] == "access-session-b")
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == nil)
  }

  @Test func successfulAuthorizationNotifiesSessionOwnerExactlyOnce() async {
    let vault = InMemoryDeviceTokenVault()
    let challenge = PKCE.Challenge(
      verifier: "verifier-session-owner-abcdefghijklmnopqrstuvwxyz0123456789",
      challenge: "challenge-session-owner",
      state: "state-session-owner"
    )
    let auth = DeviceAuth(
      anchorProvider: FixedAuthAnchorProvider(),
      startSession: { _, _ in true },
      tokenPersistence: vault.persistence,
      challengeFactory: { challenge },
      authorizationExchange: { _, _ in
        DeviceTokenPair(accessToken: "access-session-owner", refreshToken: nil)
      }
    )
    var completionCount = 0
    auth.onAuthenticationSucceeded {
      completionCount += 1
    }

    auth.startAuthentication()
    let callback = URL(
      string: "https://crm.27pm.org/mobile/oauth/callback?code=owner&state=state-session-owner"
    )!
    let firstResult = await auth.handleCallback(callback)
    let duplicateResult = await auth.handleCallback(callback)

    #expect(firstResult)
    #expect(!duplicateResult)
    #expect(completionCount == 1)
  }

  @Test func staleMutation401CannotReplayOrPurgeUnderReplacementSession() async {
    let session = ReplaySessionProbe()
    let mutation = SuspendedUnauthorizedMutation()

    let caller = Task { @MainActor in
      do {
        try await AuthenticationReplayGate.run(
          expectedAuthenticationEpoch: 1,
          authenticationEpoch: { session.epoch },
          sessionIsAuthenticated: { session.isAuthenticated },
          currentAccessToken: { session.accessToken },
          refreshAuthentication: { await session.refresh(rejectedAccessToken: $0) },
          purgeAuthentication: { session.purge(rejectedAccessToken: $0) },
          operation: {
            try await mutation.perform(accessToken: session.accessToken)
          }
        )
        Issue.record("La mutation suspendue devait être abandonnée avec la session A")
      } catch AuthenticationReplayError.sessionAdvanced {
        // Expected: A's delayed response is discarded before refresh/replay.
      } catch {
        Issue.record("Erreur inattendue: \(error)")
      }
    }
    await mutation.waitUntilFirstRequestStarts()

    // Logout advances the epoch; a replacement authenticated session B may be
    // live before A's delayed 401 arrives. B's bearer must remain untouched.
    session.epoch = 2
    session.accessToken = "access-session-b"
    session.isAuthenticated = true
    mutation.resumeFirstRequest()
    await caller.value

    #expect(mutation.accessTokens == ["access-session-a"])
    #expect(session.refreshCount == 0)
    #expect(session.purgeCount == 0)
    #expect(session.accessToken == "access-session-b")
  }

  @Test func dashboardAndAttachmentCallersShareOneRotationAndNextUsesNewToken() async {
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-original",
      refreshToken: "refresh-original"
    )
    let exchange = SuspendedRefreshExchange()
    let auth = DeviceAuth(
      tokenPersistence: vault.persistence,
      refreshExchange: { try await exchange.exchange($0) }
    )
    let dashboard = UnauthorizedThenUnavailableDashboard()
    let store = CrmStore(
      auth: auth,
      dashboardFetcher: { try await dashboard.fetch() }
    )

    let dashboardCaller = Task { @MainActor in await store.refresh() }
    await exchange.waitUntilFirstRequestStarts()
    let attachmentCaller = Task { @MainActor in
      await auth.refreshTokens(rejectedAccessToken: "access-original")
    }
    // Give the second caller deterministic opportunities to join the shared
    // suspended task before the transport is released.
    for _ in 0..<20 { await Task.yield() }
    #expect(exchange.receivedTokens == ["refresh-original"])

    exchange.releaseFirstResponse()
    await dashboardCaller.value
    let attachmentResult = await attachmentCaller.value
    #expect(attachmentResult)
    #expect(dashboard.requestCount == 2)
    #expect(exchange.receivedTokens == ["refresh-original"])
    #expect(vault.values[DeviceAuth.accessTokenAccount] == "access-rotated-once")
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == "refresh-rotated-once")
    #expect(auth.isAuthenticated)

    // A second 401 for the same old bearer can arrive after the shared task
    // has been cleared. It reuses the rotated session without another token
    // exchange.
    let staleResult = await auth.refreshTokens(rejectedAccessToken: "access-original")
    #expect(staleResult)
    #expect(exchange.receivedTokens == ["refresh-original"])

    // A genuinely later 401 for the current bearer rotates once more and must
    // consume the newly issued refresh token.
    let laterResult = await auth.refreshTokens(
      rejectedAccessToken: "access-rotated-once"
    )
    #expect(laterResult)
    #expect(exchange.receivedTokens == ["refresh-original", "refresh-rotated-once"])
    #expect(vault.values[DeviceAuth.accessTokenAccount] == "access-rotated-twice")
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == "refresh-rotated-twice")
  }

  @Test func purgeDuringSuspendedRotationCannotResurrectLateCredentials() async {
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-original",
      refreshToken: "refresh-original"
    )
    let exchange = SuspendedRefreshExchange()
    let auth = DeviceAuth(
      tokenPersistence: vault.persistence,
      refreshExchange: { try await exchange.exchange($0) }
    )

    let caller = Task { @MainActor in
      await auth.refreshTokens(rejectedAccessToken: "access-original")
    }
    await exchange.waitUntilFirstRequestStarts()
    auth.purge()
    exchange.releaseFirstResponse()

    let result = await caller.value
    #expect(!result)
    #expect(vault.values[DeviceAuth.accessTokenAccount] == nil)
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == nil)
    #expect(!auth.isAuthenticated)
  }

  @Test func dashboardSecond401RequiresAuthenticationWithoutRecursiveRefresh() async {
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-original",
      refreshToken: "refresh-original"
    )
    let exchange = ImmediateRefreshExchange()
    let auth = DeviceAuth(
      tokenPersistence: vault.persistence,
      refreshExchange: { try await exchange.exchange($0) }
    )
    var dashboardRequestCount = 0
    let store = CrmStore(
      auth: auth,
      dashboardFetcher: {
        dashboardRequestCount += 1
        throw CrmAPIError.unauthorized
      }
    )

    await store.refresh()

    #expect(dashboardRequestCount == 2, "requête initiale + un seul replay")
    #expect(exchange.receivedTokens == ["refresh-original"])
    switch store.mode {
    case .demo:
      break
    case .live:
      Issue.record("Un second 401 doit exiger une nouvelle authentification")
    }
    #expect(!auth.isAuthenticated)
    #expect(vault.values[DeviceAuth.accessTokenAccount] == nil)
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == nil)
    #expect(store.syncError == "Session expirée — reconnectez cet appareil.")
  }

  @Test func failedRefreshPurgeTransitionsStoreOutOfLiveMode() async {
    enum RefreshFailure: Error { case rejected }
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-original",
      refreshToken: "refresh-original"
    )
    let auth = DeviceAuth(
      tokenPersistence: vault.persistence,
      refreshExchange: { _ in throw RefreshFailure.rejected }
    )
    let store = CrmStore(
      auth: auth,
      dashboardFetcher: { throw CrmAPIError.unauthorized }
    )

    await store.refresh()

    switch store.mode {
    case .demo:
      break
    case .live:
      Issue.record("Un rafraîchissement refusé ne doit pas laisser les données en mode live")
    }
    #expect(!auth.isAuthenticated)
    #expect(vault.values[DeviceAuth.accessTokenAccount] == nil)
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == nil)
    #expect(store.syncError == "Session expirée — reconnectez cet appareil.")
  }

  @Test func delayedAttachment401ForOldBearerReusesDashboardRotation() async throws {
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-original",
      refreshToken: "refresh-original"
    )
    let exchange = ImmediateRefreshExchange()
    let auth = DeviceAuth(
      tokenPersistence: vault.persistence,
      refreshExchange: { try await exchange.exchange($0) }
    )
    let dashboard = UnauthorizedThenUnavailableDashboard()
    let crm = CrmStore(
      auth: auth,
      dashboardFetcher: { try await dashboard.fetch() }
    )

    let root = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: root) }
    let outbox = OutboxQueue(directory: root)
    let attachments = AttachmentStore(
      directory: root.appending(path: "attachments"),
      outbox: outbox
    )
    _ = try attachments.addPhoto(
      Data([0xFF, 0xD8, 0xFF, 0xE0]),
      ownerKind: .account,
      ownerId: "org-refresh-race"
    )
    let transport = DelayedOldBearerAttachmentTransport(
      accessToken: { auth.currentAccessToken() }
    )
    var authenticationRequiredCount = 0
    let coordinator = AttachmentSyncCoordinator(
      api: transport,
      attachments: attachments,
      outbox: outbox,
      authenticationToken: { auth.currentAccessToken() },
      refreshAuthentication: {
        await auth.refreshTokens(rejectedAccessToken: $0)
      },
      authenticationRequired: { rejectedAccessToken in
        if auth.purgeIfCurrentAccessToken(rejectedAccessToken) {
          authenticationRequiredCount += 1
        }
      }
    )

    let attachmentOperation = Task { @MainActor in
      await coordinator.reconcileAndDrain()
    }
    await transport.waitUntilFirstUploadStarts()
    #expect(transport.uploadTokens == ["access-original"])

    // Dashboard gets the first 401 and completes the only global rotation.
    await crm.refresh()
    #expect(dashboard.requestCount == 2, "dashboard initial request + one replay")
    #expect(exchange.receivedTokens == ["refresh-original"])
    #expect(auth.currentAccessToken() == "access-after-dashboard-401")

    // The attachment's old-bearer 401 arrives afterward. It may replay once,
    // but must not consume the newly issued refresh token.
    transport.releaseFirstUploadWithOldBearer401()
    await attachmentOperation.value

    #expect(transport.uploadTokens == [
      "access-original",
      "access-after-dashboard-401",
    ])
    #expect(exchange.receivedTokens == ["refresh-original"])
    #expect(authenticationRequiredCount == 0)
    #expect(auth.isAuthenticated)
  }

  @Test func lateDashboardSuccessCannotRestoreCustomerDataAfterLogout() async {
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-original",
      refreshToken: "refresh-original"
    )
    let dashboard = SuspendedSuccessfulDashboard()
    let revocation = SuspendedLogoutRevocation()
    let auth = DeviceAuth(
      tokenPersistence: vault.persistence,
      logoutRevocation: { await revocation.revoke($0) }
    )
    let store = CrmStore(
      auth: auth,
      dashboardFetcher: { try await dashboard.fetch() }
    )

    let refresh = Task { @MainActor in await store.refresh() }
    await dashboard.waitUntilRequestStarts()

    let signOut = Task { @MainActor in await store.signOut() }
    await revocation.waitUntilRequestStarts()

    // Local credentials, customer UI and cache state must be cleared before
    // best-effort revocation is allowed to suspend.
    #expect(revocation.receivedTokens == ["access-original"])
    #expect(!auth.isAuthenticated)
    #expect(vault.values[DeviceAuth.accessTokenAccount] == nil)
    #expect(vault.values[DeviceAuth.refreshTokenAccount] == nil)
    switch store.mode {
    case .demo:
      break
    case .live:
      Issue.record("La déconnexion locale doit précéder la révocation distante")
    }
    let signedOutOrganizationIDs = store.data.organizations.map(\.id)
    #expect(store.lastSync == nil)
    #expect(store.cachedAt == nil)

    var lateData = DemoData.dashboard()
    lateData.organizations = []
    dashboard.resume(with: (
      data: lateData,
      rawJSON: Data(#"{"late":"dashboard"}"#.utf8)
    ))
    await refresh.value

    #expect(store.data.organizations.map(\.id) == signedOutOrganizationIDs)
    #expect(store.lastSync == nil)
    #expect(store.cachedAt == nil)
    switch store.mode {
    case .demo:
      break
    case .live:
      Issue.record("Une réponse tardive ne doit pas restaurer la session")
    }

    revocation.resume()
    await signOut.value
  }

  @Test func attachmentUIContextInvalidatesBeforeLogoutRevocationCompletes() async {
    let vault = InMemoryDeviceTokenVault(
      accessToken: "access-original",
      refreshToken: "refresh-original"
    )
    let revocation = SuspendedLogoutRevocation()
    let auth = DeviceAuth(
      tokenPersistence: vault.persistence,
      logoutRevocation: { await revocation.revoke($0) }
    )
    let store = CrmStore(auth: auth)

    let context = store.captureAttachmentSessionContext()
    let sessionRevision = store.uiSessionRevision
    #expect(store.canAccessAttachments)
    #expect(context != nil)
    if let context {
      #expect(store.isCurrentAttachmentSession(context))
    }

    let signOut = Task { @MainActor in await store.signOut() }
    await revocation.waitUntilRequestStarts()

    // Local purge happens before the best-effort network revocation. Picker,
    // camera and importer callbacks therefore lose authority immediately,
    // while their durable files/queue remain untouched on disk.
    #expect(!store.canAccessAttachments)
    #expect(store.uiSessionRevision != sessionRevision)
    #expect(!store.isCurrentUISessionRevision(sessionRevision))
    if let context {
      #expect(!store.isCurrentAttachmentSession(context))
    }

    revocation.resume()
    await signOut.value
  }
}
