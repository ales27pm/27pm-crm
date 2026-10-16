#if DEBUG
import Testing
@testable import App27pmCRM

/// DEBUG-only suite: validates the coarse stage vocabulary and the transition
/// semantics of the authentication diagnostic trace. The vocabulary is a
/// closed set — no URL, code, token, PKCE material, state, identifier or raw
/// error text can be expressed through it.
@MainActor
@Suite
struct AuthDiagnosticsTests {
  @Test
  func startsIdleWithoutHistory() {
    let diagnostics = AuthDiagnostics()
    #expect(diagnostics.stage == .idle)
    #expect(diagnostics.failure == nil)
    #expect(diagnostics.history.isEmpty)
  }

  @Test
  func tapStartSequenceRecordsInOrder() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.tapReceived)
    diagnostics.record(.anchorKeyWindow)
    diagnostics.record(.startTrue)
    #expect(diagnostics.stage == .startTrue)
    #expect(diagnostics.history == ["tap_received", "anchor_key_window", "start_true"])
  }

  @Test
  func anchorFallbackAndMissingAreDistinctStages() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.anchorFallbackWindow)
    #expect(diagnostics.stage == .anchorFallbackWindow)
    diagnostics.record(.anchorMissing)
    #expect(diagnostics.stage == .anchorMissing)
  }

  @Test
  func startFalseIsRecordedWithoutCategory() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.startFalse)
    #expect(diagnostics.stage == .startFalse)
    #expect(diagnostics.failure == nil)
    #expect(diagnostics.history.last == "start_false")
  }

  @Test
  func errorCategoryCarriesCoarseLabelOnly() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.errorCategory, failure: .network)
    #expect(diagnostics.stage == .errorCategory)
    #expect(diagnostics.failure == .network)
    #expect(diagnostics.history.last == "error_category:network")
  }

  @Test
  func cancellationCarriesNoCategory() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.errorCategory, failure: .network)
    diagnostics.record(.cancelled)
    #expect(diagnostics.stage == .cancelled)
    #expect(diagnostics.history.last == "cancelled")
  }

  @Test
  func callbackSuccessClearsFailure() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.errorCategory, failure: .session)
    diagnostics.record(.callbackSuccess)
    #expect(diagnostics.stage == .callbackSuccess)
    #expect(diagnostics.failure == nil)
  }

  @Test
  func newAttemptClearsFailure() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.errorCategory, failure: .configuration)
    diagnostics.record(.tapReceived)
    #expect(diagnostics.stage == .tapReceived)
    #expect(diagnostics.failure == nil)
  }

  @Test
  func historyIsBounded() {
    let diagnostics = AuthDiagnostics()
    for _ in 0..<(AuthDiagnostics.historyLimit + 10) {
      diagnostics.record(.tapReceived)
    }
    #expect(diagnostics.history.count == AuthDiagnostics.historyLimit)
  }

  @Test
  func stageVocabularyIsClosed() {
    let allowed: Set<String> = [
      "idle", "tap_received", "anchor_key_window", "anchor_fallback_window",
      "anchor_missing", "start_true", "start_false", "completion_callback",
      "callback_success", "cancelled", "error_category",
    ]
    #expect(Set(AuthDiagStage.allCases.map(\.rawValue)) == allowed)
  }

  @Test
  func categoryVocabularyIsClosed() {
    let allowed: Set<String> = ["session", "network", "callback_rejected", "configuration", "unknown"]
    #expect(Set(AuthDiagErrorCategory.allCases.map(\.rawValue)) == allowed)
  }

  @Test
  func resetRestoresIdle() {
    let diagnostics = AuthDiagnostics()
    diagnostics.record(.startFalse)
    diagnostics.reset()
    #expect(diagnostics.stage == .idle)
    #expect(diagnostics.failure == nil)
    #expect(diagnostics.history.isEmpty)
  }
}
#endif
