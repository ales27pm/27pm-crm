import SwiftUI

// MARK: - Deal card (pipeline, projects, account dossier)

struct DealCard: View {
  let deal: Deal
  var onAdvance: (() -> Void)?

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      NavigationLink(value: Route.deal(deal.id)) {
        HStack(alignment: .top, spacing: 10) {
          VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
              Text(deal.title)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Theme.ink)
                .multilineTextAlignment(.leading)
              Spacer(minLength: 8)
              Chip(deal.stage.label, foreground: Theme.blue, background: Theme.blueSoft)
            }
            Text("\(deal.organization) · \(deal.contactName)")
              .font(.system(size: 12))
              .foregroundStyle(Theme.muted)
            HStack(spacing: 5) {
              Image(systemName: "arrow.uturn.forward")
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(isOverdue ? Theme.amber : Theme.muted)
              Text(deal.nextAction.trimmed.isEmpty ? "Action à définir" : deal.nextAction)
                .font(.system(size: 12.5))
                .foregroundStyle(isOverdue ? Theme.amber : Theme.ink.opacity(0.75))
                .lineLimit(1)
              if let date = deal.nextActionDate {
                Text("· \(Fmt.shortDay(date))")
                  .font(.system(size: 11.5, weight: .semibold))
                  .foregroundStyle(isOverdue ? Theme.amber : Theme.muted)
              }
            }
          }
        }
        .padding(13)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
          RoundedRectangle(cornerRadius: 3)
            .fill(Theme.ivoryRaised)
        )
        .overlay(
          RoundedRectangle(cornerRadius: 3)
            .strokeBorder(Theme.line, lineWidth: 1)
        )
      }
      .buttonStyle(.plain)

      if let onAdvance, deal.stage.next != nil {
        Button(action: onAdvance) {
          Image(systemName: "chevron.forward.circle.fill")
            .font(.system(size: 26))
            .foregroundStyle(Theme.blue)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Passer à l'étape suivante")
      }
    }
  }

  private var isOverdue: Bool {
    guard let date = deal.nextActionDate, deal.stage != .gagne else { return false }
    return date < Fmt.startOfDay(for: Date())
  }
}

// MARK: - Interaction row

struct InteractionRow: View {
  let interaction: Interaction

  var body: some View {
    HStack(alignment: .top, spacing: 10) {
      Image(systemName: interaction.kind.symbol)
        .font(.system(size: 13, weight: .semibold))
        .foregroundStyle(Theme.blue)
        .frame(width: 26, height: 26)
        .background(Circle().fill(Theme.blueSoft))
      VStack(alignment: .leading, spacing: 3) {
        HStack(alignment: .firstTextBaseline) {
          Text(interaction.kind.label)
            .font(.eyebrowFont)
            .kerning(1)
            .textCase(.uppercase)
            .foregroundStyle(Theme.muted)
          Spacer()
          Text(Fmt.shortDay(interaction.occurredAt))
            .font(.system(size: 11.5, weight: .semibold))
            .foregroundStyle(Theme.muted)
        }
        Text(interaction.summary)
          .font(.system(size: 13.5))
          .foregroundStyle(Theme.ink)
          .fixedSize(horizontal: false, vertical: true)
        Text(interaction.createdBy)
          .font(.system(size: 11))
          .foregroundStyle(Theme.muted.opacity(0.8))
      }
    }
    .padding(.vertical, 6)
  }
}

// MARK: - Empty hint

struct EmptyHint: View {
  let title: String
  let caption: String

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.display(18))
        .foregroundStyle(Theme.ink)
      Text(caption)
        .font(.system(size: 13))
        .foregroundStyle(Theme.muted)
    }
  }
}
