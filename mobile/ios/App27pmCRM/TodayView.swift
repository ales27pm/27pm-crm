import SwiftUI

/// Cockpit Aujourd'hui — port of app/components/today-view.tsx.
struct TodayView: View {
  @Environment(CrmStore.self) private var store
  let onOpenTasks: () -> Void
  let onSwitchToAccounts: () -> Void

  @State private var settingsPresented = false
  @State private var selectedIntake: IntakeSubmission?

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 22) {
          header
          summaryGrid
          tasksButton
          queueSection
          watchSection
          upcomingSection
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 28)
      }
      .crmScreenChrome()
      .refreshable { await store.refresh() }
      .crmDestinations()
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button {
            settingsPresented = true
          } label: {
            Image(systemName: "gearshape")
              .foregroundStyle(Theme.ink)
          }
          .accessibilityLabel("Paramètres")
        }
      }
      .sheet(isPresented: $settingsPresented) {
        SettingsView()
      }
      .sheet(item: $selectedIntake) { intake in
        IntakeSheet(intake: intake, onOpenAccounts: onSwitchToAccounts)
      }
    }
  }

  private var snapshot: TodaySnapshot { store.todaySnapshot() }

  // MARK: Header

  private var header: some View {
    VStack(alignment: .leading, spacing: 6) {
      Eyebrow("Priorités opérationnelles")
      Text("Bonjour \(store.operatorName)")
        .font(.display(32))
        .foregroundStyle(Theme.ink)
      Text("\(Fmt.longDate(Date())) · Voici ce qui demande une décision humaine. Aucune action n'envoie de message.")
        .font(.system(size: 13.5))
        .foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  // MARK: Summary

  private var summaryGrid: some View {
    LazyVGrid(
      columns: [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)],
      spacing: 10
    ) {
      StatBlock(title: "À traiter", value: snapshot.actionCount, caption: "décisions dans la file")
      StatBlock(
        title: "En retard", value: snapshot.overdueTasks.count,
        caption: "tâches ouvertes", alert: !snapshot.overdueTasks.isEmpty
      )
      StatBlock(
        title: "Non lus", value: snapshot.unreadConversations.count,
        caption: "conversations entrantes"
      )
      StatBlock(
        title: "Pipeline à risque", value: snapshot.atRiskDeals.count,
        caption: "retards ou suivi absent", alert: !snapshot.atRiskDeals.isEmpty
      )
    }
  }

  private var tasksButton: some View {
    Button {
      onOpenTasks()
    } label: {
      HStack {
        Image(systemName: "checklist")
        Text("Voir toutes les tâches")
          .font(.system(size: 13.5, weight: .semibold))
        Spacer()
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
      }
      .foregroundStyle(Theme.blueDeep)
      .padding(.horizontal, 14)
      .padding(.vertical, 11)
      .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
      .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.blue.opacity(0.25), lineWidth: 1))
    }
    .buttonStyle(.plain)
  }

  // MARK: Queue

  private var queueSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "À traiter", title: "File du jour", count: snapshot.actionCount)
      if snapshot.actionCount == 0 {
        Card {
          EmptyHint(
            title: "Tout est à jour",
            caption: "Les nouvelles demandes, les relances et les messages apparaîtront ici."
          )
        }
      } else {
        VStack(spacing: 8) {
          ForEach(snapshot.pendingIntakes) { intake in
            Button {
              selectedIntake = intake
            } label: {
              todayRowContent(
                chip: .intake,
                title: intake.organizationName,
                subtitle: "\(intake.contactName) · \(Fmt.relative(intake.createdAt))",
                detail: intake.projectType ?? "Projet à qualifier",
                actionLabel: "Qualifier"
              )
            }
            .buttonStyle(.plain)
          }

          ForEach(snapshot.overdueTasks) { task in
            HStack(alignment: .top, spacing: 0) {
              Button {
                withAnimation(.snappy) {
                  store.toggleTask(task.id)
                }
                Haptics.success()
              } label: {
                Image(systemName: "circle")
                  .font(.system(size: 19))
                  .foregroundStyle(Theme.muted)
                  .frame(width: 36, height: 44)
              }
              .buttonStyle(.plain)
              .accessibilityLabel("Marquer « \(task.title) » terminée")

              Button {
                onOpenTasks()
              } label: {
                todayRowContent(
                  chip: .overdueTask,
                  title: task.title,
                  subtitle: "\(task.organization) · En retard",
                  detail: task.dueDate.map { Fmt.shortDay($0) } ?? "",
                  actionLabel: "Voir"
                )
              }
              .buttonStyle(.plain)
            }
          }

          ForEach(snapshot.unreadConversations) { conversation in
            NavigationLink(value: Route.conversation(conversation.id)) {
              todayRowContent(
                chip: .unread,
                title: conversation.subject,
                subtitle: "\(conversation.contactName) · \(conversation.organization)",
                detail: conversation.preview,
                actionLabel: "Ouvrir"
              )
            }
            .buttonStyle(.plain)
            .simultaneousGesture(
              TapGesture().onEnded { store.markRead(conversation.id) }
            )
          }

          ForEach(snapshot.dueFollowUps) { followUp in
            NavigationLink(
              value: followUp.kind == .deal
                ? Route.deal(followUp.dealId ?? "")
                : Route.account(followUp.organizationId ?? "")
            ) {
              todayRowContent(
                chip: .followUp,
                title: followUp.title,
                subtitle: "\(followUp.organization) · Échéance atteinte",
                detail: Fmt.shortDay(followUp.dueDate),
                actionLabel: "Ouvrir"
              )
            }
            .buttonStyle(.plain)
          }

          ForEach(snapshot.accountsToPlan) { organization in
            NavigationLink(value: Route.account(organization.id)) {
              todayRowContent(
                chip: .planning,
                title: organization.name,
                subtitle: "\(organization.priority.shortLabel) · Suivi interne",
                detail: organization.nextStep?.trimmed.isEmpty == false
                  ? (organization.nextStep ?? "")
                  : "Définir la prochaine étape",
                actionLabel: "Planifier"
              )
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
  }

  private func todayRowContent(
    chip: QueueKind,
    title: String,
    subtitle: String,
    detail: String,
    actionLabel: String
  ) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Chip(chip.label, foreground: chip.foreground, background: chip.background)
        .fixedSize()
      VStack(alignment: .leading, spacing: 3) {
        Text(title)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.ink)
          .multilineTextAlignment(.leading)
        Text(subtitle)
          .font(.system(size: 12))
          .foregroundStyle(Theme.muted)
          .lineLimit(1)
        if !detail.isEmpty {
          Text(detail)
            .font(.system(size: 12.5))
            .foregroundStyle(Theme.ink.opacity(0.7))
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        }
      }
      Spacer(minLength: 8)
      HStack(spacing: 2) {
        Text(actionLabel)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Theme.blue)
        Image(systemName: "chevron.right")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Theme.blue)
      }
    }
    .padding(13)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
  }

  // MARK: Watch & upcoming

  private var watchSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "Attention", title: "Pipeline à surveiller", count: snapshot.atRiskDeals.count)
      if snapshot.atRiskDeals.isEmpty {
        Card {
          Text("Aucune opportunité en retard ou sans plan.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      } else {
        VStack(spacing: 8) {
          ForEach(snapshot.atRiskDeals) { deal in
            NavigationLink(value: Route.deal(deal.id)) {
              HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                  Text(deal.title)
                    .font(.system(size: 14.5, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.leading)
                  Text("\(deal.organization) · \(deal.stage.label)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 8)
                Text(riskReason(deal))
                  .font(.system(size: 11, weight: .heavy))
                  .kerning(0.6)
                  .textCase(.uppercase)
                  .foregroundStyle(Theme.amber)
                  .frame(maxWidth: 96, alignment: .trailing)
                  .multilineTextAlignment(.trailing)
              }
              .padding(13)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
              .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
  }

  private var upcomingSection: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "À venir", title: "Relances planifiées", count: snapshot.upcomingDeals.count)
      if snapshot.upcomingDeals.isEmpty {
        Card {
          Text("Aucune relance future planifiée.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      } else {
        VStack(spacing: 8) {
          ForEach(Array(snapshot.upcomingDeals.prefix(6))) { deal in
            NavigationLink(value: Route.deal(deal.id)) {
              HStack(alignment: .top, spacing: 12) {
                Text(deal.nextActionDate.map { Fmt.shortDay($0) } ?? "")
                  .font(.system(size: 12, weight: .heavy))
                  .kerning(0.4)
                  .textCase(.uppercase)
                  .foregroundStyle(Theme.blue)
                  .frame(width: 58, alignment: .leading)
                VStack(alignment: .leading, spacing: 3) {
                  Text(deal.nextAction.trimmed.isEmpty ? "Prochaine action à définir" : deal.nextAction)
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .multilineTextAlignment(.leading)
                  Text("\(deal.title) · \(deal.organization)")
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
                }
                Spacer(minLength: 4)
              }
              .padding(13)
              .frame(maxWidth: .infinity, alignment: .leading)
              .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
              .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
            }
            .buttonStyle(.plain)
          }
        }
      }
    }
  }

  private func riskReason(_ deal: Deal) -> String {
    if deal.nextAction.trimmed.isEmpty { return "Action à définir" }
    guard let date = deal.nextActionDate else { return "Date à planifier" }
    return date < Fmt.startOfDay(for: Date())
      ? "En retard · \(Fmt.shortDay(date))"
      : "À surveiller"
  }
}

// MARK: - Queue kinds

private enum QueueKind {
  case intake
  case overdueTask
  case unread
  case followUp
  case planning

  var label: String {
    switch self {
    case .intake: "Demande"
    case .overdueTask: "En retard"
    case .unread: "Non lu"
    case .followUp: "Relance"
    case .planning: "À planifier"
    }
  }

  var foreground: Color {
    switch self {
    case .intake: Theme.blue
    case .overdueTask: Theme.amber
    case .unread: Theme.blueDeep
    case .followUp: Theme.amber
    case .planning: Theme.green
    }
  }

  var background: Color {
    switch self {
    case .intake: Theme.blueSoft
    case .overdueTask: Theme.amberSoft
    case .unread: Theme.blue.opacity(0.12)
    case .followUp: Theme.amberSoft
    case .planning: Theme.greenSoft
    }
  }
}

// MARK: - Stat block

private struct StatBlock: View {
  let title: String
  let value: Int
  let caption: String
  var alert: Bool = false

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.eyebrowFont)
        .kerning(1.1)
        .textCase(.uppercase)
        .foregroundStyle(alert ? Theme.amber : Theme.muted)
      Text("\(value)")
        .font(.display(30, weight: .bold))
        .foregroundStyle(alert ? Theme.amber : Theme.ink)
      Text(caption)
        .font(.system(size: 11.5))
        .foregroundStyle(Theme.muted)
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
    .overlay(
      RoundedRectangle(cornerRadius: 3)
        .strokeBorder(alert ? Theme.amber.opacity(0.45) : Theme.line, lineWidth: 1)
    )
  }
}

// MARK: - Intake sheet

private struct IntakeSheet: View {
  let intake: IntakeSubmission
  let onOpenAccounts: () -> Void

  @Environment(\.dismiss) private var dismiss

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          Card {
            VStack(alignment: .leading, spacing: 8) {
              Eyebrow("Demande entrante")
              Text(intake.organizationName)
                .font(.display(24))
                .foregroundStyle(Theme.ink)
              Text("\(intake.contactName) · \(intake.contactEmail)")
                .font(.system(size: 13))
                .foregroundStyle(Theme.muted)
              if let projectType = intake.projectType {
                Chip(projectType, foreground: Theme.blue, background: Theme.blueSoft)
              }
              Text(intake.message)
                .font(.system(size: 14))
                .foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 4)
              Text("Reçue \(Fmt.relative(intake.createdAt))")
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.muted)
            }
          }
          Card {
            VStack(alignment: .leading, spacing: 6) {
              Eyebrow("Qualification")
              Text("La qualification crée un compte et un contact dans Comptes, avec preuve de provenance et statut courriel « inconnu » par défaut.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            }
          }
          Button {
            dismiss()
            onOpenAccounts()
          } label: {
            Text("Ouvrir Comptes")
              .font(.system(size: 15, weight: .semibold))
              .frame(maxWidth: .infinity)
              .padding(.vertical, 13)
              .background(Theme.blue)
              .foregroundStyle(Theme.ivory)
              .clipShape(RoundedRectangle(cornerRadius: 3))
          }
          .buttonStyle(.plain)
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
      }
      .background(Theme.ivory)
      .navigationTitle("Qualifier")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Fermer") { dismiss() }
        }
      }
    }
  }
}
