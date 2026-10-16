import SwiftUI

/// Conversation detail. Reply remains deliberately draft-only in this slice.
struct ThreadView: View {
  @Environment(CrmStore.self) private var store
  let conversationId: String

  @State private var composeRoute: DraftComposeRoute?

  private var conversation: Conversation? {
    store.conversation(conversationId)
  }

  var body: some View {
    Group {
      if let conversation {
        ScrollView {
          LazyVStack(alignment: .leading, spacing: 18) {
            ConversationHeaderView(conversation: conversation)
            MessageTimelineView(messages: conversation.messages)
            DossierFilesSection(conversationId: conversation.id)
          }
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 28)
        }
        .crmScreenChrome()
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button("Préparer un brouillon", systemImage: "square.and.pencil") {
              composeRoute = DraftComposeRoute(id: conversation.id)
            }
            .labelStyle(.iconOnly)
            .foregroundStyle(Theme.ink)
            .accessibilityHint("Ouvre un brouillon temporaire qui ne sera pas envoyé")
          }
        }
        .sheet(item: $composeRoute) { route in
          DraftComposerView(conversationId: route.id)
        }
        .onAppear {
          if conversation.unread {
            store.markRead(conversationId)
          }
        }
      } else {
        ContentUnavailableView(
          "Conversation introuvable",
          systemImage: "envelope.badge",
          description: Text("Elle a peut-être été retirée lors de la dernière synchronisation.")
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.ivory)
      }
    }
    .navigationTitle(conversation?.contactName ?? "Conversation")
    .navigationBarTitleDisplayMode(.inline)
  }
}

// MARK: - Header

struct ConversationHeaderView: View {
  let conversation: Conversation

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 8) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(conversation.subject)
            .font(.title3.weight(.semibold))
            .foregroundStyle(Theme.ink)
          Spacer(minLength: 8)
          if conversation.followUp {
            Chip("Relance", foreground: Theme.amber, background: Theme.amberSoft)
          }
        }
        Text(conversation.contactName)
          .font(.headline)
          .foregroundStyle(Theme.blueDeep)
        if !conversation.organization.trimmed.isEmpty {
          Text(conversation.organization)
            .font(.subheadline)
            .foregroundStyle(Theme.muted)
        }
        Label(conversation.mailboxAddress, systemImage: "tray.full")
          .font(.caption.monospaced())
          .foregroundStyle(Theme.muted)
      }
      .accessibilityElement(children: .combine)
      .accessibilityValue(conversation.followUp ? "Relance requise" : "")
    }
  }
}

// MARK: - Message timeline

struct MessageTimelineView: View {
  let messages: [CrmMessage]

  private var orderedMessages: [CrmMessage] {
    messages.sorted { left, right in
      if left.sentAt == right.sentAt { return left.id < right.id }
      return left.sentAt < right.sentAt
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeader(
        eyebrow: "Conversation courriel",
        title: "Messages",
        count: orderedMessages.count
      )
      if orderedMessages.isEmpty {
        Card {
          Text("Aucun message dans cette conversation.")
            .font(.body)
            .foregroundStyle(Theme.muted)
        }
      } else {
        LazyVStack(spacing: 12) {
          ForEach(orderedMessages) { message in
            MessageRow(message: message)
          }
        }
      }
    }
  }
}

struct MessageRow: View {
  let message: CrmMessage

  private var isOutbound: Bool {
    message.direction == .outbound
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      MessageAddressHeader(message: message)

      if message.body.trimmed.isEmpty {
        Text("Aucun contenu texte.")
          .font(.body.italic())
          .foregroundStyle(Theme.muted)
      } else {
        Text(message.body)
          .font(.body)
          .foregroundStyle(Theme.ink)
          .fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled)
      }

      if isOutbound {
        DeliveryHistoryView(
          currentState: message.deliveryState,
          events: message.deliveryEvents
        )
      }
    }
    .padding(14)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 4)
        .fill(isOutbound ? Theme.blueSoft : Theme.ivoryRaised)
    )
    .overlay(alignment: .leading) {
      Rectangle()
        .fill(isOutbound ? Theme.blue : Theme.green)
        .frame(width: 3)
        .accessibilityHidden(true)
    }
    .overlay(
      RoundedRectangle(cornerRadius: 4)
        .strokeBorder(isOutbound ? Theme.blue.opacity(0.25) : Theme.line, lineWidth: 1)
    )
    .padding(.leading, isOutbound ? 28 : 0)
    .padding(.trailing, isOutbound ? 0 : 28)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(isOutbound ? "Message sortant" : "Message reçu")
    .accessibilityIdentifier("mail-message-\(message.id)")
  }
}

