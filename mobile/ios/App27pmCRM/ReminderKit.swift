import Foundation
import UserNotifications

// MARK: - Settings

struct ReminderSettings: Codable, Equatable {
  var enabled: Bool = false
  var hour: Int = 8

  static let defaultsKey = "org.27pm.crm.reminder-settings"

  static func load() -> ReminderSettings {
    guard let data = UserDefaults.standard.data(forKey: defaultsKey),
      let settings = try? JSONDecoder().decode(ReminderSettings.self, from: data)
    else { return ReminderSettings() }
    return settings
  }

  func persist() {
    if let data = try? JSONEncoder().encode(self) {
      UserDefaults.standard.set(data, forKey: Self.defaultsKey)
    }
  }
}

// MARK: - Pure planner

struct PlannedReminder: Equatable {
  let identifier: String
  let title: String
  let body: String
  let fireDateComponents: DateComponents
}

/// Pure planner, free of any UserNotifications dependency: computes the
/// daily follow-up digest from dashboard data so it can be tested without a
/// notification center. One digest per day covers the three due families —
/// accounts with an expired follow-up, deals whose next action is due (won
/// deals excluded) and overdue tasks.
enum ReminderPlanner {
  static let identifierPrefix = "org27pm-reminder-"
  static let dailyIdentifier = identifierPrefix + "daily"

  static func plan(
    data: DashboardData,
    now: Date,
    hour: Int,
    calendar: Calendar = Fmt.calendar
  ) -> PlannedReminder? {
    let startOfToday = calendar.startOfDay(for: now)

    let dueAccountFollowUps = data.organizations.filter { organization in
      guard let date = organization.nextFollowUpAt else { return false }
      return date <= startOfToday
    }
    let dueDealActions = data.deals.filter { deal in
      guard deal.stage != .gagne, let date = deal.nextActionDate else { return false }
      return date <= startOfToday
    }
    let overdueTasks = data.tasks.filter { !$0.completed && ($0.dueDate.map { $0 < startOfToday } ?? false) }

    let total = dueAccountFollowUps.count + dueDealActions.count + overdueTasks.count
    guard total > 0 else { return nil }

    var lines: [String] = []
    if !dueDealActions.isEmpty {
      lines.append("\(dueDealActions.count) opportunité\(dueDealActions.count > 1 ? "s" : "") à relancer")
    }
    if !dueAccountFollowUps.isEmpty {
      lines.append("\(dueAccountFollowUps.count) suivi\(dueAccountFollowUps.count > 1 ? "s" : "") de compte échu\(dueAccountFollowUps.count > 1 ? "s" : "")")
    }
    if !overdueTasks.isEmpty {
      lines.append("\(overdueTasks.count) tâche\(overdueTasks.count > 1 ? "s" : "") en retard")
    }

    var body = lines.joined(separator: " · ")
    if let firstTitle = dueDealActions.first?.title
      ?? dueAccountFollowUps.first?.name
      ?? overdueTasks.first?.title,
      !firstTitle.trimmed.isEmpty
    {
      body += "\n\(firstTitle)"
    }
    body += "\nOuvrez Aujourd'hui pour traiter la liste."

    return PlannedReminder(
      identifier: dailyIdentifier,
      title: "Rappels 27PM — \(total) à traiter",
      body: body,
      fireDateComponents: fireComponents(now: now, hour: hour, calendar: calendar)
    )
  }

  /// Next occurrence of the configured hour — today while it is still ahead,
  /// otherwise tomorrow. Components carry the CRM's Montreal timezone so the
  /// fire time is stable regardless of device settings.
  static func fireComponents(now: Date, hour: Int, calendar: Calendar) -> DateComponents {
    var components = calendar.dateComponents([.year, .month, .day], from: now)
    components.hour = hour
    components.minute = 0
    components.timeZone = calendar.timeZone
    if let todayFire = calendar.date(from: components), todayFire <= now {
      let tomorrow = calendar.date(byAdding: .day, value: 1, to: now) ?? now
      components = calendar.dateComponents([.year, .month, .day], from: tomorrow)
      components.hour = hour
      components.minute = 0
      components.timeZone = calendar.timeZone
    }
    return components
  }
}

// MARK: - Scheduler

/// Generation fence for notification work that suspends in system APIs.
/// Logout invalidates the active generation before removing notifications, so
/// an old session cannot resume later and publish customer-data content.
@MainActor
final class ReminderSyncFence {
  private var generation: UInt64 = 0

  func begin() -> UInt64 {
    generation &+= 1
    return generation
  }

  func invalidate() {
    generation &+= 1
  }

