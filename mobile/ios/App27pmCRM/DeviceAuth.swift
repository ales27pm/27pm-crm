import AuthenticationServices
import CryptoKit
import Foundation
import Security
import UIKit

/// Token and logout requests are direct calls to the canonical CRM origin.
/// Refusing redirects prevents an authorization code, refresh token or bearer
/// from being replayed to a different URL by URLSession.
nonisolated private final class DeviceAuthRedirectDelegate: NSObject, URLSessionTaskDelegate {
  nonisolated func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

// MARK: - PKCE (RFC 7636)

/// Generates the PKCE material for the device authorization flow. The verifier
/// and state are created on the device and kept only on the device; only the
/// S256 challenge and the state travel in the public authorization request.
nonisolated enum PKCE {
  struct Challenge: Equatable, Sendable {
    let verifier: String
    let challenge: String
    let state: String
  }

  /// 64 random bytes → 86-character base64url verifier (RFC 7636 allows 43–128)
  /// plus a 128-bit random state.
  static func generate() -> Challenge {
    let verifier = base64URLEncode(randomData(count: 64))
    return Challenge(
      verifier: verifier,
      challenge: sha256Base64URL(verifier),
      state: base64URLEncode(randomData(count: 16))
    )
  }

  static func sha256Base64URL(_ value: String) -> String {
    base64URLEncode(Data(SHA256.hash(data: Data(value.utf8))))
  }

  static func base64URLEncode<D: DataProtocol>(_ data: D) -> String {
    Data(data).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private static func randomData(count: Int) -> Data {
    var bytes = [UInt8](repeating: 0, count: count)
    _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
    return Data(bytes)
  }
}

// MARK: - Keychain storage

/// Keychain-only storage for the device tokens. Values never touch
/// UserDefaults, logs, URLs or build-time configuration.
nonisolated enum KeychainStore {
  private static let service = "org.27pm.crm.mobile"
  private static let accessible = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

  static func save(_ value: String, account: String) {
    let data = Data(value.utf8)
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let update: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: accessible,
    ]
    if SecItemUpdate(query as CFDictionary, update as CFDictionary) == errSecItemNotFound {
      var add = query
      update.forEach { add[$0.key] = $0.value }
      SecItemAdd(add as CFDictionary, nil)
    }
  }

  static func read(account: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var result: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess,
          let data = result as? Data,
          let value = String(data: data, encoding: .utf8)
    else { return nil }
    return value
  }

  @discardableResult
  static func delete(account: String) -> Bool {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
    let status = SecItemDelete(query as CFDictionary)
    return status == errSecSuccess || status == errSecItemNotFound
  }
}

// MARK: - Errors

enum DeviceAuthError: LocalizedError {
  case invalidResponse
  case configurationRefused
  case http(status: Int, code: String)

  var errorDescription: String? {
    switch self {
    case .invalidResponse:
      "La réponse du serveur d'authentification est invalide."
    case .configurationRefused:
      CrmAPIConfig.configurationError ?? "Configuration réseau invalide — connexion refusée sur cet appareil."
    case .http(_, let code):
      switch code {
      case "invalid_grant":
        "Code d'autorisation refusé — expiré ou déjà utilisé. Relancez la connexion."
      case "invalid_client":
        "Client mobile non reconnu par le serveur d'authentification."
      default:
        "Connexion refusée par le serveur d'authentification (\(code))."
      }
    }
  }
}

private struct AuthErrorBody: Decodable {
  let error: String
}

/// Injectable credential boundary used by the app's Keychain-backed session
/// and by deterministic token-lifecycle tests. All access stays on the
/// `DeviceAuth` main-actor boundary; credentials are never copied into
/// UserDefaults or logs.
struct DeviceTokenPersistence {
  let read: (_ account: String) -> String?
  let save: (_ value: String, _ account: String) -> Void
  let delete: (_ account: String) -> Bool

  nonisolated static let keychain = DeviceTokenPersistence(
    read: { KeychainStore.read(account: $0) },
    save: { KeychainStore.save($0, account: $1) },
    delete: { KeychainStore.delete(account: $0) }
  )
}

struct DeviceTokenPair: Equatable {
  let accessToken: String
  let refreshToken: String?
}

// MARK: - Device authentication

/// Device sign-in: OAuth 2.0 Authorization Code with PKCE, opened in a system
/// authentication session. The single-use authorization code returns through
/// the exact universal link `https://crm.27pm.org/mobile/oauth/callback` —
/// no private URL scheme and no other host, port or protocol is accepted.
/// Tokens live only in the Keychain.
@Observable
@MainActor
final class DeviceAuth {
  nonisolated static let accessTokenAccount = "accessToken"
  nonisolated static let refreshTokenAccount = "refreshToken"

  /// Generic, actionable, retryable start failure — never carries a URL,
  /// OAuth code, token, PKCE material, state, identifier or raw error text.
  static let startFailureMessage = "Impossible d'ouvrir la session d'authentification système — réessayez."

  private(set) var isAuthenticated: Bool
  private(set) var isAuthenticating = false
  private(set) var authError: String?

  /// PKCE verifier and state of the flow in progress — memory only, never persisted.
  private var pending: PKCE.Challenge?
  private var webSession: ASWebAuthenticationSession?
  /// Identifies the system browser attempt whose completion may mutate the
  /// current PKCE state. A cancelled attempt can never clear a newer one.
  private var authenticationAttemptID: UUID?
  /// Kept alive for the session's weak reference; owns anchor resolution.
  private let anchorProvider: AuthPresentationAnchorProvider
  /// Starts the system session. Injectable so tests can prove the reset
  /// contract without presenting anything; the app uses `start()` itself.
  private let beginSession: (ASWebAuthenticationSession, ASPresentationAnchor) -> Bool
  private let tokenPersistence: DeviceTokenPersistence
  private let challengeFactory: () -> PKCE.Challenge
  /// Deterministic authorization-code exchange used by lifecycle tests. The
  /// production path remains the canonical `/api/mobile/token` request.
  private let authorizationExchange: ((_ code: String, _ verifier: String) async throws -> DeviceTokenPair)?
  /// Optional deterministic refresh transport used by focused tests. The app
  /// keeps using the reviewed `/api/mobile/token` request path.
  private let refreshExchange: ((_ refreshToken: String) async throws -> DeviceTokenPair)?
  /// Optional best-effort revocation transport used by focused tests. Local
  /// credentials are always purged before this boundary is awaited.
  private let logoutRevocation: ((_ accessToken: String) async -> Void)?
  /// Store-level completion hook. `ASWebAuthenticationSession` can consume the
  /// universal link without also delivering an app `onOpenURL` event, so the
  /// token owner must explicitly advance the CRM session/UI after a successful
  /// exchange. Kept weak at the registration site to avoid an ownership cycle.
  private var authenticationSucceeded: (@MainActor () -> Void)?
  /// A refresh token is rotating and single-use. MainActor isolation alone is
  /// not enough because actor methods are re-entrant across `await`; every
  /// dashboard and attachment caller must await this same operation.
  private var refreshTask: Task<Bool, Never>?
  private var refreshTaskID: UUID?
  /// Invalidates a late refresh response after sign-out/purge or a newer token
  /// installation, so stale network completion can never resurrect a session.
  private var tokenGeneration: UInt64 = 0
  private static let directSession: URLSession = {
    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 20
    configuration.httpShouldSetCookies = false
    return URLSession(
      configuration: configuration,
      delegate: DeviceAuthRedirectDelegate(),
      delegateQueue: nil
    )
  }()

  init(
    anchorProvider: AuthPresentationAnchorProvider = AuthPresentationAnchorProvider(),
    startSession: ((ASWebAuthenticationSession, ASPresentationAnchor) -> Bool)? = nil,
    tokenPersistence: DeviceTokenPersistence = .keychain,
    challengeFactory: @escaping () -> PKCE.Challenge = PKCE.generate,
    authorizationExchange: ((_ code: String, _ verifier: String) async throws -> DeviceTokenPair)? = nil,
    refreshExchange: ((_ refreshToken: String) async throws -> DeviceTokenPair)? = nil,
    logoutRevocation: ((_ accessToken: String) async -> Void)? = nil
  ) {
    self.anchorProvider = anchorProvider
    self.beginSession = startSession ?? { session, _ in session.start() }
    self.tokenPersistence = tokenPersistence
    self.challengeFactory = challengeFactory
    self.authorizationExchange = authorizationExchange
    self.refreshExchange = refreshExchange
    self.logoutRevocation = logoutRevocation
    isAuthenticated = tokenPersistence.read(Self.accessTokenAccount) != nil
  }

  /// Current bearer token, read from the Keychain at request time.
  func currentAccessToken() -> String? {
    tokenPersistence.read(Self.accessTokenAccount)
  }

  func onAuthenticationSucceeded(
    _ handler: @escaping @MainActor () -> Void
  ) {
    authenticationSucceeded = handler
  }

  // MARK: Sign-in flow

  /// Opens a system authentication session against the backend's authorize
  /// endpoint with S256 challenge and a fresh random state.
  func startAuthentication() {
    authDiag(.tapReceived)
    guard !isAuthenticating else {
      NSLog("[DeviceAuth] Connexion ignorée — une session est déjà en cours.")
      return
    }
    authError = nil
    let challenge = challengeFactory()
    guard let authorizeURL = makeAuthorizeURL(for: challenge) else {
      authError = CrmAPIConfig.configurationError ?? "Impossible de préparer la demande d'autorisation."
      authDiag(.errorCategory, failure: .configuration)
      return
    }
    // The legacy `callbackURLScheme:` initializer cannot match an https
    // universal-link redirect — the session never received the code and the
    // flow dead-ended. The iOS 17.4+ callback API makes the session itself
    // intercept the exact https redirect (via the webcredentials association)
    // and deliver the callback URL to the completion handler.
    guard let redirect = URLComponents(string: CrmAPIConfig.redirectURI),
          let callbackHost = redirect.host, !redirect.path.isEmpty
    else {
      authError = CrmAPIConfig.configurationError ?? "Configuration réseau invalide — connexion refusée sur cet appareil."
      authDiag(.errorCategory, failure: .configuration)
      return
    }
    // Never start the system session without a real window: an empty anchor
    // lets start() succeed while nothing is ever presented and every later
    // tap is silently swallowed by the in-flight guard (the TestFlight build
    // 1 failure). The anchor is resolved — and kept — before the session
    // exists, so it can never be empty.
    guard let anchor = anchorProvider.resolveAnchor() else {
      authDiag(.anchorMissing)
      NSLog("[DeviceAuth] Ancre de présentation indisponible — session non démarrée.")
      abandonStart()
      return
    }
    anchorProvider.prepare(anchor: anchor)
    let attemptID = UUID()
    pending = challenge
    authenticationAttemptID = attemptID
    isAuthenticating = true
    let session = ASWebAuthenticationSession(
      url: authorizeURL,
      callback: .https(host: callbackHost, path: redirect.path)
    ) { [weak self] callbackURL, error in
      Task { @MainActor [weak self] in
        self?.webSessionDidFinish(
          callbackURL: callbackURL,
          error: error,
          attemptID: attemptID
        )
      }
    }
    session.presentationContextProvider = anchorProvider
    session.prefersEphemeralWebBrowserSession = true
    webSession = session
    let started = beginSession(session, anchor)
    // Diagnostic only — never logs the authorize URL (state/challenge) or any credential.
    NSLog("[DeviceAuth] Session d'authentification — start() → \(started)")
    authDiag(started ? .startTrue : .startFalse)
    guard started else {
      abandonStart()
      return
    }
  }

  /// Resets a start that never became a visible session — no window or
  /// `start()` false — so the very next tap retries from a clean slate with a
  /// generic, retryable error.
  private func abandonStart() {
    webSession = nil
    pending = nil
    authenticationAttemptID = nil
    isAuthenticating = false
    authError = Self.startFailureMessage
  }

  private func makeAuthorizeURL(for challenge: PKCE.Challenge) -> URL? {
    guard let authorizeURL = CrmAPIConfig.authorizeURL,
          var components = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)
    else { return nil }
    components.queryItems = [
      URLQueryItem(name: "response_type", value: "code"),
      URLQueryItem(name: "client_id", value: CrmAPIConfig.clientId),
      URLQueryItem(name: "redirect_uri", value: CrmAPIConfig.redirectURI),
      URLQueryItem(name: "code_challenge", value: challenge.challenge),
      URLQueryItem(name: "code_challenge_method", value: "S256"),
      URLQueryItem(name: "state", value: challenge.state),
    ]
    return components.url
  }

  private func webSessionDidFinish(
    callbackURL: URL?,
    error: Error?,
    attemptID: UUID
  ) {
    guard authenticationAttemptID == attemptID else { return }
    authenticationAttemptID = nil
    webSession = nil
    // Diagnostic only — booleans; never the callback URL itself (it carries the code).
    NSLog("[DeviceAuth] Session terminée — callback: \(callbackURL != nil ? "reçu" : "absent"), erreur: \(error != nil ? "oui" : "non")")
    if let callbackURL {
      authDiag(.completionCallback)
      // The session intercepted the https redirect and hands over the exact
      // callback URL; strict validation (scheme, host, path, state, code) and
      // the PKCE code exchange happen in handleCallback.
      Task { _ = await handleCallback(callbackURL) }
      return
    }
    // User cancellation: clear the progress indicator but keep the pending
    // challenge in case the link lands immediately after the handoff.
    if let error {
      if (error as? ASWebAuthenticationSessionError)?.code == .canceledLogin {
        authDiag(.cancelled)
      } else {
        authDiag(.errorCategory, failure: .session)
      }
      isAuthenticating = false
    }
  }

  /// Validates the universal link callback — exact scheme, host, port, path and
  /// the state generated for this device — before exchanging the code. Any
  /// other URL is refused without touching tokens.
  @discardableResult
  func handleCallback(_ url: URL) async -> Bool {
    guard let challenge = pending else {
      authDiag(.errorCategory, failure: .callbackRejected)
      return false
    }
    guard Self.isValidCallback(url, expectedState: challenge.state) else {
      authDiag(.errorCategory, failure: .callbackRejected)
      return false
    }
    guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
          let code = components.queryItems?.first(where: { $0.name == "code" })?.value
    else {
      authDiag(.errorCategory, failure: .callbackRejected)
      return false
    }
    // A universal-link delivery can win the race with the system session's
    // completion callback. Invalidate/cancel that exact browser attempt before
    // suspending for the token exchange; its eventual callback is then inert.
    let completedWebSession = webSession
    webSession = nil
    authenticationAttemptID = nil
    completedWebSession?.cancel()
    pending = nil
    let expectedGeneration = tokenGeneration
    isAuthenticating = true
    do {
      guard let installedGeneration = try await exchangeCode(
        code,
        verifier: challenge.verifier,
        expectedGeneration: expectedGeneration
      ) else { return false }
      // `purge()` or a newer successful login can interleave after the awaited
      // exchange returns. Only the generation installed above may publish UI
      // success or clear the progress state.
      guard tokenGeneration == installedGeneration, isAuthenticated else { return false }
      isAuthenticating = false
      authError = nil
      authDiag(.callbackSuccess)
      // Synchronous on MainActor by design: the store advances its logical
      // session epoch before this actor can admit any old response completion.
      authenticationSucceeded?()
      return true
    } catch {
      guard tokenGeneration == expectedGeneration else { return false }
      isAuthenticating = false
      // Tokens are stored only after a fully successful exchange.
      authError = Self.message(for: error)
      authDiag(.errorCategory, failure: .network)
      return false
    }
  }

  /// Strict callback validation: the URL must be the exact redirect URI
  /// (https, crm.27pm.org, default port, /mobile/oauth/callback) and carry the
  /// expected state plus a non-empty code.
  nonisolated static func isValidCallback(_ url: URL, expectedState: String) -> Bool {
    guard let expected = URLComponents(string: CrmAPIConfig.redirectURI),
          let candidate = URLComponents(url: url, resolvingAgainstBaseURL: false)
    else { return false }
    guard url.isFileURL == false,
          candidate.scheme == expected.scheme,
          candidate.host == expected.host,
          candidate.port == expected.port,
          candidate.path == expected.path,
          candidate.user == nil,
          candidate.password == nil,
          candidate.fragment == nil
    else { return false }
    guard let state = candidate.queryItems?.first(where: { $0.name == "state" })?.value,
          state == expectedState
    else { return false }
    guard let code = candidate.queryItems?.first(where: { $0.name == "code" })?.value,
          !code.isEmpty
    else { return false }
    return true
  }

  // MARK: Token lifecycle

  private struct TokenRequestBody: Encodable {
    let grantType: String
    let clientId: String
    let redirectUri: String?
    let code: String?
    let codeVerifier: String?
    let refreshToken: String?
  }

  private struct TokenResponse: Decodable {
    let accessToken: String
    let refreshToken: String?
  }

  /// POST /api/mobile/token with the backend's JSON contract. Fails closed
  /// before building any request when the configuration is invalid.
  private func requestTokens(_ body: TokenRequestBody) async throws -> TokenResponse {
    guard let tokenURL = CrmAPIConfig.tokenURL else {
      throw DeviceAuthError.configurationRefused
    }
    var request = URLRequest(url: tokenURL)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.httpBody = try JSONEncoder().encode(body)
    let (data, response) = try await Self.directSession.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw DeviceAuthError.invalidResponse
    }
    guard http.url == tokenURL else {
      throw DeviceAuthError.invalidResponse
    }
    guard (200..<300).contains(http.statusCode) else {
      let code = (try? JSONDecoder().decode(AuthErrorBody.self, from: data).error)
        ?? "http_\(http.statusCode)"
      throw DeviceAuthError.http(status: http.statusCode, code: code)
    }
    do {
      return try JSONDecoder().decode(TokenResponse.self, from: data)
    } catch {
      throw DeviceAuthError.invalidResponse
    }
  }

  /// Exchanges the single-use authorization code with the PKCE verifier.
  private func exchangeCode(
    _ code: String,
    verifier: String,
    expectedGeneration: UInt64
  ) async throws -> UInt64? {
    let pair: DeviceTokenPair
    if let authorizationExchange {
      pair = try await authorizationExchange(code, verifier)
    } else {
      let response = try await requestTokens(TokenRequestBody(
        grantType: "authorization_code",
        clientId: CrmAPIConfig.clientId,
        redirectUri: CrmAPIConfig.redirectURI,
        code: code,
        codeVerifier: verifier,
        refreshToken: nil
      ))
      pair = DeviceTokenPair(
        accessToken: response.accessToken,
        refreshToken: response.refreshToken
      )
    }
    guard !pair.accessToken.isEmpty else {
      throw DeviceAuthError.invalidResponse
    }
    guard tokenGeneration == expectedGeneration else { return nil }
    // A newly authorized session supersedes any refresh that was already in
    // flight. Its late response must not replace these new credentials.
    tokenGeneration &+= 1
    refreshTask?.cancel()
    refreshTask = nil
    refreshTaskID = nil
    tokenPersistence.save(pair.accessToken, Self.accessTokenAccount)
    if let refresh = pair.refreshToken, !refresh.isEmpty {
      tokenPersistence.save(refresh, Self.refreshTokenAccount)
    } else {
      // An optional field in a new-session response can never authorize reuse
      // of the prior session's refresh credential.
      _ = tokenPersistence.delete(Self.refreshTokenAccount)
    }
    isAuthenticated = true
    return tokenGeneration
  }

  /// Rotates the access token using the refresh token. The stored refresh token
  /// is replaced only after a successful response; on any failure — invalid
  /// token or ambiguous network error — the session is purged and the device
  /// must reconnect.
  func refreshTokens(rejectedAccessToken: String? = nil) async -> Bool {
    // A request can receive its 401 after another request already completed
    // the global rotation. Its rejected bearer is then stale: replay with the
    // current session, without consuming the newly issued refresh token.
    if currentAccessTokenDiffers(from: rejectedAccessToken) {
      return true
    }
    if let refreshTask {
      let refreshed = await refreshTask.value
      return refreshed || currentAccessTokenDiffers(from: rejectedAccessToken)
    }

    let expectedGeneration = tokenGeneration
    let taskID = UUID()
    let task = Task { @MainActor [weak self] in
      guard let self else { return false }
      return await self.performTokenRefresh(expectedGeneration: expectedGeneration)
    }
    refreshTask = task
    refreshTaskID = taskID
    let refreshed = await task.value
    // A logout/new login can cancel this task, clear the slot and start a new
    // session's rotation before this creator resumes. Clear only our own slot.
    if refreshTaskID == taskID {
      refreshTask = nil
      refreshTaskID = nil
    }
    return refreshed || currentAccessTokenDiffers(from: rejectedAccessToken)
  }

  /// True only when a request's exact rejected bearer has already been
  /// replaced. A nil snapshot preserves the existing conservative behavior.
  private func currentAccessTokenDiffers(from rejectedAccessToken: String?) -> Bool {
    guard let rejectedAccessToken, !rejectedAccessToken.isEmpty,
          let current = tokenPersistence.read(Self.accessTokenAccount),
          !current.isEmpty
    else { return false }
    return current != rejectedAccessToken
  }

  /// Purges only if the 401 still applies to the current session. A delayed
  /// response for an older bearer must not destroy a newer successful
  /// rotation. Returns false when a newer bearer has superseded the request.
  @discardableResult
  func purgeIfCurrentAccessToken(_ rejectedAccessToken: String?) -> Bool {
    if currentAccessTokenDiffers(from: rejectedAccessToken) {
      return false
    }
    purge()
    return true
  }

  private func performTokenRefresh(expectedGeneration: UInt64) async -> Bool {
    // A newer sign-in/purge can run after the shared task is created but
    // before its body starts. In that case this obsolete task must be inert,
    // not purge the newer session.
    guard tokenGeneration == expectedGeneration else { return false }
    guard let currentRefresh = tokenPersistence.read(Self.refreshTokenAccount),
          !currentRefresh.isEmpty
    else {
      purge()
      return false
    }
    do {
      let pair: DeviceTokenPair
      if let refreshExchange {
        pair = try await refreshExchange(currentRefresh)
      } else {
        let response = try await requestTokens(TokenRequestBody(
          grantType: "refresh_token",
          clientId: CrmAPIConfig.clientId,
          redirectUri: nil,
          code: nil,
          codeVerifier: nil,
          refreshToken: currentRefresh
        ))
        pair = DeviceTokenPair(
          accessToken: response.accessToken,
          refreshToken: response.refreshToken
        )
      }
      guard !pair.accessToken.isEmpty else {
        throw DeviceAuthError.invalidResponse
      }
      // `purge()` and a fresh authorization both advance the generation and
      // cancel this task. Ignore any transport that completes after either.
      guard !Task.isCancelled, tokenGeneration == expectedGeneration else {
        return false
      }
      tokenPersistence.save(pair.accessToken, Self.accessTokenAccount)
      let nextRefresh = pair.refreshToken.flatMap { $0.isEmpty ? nil : $0 } ?? currentRefresh
      tokenPersistence.save(nextRefresh, Self.refreshTokenAccount)
      tokenGeneration &+= 1
      isAuthenticated = true
      return true
    } catch {
      // A newer session may have been installed while this request was
      // suspended. Never purge that newer success because an old call failed.
      if tokenGeneration == expectedGeneration {
        purge()
      }
      return false
    }
  }

  /// Purges the local session synchronously, then revokes its captured bearer
  /// remotely on a best-effort basis. `afterLocalPurge` lets the owning store
  /// clear customer UI/cache state in the same actor turn, before any network
  /// suspension can admit a late authenticated response.
  func signOut(afterLocalPurge: () -> Void = {}) async {
    let token = tokenPersistence.read(Self.accessTokenAccount)
    purge()
    afterLocalPurge()

    guard let token, !token.isEmpty else { return }
    if let logoutRevocation {
      await logoutRevocation(token)
      return
    }
    guard let logoutURL = CrmAPIConfig.logoutURL else { return }
    var request = URLRequest(url: logoutURL)
    request.httpMethod = "POST"
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    _ = try? await Self.directSession.data(for: request)
  }

  /// Removes every local trace of the session.
  func purge() {
    tokenGeneration &+= 1
    refreshTask?.cancel()
    refreshTask = nil
    refreshTaskID = nil
    let session = webSession
    webSession = nil
    authenticationAttemptID = nil
    _ = tokenPersistence.delete(Self.accessTokenAccount)
    _ = tokenPersistence.delete(Self.refreshTokenAccount)
    isAuthenticated = false
    isAuthenticating = false
    pending = nil
    session?.cancel()
  }

  static func message(for error: Error) -> String {
    if let localized = error as? LocalizedError, let description = localized.errorDescription {
      return description
    }
    return "Connexion de l'appareil impossible — réessayez."
  }
}

