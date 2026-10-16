import SwiftUI

/// Tâches — overdue, upcoming and completed tasks.
struct TasksView: View {
  @Environment(CrmStore.self) private var store

  @State private var showCompleted = true

  private var startOfToday: Date { Fmt.startOfDay(for: Date()) }

  private var pending: [CrmTask] {
    store.data.tasks
      .filter { !$0.completed }
      .sorted { ($0.dueDate ?? .distantFuture) < ($1.dueDate ?? .distantFuture) }
  }

  private var overdue: [CrmTask] {
    pending.filter { ($0.dueDate ?? .distantFuture) < startOfToday }
  }

  private var upcoming: [CrmTask] {
    pending.filter { ($0.dueDate ?? .distantFuture) >= startOfToday }
  }

  private var completed: [CrmTask] {
    store.data.tasks.filter { $0.completed }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 20) {
          if !overdue.isEmpty {
            taskSection(eyebrow: "Attention", title: "En retard", tasks: overdue, alert: true)
          }
          taskSection(eyebrow: "File", title: "À venir", tasks: upcoming, alert: false)
          completedSection
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 28)
      }
      .crmScreenChrome()
      .refreshable { await store.refresh() }
      .navigationTitle("Tâches")
    }
  }

  private func taskSection(eyebrow: String, title: String, tasks: [CrmTask], alert: Bool) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: eyebrow, title: title, count: tasks.count)
      if tasks.isEmpty {
        Card {
          Text(alert ? "Aucune tâche en retard." : "Aucune tâche à venir.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      } else {
        VStack(spacing: 8) {
          ForEach(tasks) { task in
            taskRow(task, alert: alert)
          }
        }
      }
    }
  }

  private var completedSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      Button {
        withAnimation(.snappy) { showCompleted.toggle() }
      } label: {
        HStack {
          Eyebrow("Terminées")
          Text("\(completed.count)")
            .font(.display(15, weight: .bold))
            .foregroundStyle(Theme.muted)
          Spacer()
          Image(systemName: showCompleted ? "chevron.down" : "chevron.right")
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.muted)
        }
      }
      .buttonStyle(.plain)
      if showCompleted {
        if completed.isEmpty {
          Card {
            Text("Aucune tâche terminée.")
              .font(.system(size: 13))
              .foregroundStyle(Theme.muted)
          }
        } else {
          VStack(spacing: 8) {
            ForEach(completed) { task in
              taskRow(task, alert: false)
            }
          }
        }
      }
    }
  }

  private func taskRow(_ task: CrmTask, alert: Bool) -> some View {
    Button {
      withAnimation(.snappy) {
        store.toggleTask(task.id)
      }
      Haptics.light()
    } label: {
      HStack(alignment: .top, spacing: 12) {
        Image(systemName: task.completed ? "checkmark.circle.fill" : "circle")
          .font(.system(size: 20))
          .foregroundStyle(task.completed ? Theme.green : (alert ? Theme.amber : Theme.muted))
          .frame(width: 24)
        VStack(alignment: .leading, spacing: 3) {
          Text(task.title)
            .font(.system(size: 14.5, weight: .semibold))
            .strikethrough(task.completed, color: Theme.muted)
            .foregroundStyle(task.completed ? Theme.muted : Theme.ink)
            .multilineTextAlignment(.leading)
          HStack(spacing: 6) {
            Text(task.organization)
              .font(.system(size: 11.5))
              .foregroundStyle(Theme.muted)
            Text("·")
              .font(.system(size: 11.5))
              .foregroundStyle(Theme.muted)
            Text(dueLabel(task, alert: alert))
              .font(.system(size: 11.5, weight: .heavy))
              .kerning(0.4)
              .textCase(.uppercase)
              .foregroundStyle(!task.completed && alert ? Theme.amber : Theme.muted)
          }
        }
        Spacer(minLength: 4)
      }
      .padding(13)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
      .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
    }
    .buttonStyle(.plain)
    .accessibilityLabel(task.completed ? "Rouvrir « \(task.title) »" : "Terminer « \(task.title) »")
  }

  private func dueLabel(_ task: CrmTask, alert: Bool) -> String {
    if task.completed { return "Terminée" }
    guard let date = task.dueDate else { return "Sans échéance" }
    if date < startOfToday { return "En retard · \(Fmt.shortDay(date))" }
    if Fmt.calendar.isDate(date, inSameDayAs: startOfToday) { return "Aujourd'hui" }
    return Fmt.shortDay(date)
  }
}
