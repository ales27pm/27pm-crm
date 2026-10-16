import SwiftUI

struct ContentView: View {
  @Environment(CrmStore.self) private var store
  @State private var selection: AppTab = .today

  enum AppTab: Hashable {
    case today
    case inbox
    case accounts
    case pipeline
    case tasks
  }

  var body: some View {
    Group {
      if case .live = store.mode, !store.auth.isAuthenticated {
        VStack(spacing: 10) {
          ProgressView()
          Text("Session CRM en cours de fermeture…")
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.ivory)
        .accessibilityIdentifier("crm-session-transition")
      } else {
        customerTabs
      }
    }
    // Reset the complete customer-data subtree, including navigation, sheets
    // and value-backed @State, for every logout and fresh authentication.
    .id(store.uiSessionRevision)
    .tint(Theme.blue)
    .safeAreaInset(edge: .top, spacing: 0) {
      if store.mode == .live && store.auth.isAuthenticated && !store.network.isOnline {
        offlineBanner
      }
    }
  }

  private var customerTabs: some View {
    TabView(selection: $selection) {
      TodayView(
        onOpenTasks: { selection = .tasks },
        onSwitchToAccounts: { selection = .accounts }
      )
      .tabItem { Label("Aujourd'hui", systemImage: "calendar") }
      .tag(AppTab.today)

      InboxView()
        .tabItem { Label("Réception", systemImage: "tray") }
        .tag(AppTab.inbox)
        .badge(store.totalUnreadCount)

      AccountsView()
        .tabItem { Label("Comptes", systemImage: "person.text.rectangle") }
        .tag(AppTab.accounts)

      PipelineView()
        .tabItem { Label("Pipeline", systemImage: "flowchart") }
        .tag(AppTab.pipeline)

      TasksView()
        .tabItem { Label("Tâches", systemImage: "checklist") }
        .tag(AppTab.tasks)
    }
  }

  /// Discrete banner shown over live data when connectivity drops — the
  /// offline cache keeps serving the last known server payload.
  private var offlineBanner: some View {
    HStack(spacing: 8) {
      Image(systemName: "wifi.slash")
        .font(.system(size: 12, weight: .semibold))
      Text("Hors ligne — données locales du \(store.cachedAt.map { Fmt.shortDay($0) } ?? "dernier accès")")
        .font(.system(size: 12, weight: .semibold))
    }
    .foregroundStyle(Theme.ivory)
    .frame(maxWidth: .infinity)
    .padding(.vertical, 7)
    .background(Theme.ink)
  }
}
