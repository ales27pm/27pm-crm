import XCTest
import UserNotifications
@testable import App27pmCRM

// Xcode 26 / Swift 6.2 can crash when synchronous XCTest methods deallocate
// MainActor-isolated objects (swiftlang/swift#85663). Store-owning tests stay
// MainActor-isolated and async until that runtime defect is fixed upstream.

// MARK: - Offline dashboard cache

final class OfflineCacheTests: XCTestCase {
  private func tempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  @MainActor
  func testRoundTripPersistsPayloadAndDate() async throws {
    let cache = OfflineCache(directory: tempDirectory())
    let raw = Data("{\"organizations\":[]}".utf8)
    let fetchedAt = Date(timeIntervalSince1970: 1_790_000_000)

    cache.save(rawJSON: raw, fetchedAt: fetchedAt)
    let loaded = try XCTUnwrap(cache.load())
    XCTAssertEqual(loaded.rawJSON, raw)
    XCTAssertEqual(loaded.fetchedAt, fetchedAt)
  }

  @MainActor
  func testLoadWithoutFileReturnsNil() async {
    let cache = OfflineCache(directory: tempDirectory())
    XCTAssertNil(cache.load())
  }

  @MainActor
  func testPurgeRemovesTheCache() async {
    let cache = OfflineCache(directory: tempDirectory())
    cache.save(rawJSON: Data("{}".utf8))
    XCTAssertNotNil(cache.load())
    cache.purge()
    XCTAssertNil(cache.load())
  }

  @MainActor
  func testCorruptEnvelopeReturnsNil() async throws {
    let directory = tempDirectory()
    let cache = OfflineCache(directory: directory)
    try Data("not-a-cache".utf8).write(to: directory.appending(path: "offline-dashboard.json"))
    XCTAssertNil(cache.load())
  }
}

// MARK: - Outbox queue

final class OutboxQueueTests: XCTestCase {
  private func tempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: UUID().uuidString)
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
  }

  private func makeItem(key: String, subject: String = "att-1") -> OutboxItem {
    OutboxItem(
      id: UUID().uuidString,
      idempotencyKey: key,
      kind: .attachmentUpload,
      ownerKind: "account",
      ownerId: "org-1",
      subjectId: subject,
      label: "Photo",
      createdAt: Date()
    )
  }

  @MainActor
  func testEnqueueDeduplicatesByIdempotencyKey() async {
    let queue = OutboxQueue(directory: tempDirectory())
    queue.enqueue(makeItem(key: "upload-a"))
    queue.enqueue(makeItem(key: "upload-a"))
    XCTAssertEqual(queue.pendingCount, 1)
  }

  @MainActor
  func testDuplicateEnqueueMergesDurableRetryDeadline() async {
    let queue = OutboxQueue(directory: tempDirectory())
    let original = makeItem(key: "download-a")
    var recovered = original
    recovered.attempts = 3
    recovered.notBefore = Date(timeIntervalSince1970: 1_791_126_600)
    recovered.lastErrorCode = "attachment_quarantined"

    XCTAssertTrue(queue.enqueue(original))
    XCTAssertTrue(queue.enqueue(recovered))

    XCTAssertEqual(queue.pendingCount, 1)
    XCTAssertEqual(queue.items[0].attempts, 3)
    XCTAssertEqual(queue.items[0].notBefore, recovered.notBefore)
    XCTAssertEqual(queue.items[0].lastErrorCode, "attachment_quarantined")
  }

  @MainActor
  func testQueuePersistsAcrossInstances() async {
    let directory = tempDirectory()
    let first = OutboxQueue(directory: directory)
    first.enqueue(makeItem(key: "upload-a", subject: "att-1"))
    first.enqueue(makeItem(key: "upload-b", subject: "att-2"))

    let second = OutboxQueue(directory: directory)
    XCTAssertEqual(second.pendingCount, 2)
    XCTAssertTrue(second.contains(idempotencyKey: "upload-a"))
  }

  @MainActor
  func testDrainRemovesOnlySuccessfulItems() async {
    let queue = OutboxQueue(directory: tempDirectory())
    queue.enqueue(makeItem(key: "upload-a", subject: "att-1"))
    queue.enqueue(makeItem(key: "upload-b", subject: "att-2"))

    var handled: [String] = []
    await queue.drain { item in
      handled.append(item.subjectId)
      return .completed
    }
    XCTAssertEqual(handled, ["att-1", "att-2"])
    XCTAssertEqual(queue.pendingCount, 0)
  }

  @MainActor
  func testDrainStopsAtFirstFailureAndCountsAttempts() async {
    let queue = OutboxQueue(directory: tempDirectory())
    queue.enqueue(makeItem(key: "upload-a", subject: "att-1"))
    queue.enqueue(makeItem(key: "upload-b", subject: "att-2"))

    await queue.drain { _ in .paused(code: "test_failure") }
    XCTAssertEqual(queue.pendingCount, 2)
    XCTAssertEqual(queue.items.first?.attempts, 1)

    // Retry succeeds: the queue drains fully from the same head item.
    await queue.drain { _ in .completed }
    XCTAssertEqual(queue.pendingCount, 0)
  }

  @MainActor
  func testDrainCanPersistCurrentItemAndStopBeforeLaterRequests() async {
    let queue = OutboxQueue(directory: tempDirectory())
    queue.enqueue(makeItem(key: "upload-a", subject: "att-1"))
    queue.enqueue(makeItem(key: "upload-b", subject: "att-2"))
    var handled: [String] = []

    await queue.drain { item in
      handled.append(item.subjectId)
      return .pausedAndStop(code: "authentication_required")
    }

    XCTAssertEqual(handled, ["att-1"])
    XCTAssertEqual(queue.pendingCount, 2)
    XCTAssertEqual(queue.items[0].attempts, 1)
    XCTAssertEqual(queue.items[0].lastErrorCode, "authentication_required")
    XCTAssertEqual(queue.items[1].attempts, 0)
  }

  @MainActor
  func testRemoveDropsQueuedItemWithoutSending() async {
    let queue = OutboxQueue(directory: tempDirectory())
    queue.enqueue(makeItem(key: "upload-a"))
    queue.remove(idempotencyKey: "upload-a")
    XCTAssertFalse(queue.contains(idempotencyKey: "upload-a"))
    XCTAssertEqual(queue.pendingCount, 0)
  }
}

