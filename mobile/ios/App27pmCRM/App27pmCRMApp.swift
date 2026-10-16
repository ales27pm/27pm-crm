import SwiftUI

@main
struct App27pmCRMApp: App {
  @State private var store = CrmStore()

  init() {
    #if DEBUG
    // Diagnostic launch marker: marker + build tag only — no identifiers.
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    NSLog("\(AuthDiagnostics.launchMarker) build=\(version).\(build)")
    #endif
  }

  var body: some Scene {
    WindowGroup {
      Group {
        #if DEBUG
        if ProcessInfo.processInfo.arguments.contains("-ui-test-attachment-quarantine") {
          AttachmentQuarantineUITestHarness()
        } else {
          ContentView()
        }
        #else
        ContentView()
        #endif
      }
        .environment(store)
        .task { await store.refresh() }
        .onOpenURL { url in
          Task { await store.handleCallback(url) }
        }
        .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
          guard let url = activity.webpageURL else { return }
          Task { await store.handleCallback(url) }
        }
        .preferredColorScheme(.light)
        .tint(Theme.blue)
    }
  }
}

#if DEBUG
/// Deterministic local UI-test surface. It exercises the same production chip
/// used by attachment rows without requiring a forged token, scanner verdict,
/// debug endpoint or network mutation.
private struct AttachmentQuarantineUITestHarness: View {
  var body: some View {
    VStack(alignment: .leading, spacing: 16) {
      Text("Pièce jointe")
        .font(.headline)
      AttachmentStatusChip(label: "En vérification / fichier bloqué")
    }
    .padding()
  }
}
#endif
