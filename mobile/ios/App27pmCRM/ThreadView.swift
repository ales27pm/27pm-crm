import SwiftUI

/// Thread view — messages with delivery states, plus a draft-only reply sheet.
struct ThreadView: View {
  @Environment(CrmStore.self) private var store
  let conversationId: String

  @State private var composePresented = false

  private var conversation: Conversation? { store.conversation(conversationId) }

  var body: some View {
    Group {
      if let conversation {
        ScrollView {
          VStack(alignment: .leading, spacing: 14) {
            headerCard(conversation)
            AttachmentSectionView(ownerKind: .conversation, ownerId: conversation.id)
            ForEach(conversation.messages) { message in
              MessageBubble(message: message)
            }
          }
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 28)
        }
        .crmScreenChrome()
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            Button {
              composePresented = true
            } label: {
              Image(systemName: "square.and.pencil")
                .foregroundStyle(Theme.ink)
            }
            .accessibilityLabel("Rédiger un brouillon de réponse")
          }
        }
        .sheet(isPresented: $composePresented) {
          DraftComposeSheet(conversation: conversation)
        }
        .onAppear { store.markRead(conversationId) }
      } else {
        Text("Conversation introuvable.")
          .font(.system(size: 14))
          .foregroundStyle(Theme.muted)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Theme.ivory)
      }
    }
    .navigationTitle(conversation?.contactName ?? "")
    .navigationBarTitleDisplayMode(.inline)
  }

  private func headerCard(_ conversation: Conversation) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 6) {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
          Text(conversation.subject)
            .font(.display(20))
            .foregroundStyle(Theme.ink)
          Spacer(minLength: 8)
          if conversation.followUp {
            Chip("Relance", foreground: Theme.amber, background: Theme.amberSoft)
          }
        }
        Text("\(conversation.contactName) · \(conversation.organization)")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Theme.blueDeep)
        Text(conversation.mailboxAddress)
          .font(.system(size: 11.5, design: .monospaced))
          .foregroundStyle(Theme.muted)
      }
    }
  }
}

// MARK: - Message bubble

struct MessageBubble: View {
  let message: CrmMessage

  private var isOutbound: Bool { message.direction == .outbound }

  var body: some View {
    HStack(alignment: .bottom, spacing: 0) {
      if isOutbound {
        Spacer(minLength: 30)
      }
      bubble
        .frame(maxWidth: 340, alignment: .leading)
      if !isOutbound {
        Spacer(minLength: 30)
      }
    }
  }

  private var bubble: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline) {
        Text(isOutbound ? message.senderEmail : message.senderName)
          .font(.system(size: 10.5, weight: .heavy))
          .kerning(0.6)
          .textCase(.uppercase)
          .foregroundStyle(isOutbound ? Theme.ivory.opacity(0.8) : Theme.muted)
          .lineLimit(1)
          .minimumScaleFactor(0.7)
        Spacer(minLength: 8)
        Text(Fmt.clock(message.sentAt))
          .font(.system(size: 11))
          .foregroundStyle(isOutbound ? Theme.ivory.opacity(0.7) : Theme.muted)
      }
      Text(message.body)
        .font(.system(size: 14))
        .foregroundStyle(isOutbound ? Theme.ivory : Theme.ink)
        .fixedSize(horizontal: false, vertical: true)
        .textSelection(.enabled)
      if isOutbound {
        deliveryFooter
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 3).fill(isOutbound ? Theme.blue : Theme.ivoryRaised))
    .overlay(
      RoundedRectangle(cornerRadius: 3)
        .strokeBorder(isOutbound ? Color.clear : Theme.line, lineWidth: 1)
    )
  }

  @ViewBuilder
  private var deliveryFooter: some View {
    if message.deliveryState == .draft {
      HStack(spacing: 5) {
        Image(systemName: "pencil.circle.fill")
          .font(.system(size: 11))
        Text("Brouillon local — jamais envoyé")
          .font(.system(size: 10.5, weight: .heavy))
          .kerning(0.4)
          .textCase(.uppercase)
      }
      .foregroundStyle(Theme.ivory.opacity(0.85))
    } else if !message.deliveryEvents.isEmpty {
      HStack(spacing: 10) {
        ForEach(message.deliveryEvents) { event in
          HStack(spacing: 3) {
            Image(systemName: "checkmark")
              .font(.system(size: 9, weight: .bold))
            Text("\(event.state.label) \(Fmt.clock(event.occurredAt))")
              .font(.system(size: 10.5, weight: .semibold))
          }
        }
      }
      .foregroundStyle(Theme.ivory.opacity(0.85))
    }
  }
}

// MARK: - Draft compose sheet

struct DraftComposeSheet: View {
  @Environment(CrmStore.self) private var store
  @Environment(\.dismiss) private var dismiss

  let conversation: Conversation

  @State private var draftBody = ""

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 14) {
          Card {
            VStack(alignment: .leading, spacing: 8) {
              HStack(alignment: .firstTextBaseline, spacing: 8) {
                Eyebrow("À")
                Text("\(conversation.contactName) · \(conversation.contactEmail)")
                  .font(.system(size: 13, weight: .semibold))
                  .foregroundStyle(Theme.ink)
                  .lineLimit(1)
                  .minimumScaleFactor(0.8)
              }
              Rectangle().fill(Theme.line).frame(height: 1)
              Text("Sujet : \(conversation.subject)")
                .font(.system(size: 13.5))
                .foregroundStyle(Theme.ink)
              Text("Depuis \(conversation.mailboxAddress)")
                .font(.system(size: 11.5, design: .monospaced))
                .foregroundStyle(Theme.muted)
            }
          }

          HStack(alignment: .top, spacing: 8) {
            Image(systemName: "info.circle")
              .font(.system(size: 13))
            Text("Aucun envoi depuis l'application : le brouillon reste enregistré localement, conformément au mode démo.")
              .font(.system(size: 12))
              .fixedSize(horizontal: false, vertical: true)
          }
          .foregroundStyle(Theme.amber)
          .padding(12)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(RoundedRectangle(cornerRadius: 3).fill(Theme.amberSoft))

          ZStack(alignment: .topLeading) {
            TextEditor(text: $draftBody)
              .font(.system(size: 14.5))
              .scrollContentBackground(.hidden)
              .frame(minHeight: 180)
              .padding(8)
            if draftBody.isEmpty {
              Text("Votre réponse…")
                .font(.system(size: 14.5))
                .foregroundStyle(Theme.muted.opacity(0.6))
                .padding(.horizontal, 14)
                .padding(.top, 16)
                .allowsHitTesting(false)
            }
          }
          .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
          .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
        }
        .padding(.horizontal, 16)
        .padding(.bottom, 24)
      }
      .background(Theme.ivory)
      .navigationTitle("Répondre")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Annuler") { dismiss() }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Enregistrer le brouillon") {
            store.addDraft(conversationId: conversation.id, body: draftBody.trimmed)
            Haptics.success()
            dismiss()
          }
          .fontWeight(.semibold)
          .disabled(draftBody.trimmed.isEmpty)
        }
      }
    }
  }
}
