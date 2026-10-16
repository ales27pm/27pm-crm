import SwiftUI

/// Réception — mailbox selection, filters and a lazy conversation list.
struct InboxView: View {
  @Environment(CrmStore.self) private var store

  @State private var requestedMailboxAddress: String? = nil
  @State private var filter: InboxFilter = .all
  @State private var search = ""

  private var mailboxAddresses: [String] {
    store.data.mailboxes.map(\.address)
  }

  private var selectedMailboxAddress: String? {
    InboxProjection.selectedMailboxAddress(
      requested: requestedMailboxAddress,
      mailboxes: store.data.mailboxes
    )
  }

  private var conversations: [Conversation] {
    InboxProjection.conversations(
      store.data.conversations,
      mailboxAddress: selectedMailboxAddress,
      filter: filter,
      query: search
    )
  }

  private var isInitialLiveLoad: Bool {
    store.mode == .live
      && store.auth.isAuthenticated
      && store.lastSync == nil
      && store.cachedAt == nil
      && store.syncError == nil
      && store.data.conversations.isEmpty
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 16) {
          MailboxPickerView(
            mailboxes: store.data.mailboxes,
            selectedAddress: selectedMailboxAddress,
            unreadCount: { store.unreadCount(mailbox: $0) },
            onSelect: selectMailbox
          )

          InboxFilterBar(selection: $filter)

          if (store.isSyncing && store.data.conversations.isEmpty) || isInitialLiveLoad {
            InboxLoadingView()
          } else if let syncError = store.syncError, store.data.conversations.isEmpty {
            InboxSyncErrorView(message: syncError) {
              Task { await store.refresh() }
            }
          } else {
            if let syncError = store.syncError {
              InboxSyncErrorView(message: syncError) {
                Task { await store.refresh() }
              }
            }
            if conversations.isEmpty {
              InboxEmptyStateView(
                state: InboxProjection.emptyState(
                  mailboxes: store.data.mailboxes,
                  mailboxAddress: selectedMailboxAddress,
                  filter: filter,
                  query: search
                )
              )
            } else {
              ConversationListView(
                conversations: conversations,
                onToggleRead: toggleRead
              )
            }
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 28)
      }
      .scrollDismissesKeyboard(.interactively)
      .crmScreenChrome()
      .refreshable { await store.refresh() }
      .crmDestinations()
      .navigationTitle("Réception")
      .searchable(
        text: $search,
        placement: .navigationBarDrawer(displayMode: .always),
        prompt: "Contact, courriel, sujet ou message"
      )
      .onAppear(perform: reconcileMailboxSelection)
      .onChange(of: mailboxAddresses) { _, _ in
        reconcileMailboxSelection()
      }
    }
  }

  private func reconcileMailboxSelection() {
    requestedMailboxAddress = InboxProjection.selectedMailboxAddress(
      requested: requestedMailboxAddress,
      mailboxes: store.data.mailboxes
    )
  }

  private func selectMailbox(_ address: String) {
    withAnimation(.snappy) {
      requestedMailboxAddress = address
    }
    Haptics.light()
  }

  private func toggleRead(_ conversation: Conversation) {
    if conversation.unread {
      store.markRead(conversation.id)
    } else {
      store.markUnread(conversation.id)
    }
  }
}

// MARK: - Mailboxes

struct MailboxPickerView: View {
  let mailboxes: [Mailbox]
  let selectedAddress: String?
  let unreadCount: (String) -> Int
  let onSelect: (String) -> Void

  var body: some View {
    if !mailboxes.isEmpty {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 6) {
          ForEach(mailboxes) { mailbox in
            let selected = mailbox.address == selectedAddress
            let unread = unreadCount(mailbox.address)

            Button {
              onSelect(mailbox.address)
            } label: {
              VStack(alignment: .leading, spacing: 2) {
                Text(mailbox.address)
                  .font(.caption.monospaced().weight(.semibold))
                  .lineLimit(1)
                Text(mailboxSummary(mailbox, unread: unread))
                  .font(.caption2)
                  .foregroundStyle(selected ? Theme.ivory.opacity(0.8) : Theme.muted)
                  .lineLimit(1)
              }
              .padding(.horizontal, 12)
              .padding(.vertical, 9)
              .frame(minHeight: 44, alignment: .leading)
              .background(
                RoundedRectangle(cornerRadius: 4)
                  .fill(selected ? Theme.ink : Theme.ivoryRaised)
              )
              .foregroundStyle(selected ? Theme.ivory : Theme.ink)
              .overlay(
                RoundedRectangle(cornerRadius: 4)
                  .strokeBorder(selected ? Color.clear : Theme.line, lineWidth: 1)
              )
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Boîte \(mailbox.address), \(mailbox.label)")
            .accessibilityValue(accessibilityValue(selected: selected, unread: unread))
            .accessibilityAddTraits(selected ? [.isSelected] : [])
          }
        }
      }
      .accessibilityElement(children: .contain)
      .accessibilityLabel("Boîtes courriel")
    }
  }

  private func mailboxSummary(_ mailbox: Mailbox, unread: Int) -> String {
    unread > 0 ? "\(mailbox.label) · \(unread) non lu\(unread > 1 ? "s" : "")" : mailbox.label
  }

  private func accessibilityValue(selected: Bool, unread: Int) -> String {
    let selection = selected ? "Sélectionnée" : "Non sélectionnée"
    let count = unread == 0
      ? "aucun message non lu"
      : "\(unread) message\(unread > 1 ? "s" : "") non lu\(unread > 1 ? "s" : "")"
    return "\(selection), \(count)"
  }
}

