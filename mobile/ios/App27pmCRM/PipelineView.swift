import SwiftUI

/// Pipeline et Projets — stage board and per-project-type overview.
struct PipelineView: View {
  @Environment(CrmStore.self) private var store

  @State private var mode: Mode = .pipeline

  enum Mode: String, CaseIterable, Identifiable {
    case pipeline = "Pipeline"
    case projects = "Projets"

    var id: String { rawValue }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 18) {
          Picker("Vue", selection: $mode) {
            ForEach(Mode.allCases) { modeCase in
              Text(modeCase.rawValue)
                .tag(modeCase)
            }
          }
          .pickerStyle(.segmented)

          if mode == .pipeline {
            pipelineBoard
          } else {
            projectsBoard
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 28)
      }
      .crmScreenChrome()
      .refreshable { await store.refresh() }
      .crmDestinations()
      .navigationTitle("Pipeline")
    }
  }

  // MARK: Stage board

  private var pipelineBoard: some View {
    VStack(alignment: .leading, spacing: 20) {
      ForEach(PipelineStage.allCases, id: \.self) { stage in
        let stageDeals = store.data.deals.filter { $0.stage == stage }
        VStack(alignment: .leading, spacing: 10) {
          SectionHeader(eyebrow: sectionEyebrow(stage), title: stage.label, count: stageDeals.count)
          if stageDeals.isEmpty {
            Text("Aucune opportunité à cette étape.")
              .font(.system(size: 12.5))
              .foregroundStyle(Theme.muted)
          } else {
            VStack(spacing: 8) {
              ForEach(stageDeals) { deal in
                DealCard(deal: deal) {
                  guard let next = deal.stage.next else { return }
                  withAnimation(.snappy) {
                    store.setStage(next, dealId: deal.id)
                  }
                  Haptics.success()
                }
              }
            }
          }
        }
      }
    }
  }

  private func sectionEyebrow(_ stage: PipelineStage) -> String {
    switch stage {
    case .nouveau: "Entrée"
    case .qualifie: "Validation"
    case .proposition: "Décision"
    case .production: "Exécution"
    case .gagne: "Fermé"
    }
  }

  // MARK: Projects

  private var projectsBoard: some View {
    VStack(alignment: .leading, spacing: 20) {
      ForEach(ProjectType.allCases, id: \.self) { projectType in
        let typedDeals = store.data.deals.filter { $0.projectType == projectType }
        VStack(alignment: .leading, spacing: 10) {
          SectionHeader(eyebrow: "Projets", title: projectType.rawValue, count: typedDeals.count)
          if typedDeals.isEmpty {
            Text("Aucun projet de ce type.")
              .font(.system(size: 12.5))
              .foregroundStyle(Theme.muted)
          } else {
            VStack(spacing: 8) {
              ForEach(typedDeals) { deal in
                DealCard(deal: deal, onAdvance: nil)
              }
            }
          }
        }
      }
    }
  }
}

// MARK: - Deal detail

struct DealDetailView: View {
  @Environment(CrmStore.self) private var store
  let dealId: String

  private var deal: Deal? { store.deal(dealId) }