// MARK: - Reminder planner

final class ReminderPlannerTests: XCTestCase {
  @MainActor
  private final class SuspendedReminderCenter {
    var activeIdentifiers: Set<String> = []
    var events: [String] = []
    private var addCount = 0
    private var firstAddContinuation: CheckedContinuation<Void, Never>?

    func add(_ request: UNNotificationRequest) async throws {
      addCount += 1
      let sequence = addCount
      if sequence == 1 {
        await withCheckedContinuation { firstAddContinuation = $0 }
      }
      activeIdentifiers.insert(request.identifier)
      events.append("add-\(sequence)")
    }

    func removePending(_ identifiers: [String]) {
      activeIdentifiers.subtract(identifiers)
      events.append("remove-pending")
    }

    func removeAll() {
      activeIdentifiers.removeAll()
      events.append("remove-all")
    }

    func waitUntilFirstAddStarts() async {
      while firstAddContinuation == nil { await Task.yield() }
    }

    func resumeFirstAdd() {
      firstAddContinuation?.resume()
      firstAddContinuation = nil
    }
  }

  private let montreal = TimeZone(identifier: "America/Montreal") ?? .current

  private func date(_ year: Int, _ month: Int, _ day: Int, _ hour: Int, _ minute: Int) -> Date {
    var components = DateComponents()
    components.timeZone = montreal
    components.year = year
    components.month = month
    components.day = day
    components.hour = hour
    components.minute = minute
    return Fmt.calendar.date(from: components)!
  }

  private func makeDashboard(
    organizations: [Organization] = [],
    deals: [Deal] = [],
    tasks: [CrmTask] = []
  ) -> DashboardData {
    DashboardData(
      mailboxes: [],
      transportState: .operational,
      conversations: [],
      organizations: organizations,
      contacts: [],
      deals: deals,
      tasks: tasks,
      strategies: [],
      intakes: [],
      activities: []
    )
  }

  private func organization(dueFollowUp: Date?) -> Organization {
    Organization(
      id: "org-1", name: "Entreprise", score: 50, priority: .normal,
      budgetMinCents: 0, budgetMaxCents: 0, budgetIsHypothesis: false,
      nextStep: nil, notes: "", nextFollowUpAt: dueFollowUp, sourceLabel: ""
    )
  }

  private func deal(stage: PipelineStage, dueAction: Date?) -> Deal {
    Deal(
      id: "deal-1", organizationId: "org-1", contactId: "c-1",
      title: "Refonte du site", contactName: "Contact", organization: "Entreprise",
      projectType: .siteWeb, stage: stage,
      nextAction: "Relancer la proposition", nextActionDate: dueAction,
      note: "", interactions: []
    )
  }

  private func task(completed: Bool, due: Date?) -> CrmTask {
    CrmTask(
      id: "task-1", title: "Tâche en retard", completed: completed,
      dueDate: due, organizationId: "org-1", organization: "Entreprise", dealId: nil
    )
  }