  func isCurrent(_ expectedGeneration: UInt64, sessionIsCurrent: Bool) -> Bool {
    sessionIsCurrent && generation == expectedGeneration
  }
}

@Observable
@MainActor
final class ReminderScheduler {
  private struct SyncRequest {
    let data: DashboardData
    let settings: ReminderSettings
    let now: Date
    let sessionIsCurrent: @MainActor () -> Bool
  }

  /// True when the user refused notifications — Settings surfaces it so the
  /// toggle can explain why nothing arrives.
  private(set) var authorizationDenied = false
  private let syncFence = ReminderSyncFence()
  private let authorizationStatus: @MainActor () async -> UNAuthorizationStatus
  private let requestAuthorization: @MainActor () async -> Bool
  private let addReminder: @MainActor (UNNotificationRequest) async throws -> Void
  private let removePending: @MainActor ([String]) -> Void
  private let removeAll: @MainActor () -> Void
  private var isSyncing = false
  private var pendingSync: SyncRequest?

  init(
    authorizationStatus: @escaping @MainActor () async -> UNAuthorizationStatus = {
      await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    },
    requestAuthorization: @escaping @MainActor () async -> Bool = {
      (try? await UNUserNotificationCenter.current().requestAuthorization(
        options: [.alert, .sound, .badge]
      )) ?? false
    },
    addReminder: @escaping @MainActor (UNNotificationRequest) async throws -> Void = {
      try await UNUserNotificationCenter.current().add($0)
    },
    removePending: @escaping @MainActor ([String]) -> Void = {
      UNUserNotificationCenter.current().removePendingNotificationRequests(withIdentifiers: $0)
    },
    removeAll: @escaping @MainActor () -> Void = {
      UNUserNotificationCenter.current().removeAllPendingNotificationRequests()
    }
  ) {
    self.authorizationStatus = authorizationStatus
    self.requestAuthorization = requestAuthorization
    self.addReminder = addReminder
    self.removePending = removePending
    self.removeAll = removeAll
  }

  /// Replaces the daily digest with one computed from current data. Called
  /// after every successful live sync; demo mode and sign-out cancel
  /// everything instead.
  func sync(
    data: DashboardData,
    settings: ReminderSettings,
    now: Date = Date(),
    sessionIsCurrent: @escaping @MainActor () -> Bool = { true }
  ) async {
    let request = SyncRequest(
      data: data,
      settings: settings,
      now: now,
      sessionIsCurrent: sessionIsCurrent
    )
    guard !isSyncing else {
      // Retain only the newest snapshot while the system authorization/add
      // call is suspended. The active pass finishes or removes its stale work
      // before this follow-up begins.
      pendingSync = request
      return
    }
    isSyncing = true
    var nextRequest: SyncRequest? = request
    while let current = nextRequest {
      pendingSync = nil
      await performSync(current)
      nextRequest = pendingSync
    }
    isSyncing = false
  }

  private func performSync(_ request: SyncRequest) async {
    let expectedGeneration = syncFence.begin()
    let isCurrent = {
      self.syncFence.isCurrent(
        expectedGeneration,
        sessionIsCurrent: request.sessionIsCurrent()
      )
    }
    guard isCurrent() else { return }
    removePending([ReminderPlanner.dailyIdentifier])
    authorizationDenied = false

    guard request.settings.enabled else { return }
    guard let planned = ReminderPlanner.plan(
      data: request.data,
      now: request.now,
      hour: request.settings.hour
    ) else { return }

    let status = await authorizationStatus()
    guard isCurrent() else { return }
    switch status {
    case .authorized, .provisional, .ephemeral:
      break
    case .notDetermined:
      let granted = await requestAuthorization()
      guard isCurrent() else { return }
      authorizationDenied = !granted
      guard granted else { return }
    default:
      authorizationDenied = true
      return
    }

    let content = UNMutableNotificationContent()
    content.title = planned.title
    content.body = planned.body
    content.sound = .default
    let trigger = UNCalendarNotificationTrigger(dateMatching: planned.fireDateComponents, repeats: false)
    guard isCurrent() else { return }
    try? await addReminder(UNNotificationRequest(
      identifier: planned.identifier,
      content: content,
      trigger: trigger
    ))
    guard isCurrent() else {
      // `add` itself can suspend across logout. Because passes are serialized,
      // removing the fixed identifier here cannot erase a newer pass: that
      // pass begins only after this stale cleanup completes.
      removePending([planned.identifier])
      return
    }
  }

  /// Removes every pending reminder — demo mode and sign-out only.
  func cancelAll() {
    syncFence.invalidate()
    pendingSync = nil
    removeAll()
    authorizationDenied = false
  }
}
