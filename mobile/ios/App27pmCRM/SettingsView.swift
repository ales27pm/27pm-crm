import SwiftUI

/// Paramètres — transport, boîtes, connexion de l'appareil, conformité et journal.
struct SettingsView: View {
  @Environment(CrmStore.self) private var store
  @Environment(\.dismiss) private var dismiss

  @State private var confirmPurgeCache = false
  @State private var confirmDeleteAttachments = false
  @State private var storageError: String?
  @State private var deleteAttachmentsContext: CrmStore.AttachmentSessionContext?
  @State private var deleteAttachmentIDs: [String] = []

  private var dnclPendingCount: Int {
    store.data.contacts.filter { $0.dnclStatus != "Vérifié" }.count
  }

  private var unknownEmailCount: Int {
    store.data.contacts.filter { !$0.emailReady }.count
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 16) {
          brandCard
          transportCard
          mailboxesCard
          connectionCard
          capabilitiesCard
          remindersCard
          storageCard
          complianceCard
          activityCard
          footer
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 28)
      }
      .background(Theme.ivory)
      .navigationTitle("Paramètres")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarTrailing) {
          Button("Terminé") { dismiss() }
        }
      }
    }
    .presentationDetents([.medium, .large])
    .presentationContentInteraction(.scrolls)
  }

  private var brandCard: some View {
    Card {
      HStack(spacing: 12) {
        Image("BrandCompact")
          .resizable()
          .scaledToFit()
          .frame(height: 46)
        VStack(alignment: .leading, spacing: 2) {
          Text("27PM CRM")
            .font(.display(20))
            .foregroundStyle(Theme.ink)
          Text("CRM privé — réception, comptes, pipeline et suivis.")
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
        }
      }
    }
  }

  private var transportCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 6) {
        Eyebrow("Envoi depuis le CRM")
        HStack(spacing: 8) {
          Circle()
            .fill(transportColor)
            .frame(width: 9, height: 9)
          Text(store.data.transportProvider.settingsTitle(for: store.data.transportState))
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.ink)
        }
        Text(store.data.transportProvider.settingsDescription(for: store.data.transportState))
          .font(.system(size: 12))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private var transportColor: Color {
    switch store.data.transportState {
    case .operational: Theme.green
    case .configuration: Theme.amber
    case .degraded: Theme.rust
    }
  }

  private var mailboxesCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        Eyebrow("Boîtes")
        ForEach(store.data.mailboxes) { mailbox in
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
              Text(mailbox.address)
                .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                .foregroundStyle(Theme.ink)
              Text(mailbox.label)
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.muted)
            }
            Spacer()
            let unread = store.unreadCount(mailbox: mailbox.address)
            if unread > 0 {
              Text("\(unread)")
                .font(.system(size: 12, weight: .bold, design: .serif))
                .foregroundStyle(Theme.ivory)
                .padding(.horizontal, 8)
                .padding(.vertical, 3)
                .background(Capsule().fill(Theme.blue))
            }
          }
        }
      }
    }
  }

  private var connectionCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        Eyebrow("Connexion de l'appareil")
        HStack(spacing: 8) {
          Circle()
            .fill(store.mode == .live ? Theme.green : Theme.amber)
            .frame(width: 9, height: 9)
          Text(store.mode == .live ? "Cet appareil est connecté au CRM" : "Appareil non connecté")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.ink)
          Spacer()
          if store.auth.isAuthenticating {
            ProgressView()
              .scaleEffect(0.7)
          }
        }
        Text(CrmAPIConfig.baseURL?.absoluteString ?? CrmAPIConfig.canonicalOrigin)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(Theme.muted)
        if store.mode == .live {
          if let lastSync = store.lastSync {
            Text("Synchronisé \(Fmt.syncRecency(lastSync))")
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Theme.blue)
          }
          Button {
            Task { await store.signOut() }
          } label: {
            Text("Se déconnecter")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(Theme.rust)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.rust.opacity(0.35), lineWidth: 1))
          }
          .buttonStyle(.plain)
        } else {
          Text("Connectez cet appareil pour remplacer les données de démonstration par le CRM réel. L'appareil est authentifié par code d'autorisation à usage unique (PKCE); aucune identité n'est fabriquée localement.")
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
          Button {
            store.signIn()
          } label: {
            Text("Se connecter à cet appareil")
              .font(.system(size: 13, weight: .semibold))
              .foregroundStyle(Theme.ivory)
              .padding(.vertical, 9)
              .frame(maxWidth: .infinity)
              .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blue))
          }
          .buttonStyle(.plain)
          #if DEBUG
          AuthDiagnosticStrip(diagnostics: AuthDiagnostics.shared)
          #endif
        }
        if let message = store.auth.authError ?? store.syncError {
          HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.triangle")
              .font(.system(size: 12))
            Text(message)
              .font(.system(size: 12))
              .fixedSize(horizontal: false, vertical: true)
          }
          .foregroundStyle(Theme.rust)
        }
      }
    }
  }

  // MARK: Capacités (native capabilities)

  private var capabilitiesCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 12) {
        Eyebrow("Capacités")
        ForEach(AppCapability.allCases, id: \.self) { capability in
          capabilityRow(capability)
        }
      }
    }
    .task { store.permissions.refresh() }
  }

  private func capabilityRow(_ capability: AppCapability) -> some View {
    let state = store.permissions.states[capability]
    return HStack(alignment: .center, spacing: 8) {
      VStack(alignment: .leading, spacing: 1) {
        Text(capability.label)
          .font(.system(size: 13.5, weight: .semibold))
          .foregroundStyle(Theme.ink)
        Text(capability.purpose)
          .font(.system(size: 11))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
      Spacer(minLength: 8)
      if capability == .photoLibrary {
        // PHPicker runs out of process: choosing photos never requires a
        // permission prompt, and the row says so honestly.
        Chip("Sans autorisation", foreground: Theme.muted, background: Theme.ink.opacity(0.06))
      } else if let state {
        Chip(
          state.label,
          foreground: state == .granted ? Theme.green : (state == .denied ? Theme.rust : Theme.muted),
          background: state == .granted ? Theme.greenSoft : (state == .denied ? Theme.rustSoft : Theme.ink.opacity(0.06))
        )
        if state == .denied {
          Button("Réglages") { SystemSettings.open() }
            .font(.system(size: 12, weight: .semibold))
            .foregroundStyle(Theme.blue)
            .buttonStyle(.plain)
        }
      }
    }
  }

  // MARK: Rappels

  private var remindersCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        Eyebrow("Rappels")
        Toggle("Rappel quotidien de suivi", isOn: remindersEnabledBinding)
          .font(.system(size: 13.5, weight: .semibold))
          .tint(Theme.blue)
        if store.reminderSettings.enabled {
          Picker("Heure du rappel", selection: reminderHourBinding) {
            ForEach(6...21, id: \.self) { hour in
              Text(String(format: "%02d:00", hour)).tag(hour)
            }
          }
          .font(.system(size: 13))
        }
        if store.mode != .live {
          Text("Les rappels ne sont planifiés qu'en mode connecté — jamais en démonstration.")
            .font(.system(size: 11.5))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        } else if store.reminders.authorizationDenied {
          Text("Notifications refusées — réactivez-les dans Réglages pour recevoir les rappels.")
            .font(.system(size: 11.5))
            .foregroundStyle(Theme.rust)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
  }

  private var remindersEnabledBinding: Binding<Bool> {
    Binding(
      get: { store.reminderSettings.enabled },
      set: { enabled in
        var settings = store.reminderSettings
        settings.enabled = enabled
        store.updateReminderSettings(settings)
      }
    )
  }

  private var reminderHourBinding: Binding<Int> {
    Binding(
      get: { store.reminderSettings.hour },
      set: { hour in
        var settings = store.reminderSettings
        settings.hour = hour
        store.updateReminderSettings(settings)
      }
    )
  }

  // MARK: Stockage local

  private var storageCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        Eyebrow("Stockage local")
        if store.canAccessAttachments {
          HStack {
            Text("Pièces jointes connues")
              .font(.system(size: 13.5))
              .foregroundStyle(Theme.ink)
            Spacer()
            Text("\(store.attachments.fileCount) · \(AttachmentSectionView.byteLabel(store.attachments.storageBytes)) en local")
              .font(.system(size: 14, weight: .bold, design: .serif))
              .foregroundStyle(Theme.blue)
          }
          HStack {
            Text("Serveur")
              .font(.system(size: 13.5))
              .foregroundStyle(Theme.ink)
            Spacer()
            Text(store.serverSupportsAttachments
              ? "Endpoints confirmés"
              : "Endpoints à venir — rien n'est envoyé")
              .font(.system(size: 11.5, weight: .semibold))
              .foregroundStyle(store.serverSupportsAttachments ? Theme.green : Theme.amber)
          }
          if store.outbox.pendingCount > 0 {
            HStack {
              Text("Opérations en file")
                .font(.system(size: 13.5))
                .foregroundStyle(Theme.ink)
              Spacer()
              Text("\(store.outbox.pendingCount)")
                .font(.system(size: 14, weight: .bold, design: .serif))
                .foregroundStyle(Theme.amber)
            }
          }
        } else {
          Text("Connectez cet appareil pour consulter ou gérer le stockage des pièces jointes CRM.")
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
        HStack(spacing: 8) {
          Button { confirmPurgeCache = true } label: {
            Text("Vider le cache hors-ligne")
              .font(.system(size: 12.5, weight: .semibold))
              .foregroundStyle(Theme.blueDeep)
              .padding(.horizontal, 12)
              .padding(.vertical, 8)
              .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
              .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.blue.opacity(0.3), lineWidth: 1))
          }
          .buttonStyle(.plain)
          if store.canAccessAttachments {
            Button {
              guard let context = store.captureAttachmentSessionContext() else { return }
              deleteAttachmentsContext = context
              deleteAttachmentIDs = store.attachments.attachments.map(\.id)
              confirmDeleteAttachments = true
            } label: {
              Text("Supprimer les pièces jointes connues")
                .font(.system(size: 12.5, weight: .semibold))
                .foregroundStyle(Theme.rust)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.rust.opacity(0.35), lineWidth: 1))
            }
            .buttonStyle(.plain)
            .disabled(store.attachments.fileCount == 0)
          }
        }
        if let storageError {
          Text(storageError)
            .font(.system(size: 12))
            .foregroundStyle(Theme.rust)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .confirmationDialog(
      "Vider le cache hors-ligne ?",
      isPresented: $confirmPurgeCache,
      titleVisibility: .visible
    ) {
      Button("Vider le cache", role: .destructive) {
        store.purgeOfflineCache()
        Haptics.light()
      }
      Button("Annuler", role: .cancel) {}
    } message: {
      Text("Les données seront de nouveau téléchargées au prochain accès réseau.")
    }
    .confirmationDialog(
      "Supprimer les \(deleteAttachmentIDs.count) pièces jointes sélectionnées ?",
      isPresented: $confirmDeleteAttachments,
      titleVisibility: .visible
    ) {
      Button("Supprimer", role: .destructive) {
        guard let context = deleteAttachmentsContext,
          store.isCurrentAttachmentSession(context)
        else {
          confirmDeleteAttachments = false
          deleteAttachmentsContext = nil
          deleteAttachmentIDs = []
          return
        }
        do {
          // Keep the confirmation's exact scope even if a pending collection
          // response discovers additional files while the dialog is open.
          for id in deleteAttachmentIDs {
            if let attachment = store.attachments.attachment(id: id) {
              try store.attachments.delete(attachment)
            }
          }
          store.drainOutboxIfPossible()
          storageError = nil
          Haptics.light()
        } catch {
          storageError = "La suppression n'a pas pu être enregistrée durablement."
        }
        deleteAttachmentsContext = nil
        deleteAttachmentIDs = []
      }
      Button("Annuler", role: .cancel) {
        deleteAttachmentsContext = nil
        deleteAttachmentIDs = []
      }
    } message: {
      Text("Les copies locales seront supprimées et la suppression des fichiers correspondants sur le CRM sera mise en file. Cette action ne vide pas seulement le cache. Les fichiers découverts après l'ouverture de cette confirmation ne sont pas concernés.")
    }
    .onChange(of: store.uiSessionRevision) { _, _ in
      confirmDeleteAttachments = false
      deleteAttachmentsContext = nil
      deleteAttachmentIDs = []
      storageError = nil
    }
  }

  private var complianceCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 8) {
        Eyebrow("Conformité")
        complianceRow(label: "Contacts sourcés", value: store.data.contacts.count, alert: false)
        complianceRow(label: "Preuves DNCL à consigner", value: dnclPendingCount, alert: dnclPendingCount > 0)
        complianceRow(label: "Adresses au statut inconnu", value: unknownEmailCount, alert: unknownEmailCount > 0)
        Text("Une adresse au statut inconnu n'est jamais rendue envoyable par sa simple présence.")
          .font(.system(size: 12))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
  }

  private func complianceRow(label: String, value: Int, alert: Bool) -> some View {
    HStack {
      Text(label)
        .font(.system(size: 13.5))
        .foregroundStyle(Theme.ink)
      Spacer()
      Text("\(value)")
        .font(.system(size: 15, weight: .bold, design: .serif))
        .foregroundStyle(alert ? Theme.amber : Theme.blue)
    }
  }

  private var activityCard: some View {
    Card {
      VStack(alignment: .leading, spacing: 8) {
        Eyebrow("Journal")
        ForEach(Array(store.data.activities.prefix(5))) { activity in
          HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(Fmt.shortDay(activity.createdAt))
              .font(.system(size: 11, weight: .heavy))
              .kerning(0.4)
              .textCase(.uppercase)
              .foregroundStyle(Theme.blue)
              .frame(width: 52, alignment: .leading)
            Text(activity.action)
              .font(.system(size: 12.5))
              .foregroundStyle(Theme.ink)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
    }
  }

  private var footer: some View {
    Text(store.mode == .live
      ? "27PM CRM · données réelles synchronisées · \(versionLabel)"
      : "27PM CRM · \(versionLabel) · bonjour@27pm.org · démonstration hors ligne")
      .font(.system(size: 11))
      .foregroundStyle(Theme.muted.opacity(0.8))
      .frame(maxWidth: .infinity, alignment: .center)
  }

  /// Build provenance from the bundle — for example « v1.0.0 (9) ». No commit SHA: it is
  /// not injected deterministically into the archive.
  private var versionLabel: String {
    let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
    let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "?"
    return "v\(version) (\(build))"
  }
}