  @MainActor
  func testReminderFenceRejectsSuspendedWorkAfterLogoutGeneration() async {
    let fence = ReminderSyncFence()
    let sessionAGeneration = fence.begin()
    XCTAssertTrue(fence.isCurrent(sessionAGeneration, sessionIsCurrent: true))

    // Models cancelAll() running while notificationSettings/add is suspended.
    fence.invalidate()
    XCTAssertFalse(fence.isCurrent(sessionAGeneration, sessionIsCurrent: true))

    let sessionBGeneration = fence.begin()
    XCTAssertTrue(fence.isCurrent(sessionBGeneration, sessionIsCurrent: true))
    XCTAssertFalse(fence.isCurrent(sessionBGeneration, sessionIsCurrent: false))
  }

  @MainActor
  func testSuspendedSessionAReminderIsRemovedBeforeQueuedSessionBPass() async {
    let center = SuspendedReminderCenter()
    let scheduler = ReminderScheduler(
      authorizationStatus: { .authorized },
      requestAuthorization: { true },
      addReminder: { try await center.add($0) },
      removePending: { center.removePending($0) },
      removeAll: { center.removeAll() }
    )
    let now = date(2026, 6, 15, 9, 0)
    let dashboard = makeDashboard(
      tasks: [task(completed: false, due: date(2026, 6, 14, 8, 0))]
    )
    let settings = ReminderSettings(enabled: true, hour: 10)
    var sessionRevision: UInt64 = 1

    let sessionAPass = Task { @MainActor in
      await scheduler.sync(
        data: dashboard,
        settings: settings,
        now: now,
        sessionIsCurrent: { sessionRevision == 1 }
      )
    }
    await center.waitUntilFirstAddStarts()

    sessionRevision = 2
    scheduler.cancelAll()
    // This B request is coalesced while A's system add is suspended. The
    // serialized scheduler must clean up A before starting this pass.
    await scheduler.sync(
      data: dashboard,
      settings: settings,
      now: now,
      sessionIsCurrent: { sessionRevision == 2 }
    )
    center.resumeFirstAdd()
    await sessionAPass.value

    XCTAssertEqual(center.activeIdentifiers, Set([ReminderPlanner.dailyIdentifier]))
    XCTAssertEqual(center.events, [
      "remove-pending",
      "remove-all",
      "add-1",
      "remove-pending",
      "remove-pending",
      "add-2",
    ])
  }

  func testReturnsNilWhenNothingIsDue() {
    let now = date(2026, 6, 15, 9, 0)
    let dashboard = makeDashboard(
      organizations: [organization(dueFollowUp: nil)],
      deals: [deal(stage: .proposition, dueAction: date(2026, 6, 20, 9, 0))],
      tasks: [task(completed: false, due: date(2026, 6, 20, 9, 0))]
    )
    XCTAssertNil(ReminderPlanner.plan(data: dashboard, now: now, hour: 8))
  }

  func testDigestCountsDueFamiliesAndExcludesWonDeals() {
    let yesterday = date(2026, 6, 14, 12, 0)
    let now = date(2026, 6, 15, 9, 0)
    let dashboard = makeDashboard(
      organizations: [organization(dueFollowUp: yesterday)],
      deals: [
        // Won deals never generate reminders, even when overdue.
        deal(stage: .gagne, dueAction: yesterday),
        deal(stage: .proposition, dueAction: yesterday),
      ],
      tasks: [
        task(completed: false, due: yesterday),
        task(completed: true, due: yesterday),
      ]
    )
    let reminder = ReminderPlanner.plan(data: dashboard, now: now, hour: 8)
    XCTAssertNotNil(reminder)
    // 1 deal + 1 org follow-up + 1 overdue task; won and completed excluded.
    XCTAssertEqual(reminder?.title, "Rappels 27PM — 3 à traiter")
  }

  func testFireDateIsTodayWhileTheHourIsAhead() {
    let now = date(2026, 6, 15, 7, 30)
    let components = ReminderPlanner.fireComponents(now: now, hour: 8, calendar: Fmt.calendar)
    XCTAssertEqual(components.hour, 8)
    XCTAssertEqual(components.day, 15)
  }

  func testFireDateFallsToTomorrowOnceTheHourHasPassed() {
    let now = date(2026, 6, 15, 9, 30)
    let components = ReminderPlanner.fireComponents(now: now, hour: 8, calendar: Fmt.calendar)
    XCTAssertEqual(components.hour, 8)
    XCTAssertEqual(components.day, 16)
  }
}
