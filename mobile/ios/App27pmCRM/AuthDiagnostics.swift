import Observation
import SwiftUI

// MARK: - Auth diagnostic vocabulary (all configurations)

/// Coarse, non-secret stage labels for the device-connection flow. The
/// vocabulary is a closed set: no URL, authorization code, token, PKCE
/// verifier/challenge, state, identifier or raw error text can be expressed
/// through it. The enum itself is inert in every configuration; only the
/// DEBUG storage below records values.
enum AuthDiagStage: String, CaseIterable, Sendable {
  case idle
  case tapReceived = "tap_received"
  case anchorKeyWindow = "anchor_key_window"
  case anchorFallbackWindow = "anchor_fallback_window"
  case anchorMissing = "anchor_missing"
  case startTrue = "start_true"
  case startFalse = "start_false"
  case completionCallback = "completion_callback"
  case callbackSuccess = "callback_success"
  case cancelled
  case errorCategory = "error_category"
}

/// Coarse failure categories — never raw error text.
enum AuthDiagErrorCategory: String, CaseIterable, Sendable {
  case session
  case network
  case callbackRejected = "callback_rejected"
  case configuration
  case unknown
}

#if DEBUG
// MARK: - DEBUG-only diagnostic storage and UI

/// DEBUG-only observable trace of the device-connection flow, displayed under
/// the device-connection button in Settings. Compiled out of release builds
/// together with the strip; the release stub of `authDiag` is a no-op.
@Observable
@MainActor
final class AuthDiagnostics {
  /// Unique marker emitted at app startup so any log line can be bound to
  /// this diagnostic build. Contains the marker and build tag only.
  static let launchMarker = "AUTH_DIAG_20261003_A"
  static let historyLimit = 24

  static let shared = AuthDiagnostics()

  private(set) var stage: AuthDiagStage = .idle
  private(set) var failure: AuthDiagErrorCategory?
  private(set) var history: [String] = []

  init() {}

  func record(_ stage: AuthDiagStage, failure category: AuthDiagErrorCategory? = nil) {
    self.stage = stage
    switch stage {
    case .errorCategory:
      let resolved = category ?? .unknown
      failure = resolved
      append("error_category:\(resolved.rawValue)")
    case .tapReceived, .callbackSuccess:
      // A new attempt and a completed sign-in both clear the last failure.
      failure = nil
      append(stage.rawValue)
    default:
      append(stage.rawValue)
    }
  }

  func reset() {
    stage = .idle
    failure = nil
    history = []
  }

  private func append(_ label: String) {
    history.append(label)
    if history.count > Self.historyLimit {
      history.removeFirst(history.count - Self.historyLimit)
    }
  }
}

/// DEBUG-only strip shown under the device-connection button. Renders only
/// coarse stage labels and the launch marker — nothing else.
struct AuthDiagnosticStrip: View {
  let diagnostics: AuthDiagnostics

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      Text(headerText)
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .foregroundStyle(Theme.amber)
      if !diagnostics.history.isEmpty {
        Text(diagnostics.history.joined(separator: " → "))
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .accessibilityLabel("Diagnostic de connexion (débogage)")
  }

  private var headerText: String {
    let failureSuffix: String
    if diagnostics.stage == .errorCategory, let failure = diagnostics.failure {
      failureSuffix = ":\(failure.rawValue)"
    } else {
      failureSuffix = ""
    }
    return "\(AuthDiagnostics.launchMarker) · \(diagnostics.stage.rawValue)\(failureSuffix)"
  }
}

/// Shared DEBUG hook used by the authentication flow.
func authDiag(_ stage: AuthDiagStage, failure category: AuthDiagErrorCategory? = nil) {
  AuthDiagnostics.shared.record(stage, failure: category)
}

#else

/// Release no-op — the instrumentation call sites compile identically in both
/// configurations; only this function body differs. No storage, no UI.
func authDiag(_ stage: AuthDiagStage, failure category: AuthDiagErrorCategory? = nil) {}

#endif