// MARK: - Filters

struct InboxFilterBar: View {
  @Binding var selection: InboxFilter

  var body: some View {
    ScrollView(.horizontal, showsIndicators: false) {
      HStack(spacing: 8) {
        ForEach(InboxFilter.allCases) { filter in
          let selected = filter == selection
          Button(filter.rawValue) {
            withAnimation(.snappy) { selection = filter }
            Haptics.light()
          }
          .font(.subheadline.weight(.semibold))
          .padding(.horizontal, 12)
          .frame(minHeight: 44)
          .background(
            RoundedRectangle(cornerRadius: 4)
              .fill(selected ? Theme.ink : Theme.ivoryRaised)
          )
          .foregroundStyle(selected ? Theme.ivory : Theme.ink)
          .overlay(
            RoundedRectangle(cornerRadius: 4)
              .strokeBorder(selected ? Color.clear : Theme.line, lineWidth: 1)
          )
          .buttonStyle(.plain)
          .accessibilityValue(selected ? "Sélectionné" : "Non sélectionné")
          .accessibilityAddTraits(selected ? [.isSelected] : [])
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Filtres de réception")
  }
}

// MARK: - Conversation list

struct ConversationListView: View {
  let conversations: [Conversation]
  let onToggleRead: (Conversation) -> Void

  var body: some View {
    LazyVStack(spacing: 8) {
      ForEach(conversations) { conversation in
        ConversationRow(
          conversation: conversation,
          onToggleRead: { onToggleRead(conversation) }
        )
      }
    }
  }
}

struct ConversationRow: View {
  let conversation: Conversation
  let onToggleRead: () -> Void

  var body: some View {
    NavigationLink(value: Route.conversation(conversation.id)) {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          if conversation.unread {
            Circle()
              .fill(Theme.blue)
              .frame(width: 8, height: 8)
              .accessibilityHidden(true)
          }
          Text(conversation.contactName)
            .font(.headline.weight(conversation.unread ? .bold : .semibold))
            .foregroundStyle(Theme.ink)
            .lineLimit(1)
          Spacer(minLength: 8)
          Text(Fmt.relative(conversation.lastActivity))
            .font(.caption)
            .foregroundStyle(Theme.muted)
        }
        Text(conversation.subject)
          .font(.subheadline.weight(conversation.unread ? .semibold : .regular))
          .foregroundStyle(Theme.ink)
          .lineLimit(2)
        Text(conversation.preview)
          .font(.footnote)
          .foregroundStyle(Theme.muted)
          .lineLimit(2)
          .multilineTextAlignment(.leading)
        HStack(spacing: 8) {
          if !conversation.organization.trimmed.isEmpty {
            Text(conversation.organization)
              .font(.caption.weight(.semibold))
              .foregroundStyle(Theme.blueDeep)
          }
          if conversation.followUp {
            Chip("Relance", foreground: Theme.amber, background: Theme.amberSoft)
              .accessibilityHidden(true)
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
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(accessibilityLabel)
      .accessibilityValue(accessibilityValue)
      .accessibilityHint("Ouvre la conversation")
    }
    .buttonStyle(.plain)
    .simultaneousGesture(TapGesture().onEnded { Haptics.light() })
    .contextMenu {
      toggleReadButton
    }
    .accessibilityAction(named: Text(toggleReadTitle)) {
      onToggleRead()
    }
    .accessibilityIdentifier("inbox-conversation-\(conversation.id)")
  }

  private var toggleReadTitle: String {
    conversation.unread ? "Marquer comme lu" : "Marquer comme non lu"
  }

  private var toggleReadButton: some View {
    Button(toggleReadTitle) {
      onToggleRead()
    }
  }

  private var accessibilityLabel: String {
    [conversation.contactName, conversation.subject, conversation.preview]
      .filter { !$0.trimmed.isEmpty }
      .joined(separator: ", ")
  }

  private var accessibilityValue: String {
    var values = [conversation.unread ? "Non lu" : "Lu"]
    if conversation.followUp { values.append("Relance requise") }
    if !conversation.organization.trimmed.isEmpty { values.append(conversation.organization) }
    values.append(Fmt.relative(conversation.lastActivity))
    return values.joined(separator: ", ")
  }
}

// MARK: - Loading, error and empty states

struct InboxLoadingView: View {
  var body: some View {
    HStack(spacing: 10) {
      ProgressView()
      Text("Chargement des conversations…")
        .font(.body)
        .foregroundStyle(Theme.muted)
    }
    .frame(maxWidth: .infinity, minHeight: 120)
    .accessibilityElement(children: .combine)
  }
}

struct InboxSyncErrorView: View {
  let message: String
  let retry: () -> Void

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        Label("Synchronisation incomplète", systemImage: "exclamationmark.triangle.fill")
          .font(.headline)
          .foregroundStyle(Theme.rust)
        Text(message)
          .font(.body)
          .foregroundStyle(Theme.ink)
        Button("Réessayer", action: retry)
          .buttonStyle(.bordered)
          .accessibilityHint("Relance la synchronisation des conversations")
      }
    }
  }
}

struct InboxEmptyStateView: View {
  let state: InboxEmptyState

  var body: some View {
    ContentUnavailableView {
      Label(state.title, systemImage: "tray")
    } description: {
      Text(state.message)
    }
    .frame(maxWidth: .infinity, minHeight: 180)
    .accessibilityElement(children: .combine)
  }
}
