import SwiftUI

/// Réception — mailbox rail, filters and conversation list.
struct InboxView: View {
  @Environment(CrmStore.self) private var store

  @State private var mailboxAddress = "bonjour@27pm.org"
  @State private var filter: InboxFilter = .all
  @State private var search = ""

  enum InboxFilter: String, CaseIterable, Identifiable {
    case all = "Tous"
    case unread = "Non lus"
    case followUp = "Relances"

    var id: String { rawValue }
  }

  private var filtered: [Conversation] {
    store.data.conversations
      .filter { $0.mailboxAddress == mailboxAddress }
      .filter { conversation in
        switch filter {
        case .all: true
        case .unread: conversation.unread
        case .followUp: conversation.followUp
        }
      }
      .filter { conversation in
        let query = search.trimmed
        guard !query.isEmpty else { return true }
        return conversation.contactName.localizedStandardContains(query)
          || conversation.organization.localizedStandardContains(query)
          || conversation.subject.localizedStandardContains(query)
      }
      .sorted { $0.lastActivity > $1.lastActivity }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          mailboxPicker
          filterRow
          if filtered.isEmpty {
            Card {
              Text("Aucune conversation ne correspond à ces filtres.")
                .font(.system(size: 13))
                .foregroundStyle(Theme.muted)
            }
          } else {
            VStack(spacing: 8) {
              ForEach(filtered) { conversation in
                conversationRow(conversation)
              }
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 28)
      }
      .crmScreenChrome()
      .refreshable { await store.refresh() }
      .crmDestinations()
      .navigationTitle("Réception")
    }
  }

  // MARK: Mailbox picker

  private var mailboxPicker: some View {
    HStack(spacing: 4) {
      ForEach(store.data.mailboxes) { mailbox in
        let selected = mailbox.address == mailboxAddress
        Button {
          withAnimation(.snappy) { mailboxAddress = mailbox.address }
          Haptics.light()
        } label: {
          VStack(spacing: 2) {
            Text(mailbox.address)
              .font(.system(size: 11.5, weight: .semibold, design: .monospaced))
              .lineLimit(1)
              .minimumScaleFactor(0.6)
            HStack(spacing: 3) {
              Text(mailbox.label)
              let unread = store.unreadCount(mailbox: mailbox.address)
              if unread > 0 {
                Text("· \(unread)")
                  .fontWeight(.bold)
              }
            }
            .font(.system(size: 10))
            .foregroundStyle(selected ? Theme.ivory.opacity(0.75) : Theme.muted)
            .lineLimit(1)
          }
          .padding(.vertical, 8)
          .frame(maxWidth: .infinity)
          .background(RoundedRectangle(cornerRadius: 3).fill(selected ? Theme.ink : Color.clear))
          .foregroundStyle(selected ? Theme.ivory : Theme.ink)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Boîte \(mailbox.address)")
      }
    }
    .padding(4)
    .background(RoundedRectangle(cornerRadius: 4).fill(Theme.ivoryRaised))
    .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Theme.line, lineWidth: 1))
  }

  // MARK: Filters

  private var filterRow: some View {
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 8) {
        ForEach(InboxFilter.allCases) { filterCase in
          let selected = filterCase == filter
          Button {
            withAnimation(.snappy) { filter = filterCase }
            Haptics.light()
          } label: {
            Text(filterCase.rawValue)
              .font(.system(size: 12, weight: .semibold))
              .padding(.horizontal, 12)
              .padding(.vertical, 6)
              .background(Capsule().fill(selected ? Theme.ink : Theme.ivoryRaised))
              .foregroundStyle(selected ? Theme.ivory : Theme.ink)
              .overlay(
                Capsule().strokeBorder(selected ? Color.clear : Theme.line, lineWidth: 1)
              )
          }
          .buttonStyle(.plain)
        }
        Spacer()
      }
      searchField
    }
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13))
        .foregroundStyle(Theme.muted)
      TextField("Rechercher un contact, un sujet…", text: $search)
        .font(.system(size: 14))
        .autocorrectionDisabled()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
  }

  // MARK: Rows

  private func conversationRow(_ conversation: Conversation) -> some View {
    NavigationLink(value: Route.conversation(conversation.id)) {
      VStack(alignment: .leading, spacing: 5) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          if conversation.unread {
            Circle()
              .fill(Theme.blue)
              .frame(width: 7, height: 7)
          }
          Text(conversation.contactName)
            .font(.system(size: 14.5, weight: conversation.unread ? .bold : .semibold))
            .foregroundStyle(Theme.ink)
            .lineLimit(1)
          Spacer(minLength: 8)
          Text(Fmt.relative(conversation.lastActivity))
            .font(.system(size: 11.5))
            .foregroundStyle(Theme.muted)
        }
        Text(conversation.subject)
          .font(.system(size: 13.5, weight: conversation.unread ? .semibold : .regular))
          .foregroundStyle(Theme.ink)
          .lineLimit(1)
        Text(conversation.preview)
          .font(.system(size: 12.5))
          .foregroundStyle(Theme.muted)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
        HStack(spacing: 8) {
          Text(conversation.organization)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.blueDeep)
          if conversation.followUp {
            Chip("Relance", foreground: Theme.amber, background: Theme.amberSoft)
          }
        }
      }
      .padding(13)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
      .overlay(
        RoundedRectangle(cornerRadius: 3)
          .strokeBorder(conversation.unread ? Theme.blue.opacity(0.35) : Theme.line, lineWidth: 1)
      )
    }
    .buttonStyle(.plain)
    .simultaneousGesture(TapGesture().onEnded { Haptics.light() })
    .contextMenu {
      Button(conversation.unread ? "Marquer comme lu" : "Marquer comme non lu") {
        if conversation.unread {
          store.markRead(conversation.id)
        } else {
          store.markUnread(conversation.id)
        }
      }
    }
  }
}
