import AuthenticationServices
import Testing
@testable import App27pmCRM

/// Regression proofs for the invisible-session failure shipped in TestFlight
/// 1.0.0 (1): the flow must never start a system session it cannot present,
/// and a failed start must leave a clean, retryable state.
@MainActor
@Suite
struct DeviceAuthStartResetTests {

  /// Test seam: no window ever resolves — the state a device reaches when the
  /// key window is unavailable during a sheet transition.
  private final class AnchorlessProvider: AuthPresentationAnchorProvider {
    override func resolveAnchor() -> ASPresentationAnchor? { nil }
  }

  @Test func missingAnchorFailsClosedWithRetryableError() {
    let auth = DeviceAuth(anchorProvider: AnchorlessProvider())
    auth.startAuthentication()
    #expect(!auth.isAuthenticating, "Aucune session ne doit rester en vol quand l'ancre manque")
    #expect(auth.authError == DeviceAuth.startFailureMessage)
  }

  @Test func retryAfterAnchorFailureTakesTheSameCleanPath() {
    let auth = DeviceAuth(anchorProvider: AnchorlessProvider())
    auth.startAuthentication()
    auth.startAuthentication()
    #expect(!auth.isAuthenticating)
    #expect(auth.authError == DeviceAuth.startFailureMessage)
  }

  @Test func startFalseFailsClosedWithRetryableError() {
    let auth = DeviceAuth(
      anchorProvider: AuthPresentationAnchorProvider(),
      startSession: { _, _ in false }
    )
    auth.startAuthentication()
    #expect(!auth.isAuthenticating)
    #expect(auth.authError == DeviceAuth.startFailureMessage)
  }

  @Test func successfulStartKeepsTheSessionInFlight() {
    let auth = DeviceAuth(
      anchorProvider: AuthPresentationAnchorProvider(),
      startSession: { _, _ in true }
    )
    auth.startAuthentication()
    #expect(auth.isAuthenticating)
    #expect(auth.authError == nil)
  }

  @Test func tapDuringInFlightSessionNeverStartsASecondSession() {
    var startCount = 0
    let auth = DeviceAuth(
      anchorProvider: AuthPresentationAnchorProvider(),
      startSession: { _, _ in startCount += 1; return true }
    )
    auth.startAuthentication()
    auth.startAuthentication()
    #expect(startCount == 1)
    #expect(auth.isAuthenticating)
  }

  @Test func startFailureMessageIsGenericAndSecretFree() {
    let message = DeviceAuth.startFailureMessage.lowercased()
    #expect(!message.isEmpty)
    // Closed vocabulary: no origin, OAuth material, credential or contact.
    for forbidden in ["crm.27pm.org", "https", "code", "token", "state", "verifier", "challenge", "@"] {
      #expect(!message.contains(forbidden), "Le message ne doit pas contenir « \(forbidden) »")
    }
  }
}
