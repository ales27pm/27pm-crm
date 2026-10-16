import SwiftUI

/// Shared navigation values across the CRM tabs.
enum Route: Hashable {
  case conversation(String)
  case deal(String)
  case account(String)
}

extension View {
  /// Installs the standard CRM destinations on a NavigationStack.
  @ViewBuilder
  func crmDestinations() -> some View {
    navigationDestination(for: Route.self) { route in
      switch route {
      case .conversation(let id):
        ThreadView(conversationId: id)
      case .deal(let id):
        DealDetailView(dealId: id)
      case .account(let id):
        AccountDetailView(organizationId: id)
      }
    }
  }
}