struct MessageAddressHeader: View {
  let message: CrmMessage

  private var sender: String {
    let namedSender = message.senderName.trimmed
    let email = message.senderEmail.trimmed
    if namedSender.isEmpty { return email.isEmpty ? "Expéditeur inconnu" : email }
    if email.isEmpty || namedSender.localizedCaseInsensitiveContains(email) {
      return namedSender
    }
    return "\(namedSender) · \(email)"
  }

  private var recipient: String {
    let recipient = message.recipientLabel.trimmed
    return recipient.isEmpty ? "Destinataire non précisé" : recipient
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      LabeledContent("De") {
        Text(sender)
          .multilineTextAlignment(.trailing)
      }
      LabeledContent("À") {
        Text(recipient)
          .multilineTextAlignment(.trailing)
      }
      LabeledContent("Date") {
        Text("\(Fmt.shortDay(message.sentAt)) à \(Fmt.clock(message.sentAt))")
      }
    }
    .font(.caption)
    .foregroundStyle(Theme.muted)
    .accessibilityElement(children: .combine)
  }
}

struct DeliveryHistoryView: View {
  let currentState: DeliveryState
  let events: [DeliveryEvent]

  private var orderedEvents: [DeliveryEvent] {
    events.sorted { left, right in
      if left.occurredAt == right.occurredAt { return left.id < right.id }
      return left.occurredAt < right.occurredAt
    }
  }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text("État de livraison")
        .font(.caption.weight(.semibold))
        .foregroundStyle(Theme.muted)

      DeliveryStatusRow(
        state: currentState,
        occurredAt: nil,
        prefix: "État actuel"
      )

      if !orderedEvents.isEmpty {
        Divider()
        Text("Historique du transport")
          .font(.caption2.weight(.semibold))
          .foregroundStyle(Theme.muted)
        VStack(alignment: .leading, spacing: 6) {
          ForEach(orderedEvents) { event in
            DeliveryStatusRow(
              state: event.state,
              occurredAt: event.occurredAt,
              prefix: nil
            )
          }
        }
      }

      if currentState == .opened {
        Text("Le signal d’ouverture est historique et ne prouve pas qu’une personne a lu le message.")
          .font(.caption2)
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.top, 4)
    .accessibilityElement(children: .contain)
  }
}

struct DeliveryStatusRow: View {
  let state: DeliveryState
  let occurredAt: Date?
  let prefix: String?

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 7) {
      Image(systemName: state.symbolName)
        .font(.caption.weight(.semibold))
        .foregroundStyle(statusColor)
        .accessibilityHidden(true)
      Text(statusLabel)
        .font(.caption.weight(state.isFailure ? .semibold : .regular))
        .foregroundStyle(state.isFailure ? Theme.rust : Theme.ink)
      Spacer(minLength: 8)
      if let occurredAt {
        Text(Fmt.clock(occurredAt))
          .font(.caption2)
          .foregroundStyle(Theme.muted)
      }
    }
    .accessibilityElement(children: .combine)
  }

  private var statusLabel: String {
    [prefix, state.label].compactMap { $0 }.joined(separator: " : ")
  }

  private var statusColor: Color {
    if state.isFailure { return Theme.rust }
    switch state {
    case .unknown, .queued, .draft:
      return Theme.amber
    case .received, .accepted, .sent:
      return Theme.blue
    case .delivered, .opened:
      return Theme.green
    case .temporaryFailure, .permanentFailure, .bounced, .complained:
      return Theme.rust
    }
  }
}

// MARK: - CRM dossier files