  var body: some View {
    Group {
      if let deal {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            headerCard(deal)
            stageCard(deal)
            nextActionCard(deal)
            noteCard(deal)
            AttachmentSectionView(ownerKind: .deal, ownerId: deal.id)
            interactionsSection(deal)
          }
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 28)
        }
        .crmScreenChrome()
      } else {
        Text("Opportunité introuvable.")
          .font(.system(size: 14))
          .foregroundStyle(Theme.muted)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Theme.ivory)
      }
    }
    .navigationTitle(deal?.title ?? "")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func headerCard(_ deal: Deal) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 6) {
        Eyebrow("Opportunité")
        Text(deal.title)
          .font(.display(24))
          .foregroundStyle(Theme.ink)
        Text("\(deal.organization) · \(deal.projectType.rawValue)")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Theme.blueDeep)
        Text("Contact : \(deal.contactName)")
          .font(.system(size: 12.5))
          .foregroundStyle(Theme.muted)
      }
    }
  }

  // MARK: Stage

  private func stageCard(_ deal: Deal) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        Eyebrow("Étape")
        HStack(spacing: 4) {
          ForEach(PipelineStage.allCases, id: \.self) { stage in
            RoundedRectangle(cornerRadius: 2)
              .fill(fill(for: stage, current: deal.stage))
              .frame(height: 5)
          }
        }
        HStack(alignment: .center) {
          Text(deal.stage.label)
            .font(.system(size: 15, weight: .bold))
            .foregroundStyle(Theme.ink)
          Spacer()
          if let previous = deal.stage.previous {
            Button {
              withAnimation(.snappy) { store.setStage(previous, dealId: deal.id) }
              Haptics.light()
            } label: {
              Image(systemName: "chevron.left")
                .font(.system(size: 13, weight: .bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(Theme.muted)
            .accessibilityLabel("Reculer à \(previous.label)")
          }
          if let next = deal.stage.next {
            Button {
              withAnimation(.snappy) { store.setStage(next, dealId: deal.id) }
              Haptics.success()
            } label: {
              HStack(spacing: 5) {
                Text(next.label)
                  .font(.system(size: 13, weight: .semibold))
                Image(systemName: "chevron.right")
                  .font(.system(size: 11, weight: .bold))
              }
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blue))
              .foregroundStyle(Theme.ivory)
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Avancer à \(next.label)")
          }
        }
      }
    }
  }

  private func fill(for stage: PipelineStage, current: PipelineStage) -> Color {
    guard let currentIndex = PipelineStage.allCases.firstIndex(of: current),
      let stageIndex = PipelineStage.allCases.firstIndex(of: stage)
    else { return Theme.line }
    if stageIndex < currentIndex { return Theme.ink.opacity(0.3) }
    if stageIndex == currentIndex { return Theme.blue }
    return Theme.line
  }

  // MARK: Next action

  private func nextActionCard(_ deal: Deal) -> some View {
    let isOverdue = deal.nextActionDate.map { $0 < Fmt.startOfDay(for: Date()) } ?? false
    return Card {
      VStack(alignment: .leading, spacing: 8) {
        Eyebrow("Prochaine action")
        Text(deal.nextAction.trimmed.isEmpty ? "Action à définir" : deal.nextAction)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(deal.nextAction.trimmed.isEmpty ? Theme.amber : Theme.ink)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 8) {
          if let date = deal.nextActionDate {
            Image(systemName: "calendar")
              .font(.system(size: 12))
              .foregroundStyle(isOverdue ? Theme.amber : Theme.muted)
            Text(Fmt.longDate(date))
              .font(.system(size: 12.5, weight: .semibold))
              .foregroundStyle(isOverdue ? Theme.amber : Theme.muted)
            if isOverdue {
              Chip("En retard", foreground: Theme.amber, background: Theme.amberSoft)
            }
          } else {
            Text("Aucune date planifiée")
              .font(.system(size: 12.5))
              .foregroundStyle(Theme.amber)
          }
        }
        Button {
          withAnimation(.snappy) { store.snoozeDeal(deal.id) }
          Haptics.light()
        } label: {
          HStack(spacing: 6) {
            Image(systemName: "calendar.badge.clock")
              .font(.system(size: 12))
            Text("Reporter de 3 jours")
              .font(.system(size: 13, weight: .semibold))
          }
          .foregroundStyle(Theme.blueDeep)
          .padding(.horizontal, 12)
          .padding(.vertical, 8)
          .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
          .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.blue.opacity(0.3), lineWidth: 1))
        }
        .buttonStyle(.plain)
      }
    }
  }

  private func noteCard(_ deal: Deal) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 6) {
        Eyebrow("Notes")
        Text(deal.note)
          .font(.system(size: 13))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func interactionsSection(_ deal: Deal) -> some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "Historique", title: "Interactions", count: deal.interactions.count)
      if deal.interactions.isEmpty {
        Card {
          Text("Aucune interaction consignée pour cette opportunité.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      } else {
        Card {
          VStack(alignment: .leading, spacing: 0) {
            let sorted = deal.interactions.sorted { $0.occurredAt > $1.occurredAt }
            ForEach(Array(sorted.enumerated()), id: \.element.id) { index, interaction in
              InteractionRow(interaction: interaction)
              if index < sorted.count - 1 {
                Rectangle()
                  .fill(Theme.line)
                  .frame(height: 1)
              }
            }
          }
        }
      }
    }
  }
}