/// Presentation anchor for the authentication session. The anchor is resolved
/// once before the session starts and served from that prepared value; a
/// window that could present nothing is never handed to the session —
/// `resolveAnchor()` reports nil instead so the flow fails closed.
/// Subclassable so tests can exercise the fail-closed contract.
class AuthPresentationAnchorProvider: NSObject, ASWebAuthenticationPresentationContextProviding {
  private var preparedAnchor: ASPresentationAnchor?

  /// Remembers the pre-flight anchor for the session's context query.
  func prepare(anchor: ASPresentationAnchor) {
    preparedAnchor = anchor
  }

  /// A real, presentable window of a foreground scene — or nil when none
  /// exists. Never an empty anchor.
  func resolveAnchor() -> ASPresentationAnchor? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    let activeScenes = scenes.filter { $0.activationState == .foregroundActive }
    let candidates = (activeScenes.isEmpty ? scenes : activeScenes).flatMap(\.windows)
    if let keyWindow = candidates.first(where: { $0.isKeyWindow && isPresentable($0) }) {
      authDiag(.anchorKeyWindow)
      return keyWindow
    }
    // `keyWindow` can be momentarily nil while a sheet transition is in
    // flight — exactly when the auth session needs its anchor — so fall back
    // to any usable window of a foreground scene.
    if let anyWindow = candidates.first(where: { isPresentable($0) }) {
      authDiag(.anchorFallbackWindow)
      return anyWindow
    }
    return nil
  }

  private func isPresentable(_ window: UIWindow) -> Bool {
    !window.frame.isEmpty
  }

  nonisolated func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    MainActor.assumeIsolated {
      if let preparedAnchor { return preparedAnchor }
      return resolveAnchor() ?? ASPresentationAnchor()
    }
  }
}