struct DossierFilesSection: View {
  let conversationId: String

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      SectionHeader(eyebrow: "Dossier CRM", title: "Fichiers du dossier")
      Text("Ces photos et documents appartiennent au dossier CRM. Ils ne sont pas des pièces jointes aux messages ci-dessus.")
        .font(.footnote)
        .foregroundStyle(Theme.muted)
        .fixedSize(horizontal: false, vertical: true)
      AttachmentSectionView(ownerKind: .conversation, ownerId: conversationId)
    }
    .accessibilityElement(children: .contain)
  }
}

// MARK: - Temporary draft composer

struct DraftComposerView: View {
  @Environment(CrmStore.self) private var store
  @Environment(\.dismiss) private var dismiss

  let conversationId: String

  @State private var draftBody = ""
  @State private var discardConfirmationPresented = false
  @FocusState private var focusedField: Field?

  private enum Field: Hashable {
    case body
  }

  private var conversation: Conversation? {
    store.conversation(conversationId)
  }

  private var hasText: Bool {
    !draftBody.trimmed.isEmpty
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        LazyVStack(alignment: .leading, spacing: 14) {
          if let conversation {
            DraftRecipientSummary(conversation: conversation)
            temporaryDraftNotice
            editor
          } else {
            ContentUnavailableView(
              "Conversation indisponible",
              systemImage: "envelope.badge",
              description: Text("Fermez ce brouillon et actualisez la réception.")
            )
          }
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
      }
      .background(Theme.ivory)
      .navigationTitle("Brouillon temporaire")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Annuler", action: requestDismissal)
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Conserver", action: retainDraftInSession)
            .fontWeight(.semibold)
            .disabled(!hasText || conversation == nil)
            .accessibilityLabel("Conserver le brouillon dans cette session")
        }
      }
      .confirmationDialog(
        "Abandonner ce brouillon temporaire ?",
        isPresented: $discardConfirmationPresented,
        titleVisibility: .visible
      ) {
        Button("Abandonner le brouillon", role: .destructive) {
          dismiss()
        }
        Button("Continuer la rédaction", role: .cancel) {}
      } message: {
        Text("Le texte saisi sera perdu.")
      }
      .interactiveDismissDisabled(hasText)
    }
  }

  private var temporaryDraftNotice: some View {
    Label {
      Text("Ce brouillon est conservé uniquement en mémoire pendant cette ouverture de l’app. Il n’est pas enregistré sur le serveur et ne sera jamais envoyé depuis cet écran.")
        .font(.footnote)
        .fixedSize(horizontal: false, vertical: true)
    } icon: {
      Image(systemName: "info.circle.fill")
        .accessibilityHidden(true)
    }
    .foregroundStyle(Theme.amber)
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.amberSoft))
    .accessibilityElement(children: .combine)
  }

  private var editor: some View {
    ZStack(alignment: .topLeading) {
      TextEditor(text: $draftBody)
        .font(.body)
        .scrollContentBackground(.hidden)
        .frame(minHeight: 220)
        .padding(8)
        .focused($focusedField, equals: .body)
        .defaultFocus($focusedField, .body)
        .accessibilityLabel("Texte du brouillon temporaire")
      if draftBody.isEmpty {
        Text("Votre réponse…")
          .font(.body)
          .foregroundStyle(Theme.muted.opacity(0.7))
          .padding(.horizontal, 14)
          .padding(.top, 16)
          .allowsHitTesting(false)
          .accessibilityHidden(true)
      }
    }
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
  }

  private func requestDismissal() {
    if hasText {
      discardConfirmationPresented = true
    } else {
      dismiss()
    }
  }

  private func retainDraftInSession() {
    guard conversation != nil, hasText else { return }
    store.addDraft(conversationId: conversationId, body: draftBody.trimmed)
    Haptics.success()
    dismiss()
  }
}

struct DraftRecipientSummary: View {
  let conversation: Conversation

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 8) {
        LabeledContent("À") {
          Text("\(conversation.contactName) · \(conversation.contactEmail)")
            .multilineTextAlignment(.trailing)
        }
        Divider()
        LabeledContent("Sujet") {
          Text(conversation.subject)
            .multilineTextAlignment(.trailing)
        }
        LabeledContent("Depuis") {
          Text(conversation.mailboxAddress)
            .font(.caption.monospaced())
        }
      }
      .font(.subheadline)
      .foregroundStyle(Theme.ink)
      .accessibilityElement(children: .combine)
    }
  }
}
