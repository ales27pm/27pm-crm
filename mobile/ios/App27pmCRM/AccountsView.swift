import SwiftUI

/// Comptes — organizations list and the 360° account dossier.
struct AccountsView: View {
  @Environment(CrmStore.self) private var store
  @State private var search = ""

  private var organizations: [Organization] {
    let query = search.trimmed
    guard !query.isEmpty else { return store.data.organizations }
    return store.data.organizations.filter { $0.name.localizedStandardContains(query) }
  }

  var body: some View {
    NavigationStack {
      ScrollView {
        VStack(alignment: .leading, spacing: 12) {
          AccountsMapCard()
          searchField
          ForEach(organizations) { organization in
            NavigationLink(value: Route.account(organization.id)) {
              accountRow(organization)
            }
            .buttonStyle(.plain)
          }
        }
        .padding(.horizontal, 16)
        .padding(.top, 6)
        .padding(.bottom, 28)
      }
      .crmScreenChrome()
      .refreshable { await store.refresh() }
      .crmDestinations()
      .navigationTitle("Comptes")
    }
  }

  private var searchField: some View {
    HStack(spacing: 8) {
      Image(systemName: "magnifyingglass")
        .font(.system(size: 13))
        .foregroundStyle(Theme.muted)
      TextField("Rechercher une entreprise…", text: $search)
        .font(.system(size: 14))
        .autocorrectionDisabled()
    }
    .padding(.horizontal, 12)
    .padding(.vertical, 10)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
  }

  private func accountRow(_ organization: Organization) -> some View {
    HStack(alignment: .top, spacing: 12) {
      VStack(alignment: .leading, spacing: 6) {
        Text(organization.name)
          .font(.display(20))
          .foregroundStyle(Theme.ink)
          .multilineTextAlignment(.leading)
        Chip(organization.priority.shortLabel, foreground: priorityForeground(organization.priority), background: priorityBackground(organization.priority))
        if let nextStep = organization.nextStep, !nextStep.trimmed.isEmpty {
          Text(nextStep)
            .font(.system(size: 12.5))
            .foregroundStyle(Theme.muted)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
        }
        Text("\(store.contacts(organizationId: organization.id).count) contacts · \(store.deals(organizationId: organization.id).count) opportunités")
          .font(.system(size: 11))
          .foregroundStyle(Theme.muted.opacity(0.8))
      }
      Spacer(minLength: 10)
      VStack(alignment: .trailing, spacing: 2) {
        Text("\(organization.score)")
          .font(.display(24, weight: .bold))
          .foregroundStyle(Theme.blue)
        Text("Score")
          .font(.eyebrowFont)
          .kerning(1)
          .textCase(.uppercase)
          .foregroundStyle(Theme.muted)
      }
    }
    .padding(13)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.ivoryRaised))
    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.line, lineWidth: 1))
  }

  private func priorityForeground(_ priority: Priority) -> Color {
    priority == .veryHigh ? Theme.ivory : Theme.blue
  }

  private func priorityBackground(_ priority: Priority) -> Color {
    switch priority {
    case .veryHigh: Theme.blue
    case .high: Theme.blueSoft
    default: Theme.ink.opacity(0.06)
    }
  }
}

// MARK: - Account detail (dossier 360°)

struct AccountDetailView: View {
  @Environment(CrmStore.self) private var store
  let organizationId: String

  @State private var editingAddress = false
  @State private var addressDraft = ""
  @State private var resolvedPlace: ResolvedPlace?
  @State private var smsTarget: ContactSMSTarget?
  @State private var browserURL: URL?
  @State private var commHint: String?

  private var organization: Organization? { store.organization(organizationId) }

  var body: some View {
    Group {
      if let organization {
        ScrollView {
          VStack(alignment: .leading, spacing: 20) {
            headerCard(organization)
            nextStepCard(organization)
            locationCard(organization)
            contactsSection
            attachmentsSection
            strategySection
            dealsSection
            interactionsSection
          }
          .padding(.horizontal, 16)
          .padding(.top, 8)
          .padding(.bottom, 28)
        }
        .crmScreenChrome()
        .toolbar {
          ToolbarItem(placement: .topBarTrailing) {
            dossierMenu(organization)
          }
        }
        .sheet(isPresented: $editingAddress) {
          addressEditSheet(organization)
        }
        .sheet(item: $smsTarget) { target in
          SMSComposerView(recipients: [target.phone], body: "Bonjour \(target.name),\n\n")
        }
        .sheet(
          isPresented: Binding(
            get: { browserURL != nil },
            set: { if !$0 { browserURL = nil } }
          )
        ) {
          if let browserURL {
            InAppBrowserView(url: browserURL)
          }
        }
      } else {
        Text("Compte introuvable.")
          .font(.system(size: 14))
          .foregroundStyle(Theme.muted)
          .frame(maxWidth: .infinity, maxHeight: .infinity)
          .background(Theme.ivory)
      }
    }
    .navigationTitle(organization?.name ?? "")
    .navigationBarTitleDisplayMode(.inline)
  }

  /// Recipient carrier for the system SMS composer.
  private struct ContactSMSTarget: Identifiable {
    let name: String
    let phone: String
    var id: String { phone }
  }

  // MARK: Header

  private func headerCard(_ organization: Organization) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 8) {
        Eyebrow("Dossier 360°")
        Text(organization.name)
          .font(.display(26))
          .foregroundStyle(Theme.ink)
        HStack(spacing: 8) {
          Chip(
            organization.priority.label,
            foreground: organization.priority == .veryHigh ? Theme.ivory : Theme.blue,
            background: organization.priority == .veryHigh ? Theme.blue : Theme.blueSoft
          )
          if organization.budgetIsHypothesis {
            Chip("Hypothèse", foreground: Theme.amber, background: Theme.amberSoft)
          }
        }
        Text("Enveloppe indicative : \(Fmt.budgetRange(minCents: organization.budgetMinCents, maxCents: organization.budgetMaxCents))")
          .font(.system(size: 13.5, weight: .semibold))
          .foregroundStyle(Theme.blueDeep)
        Text(organization.notes)
          .font(.system(size: 12.5))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
        Text(organization.sourceLabel)
          .font(.system(size: 11))
          .foregroundStyle(Theme.muted.opacity(0.75))
      }
    }
  }

  private func nextStepCard(_ organization: Organization) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 6) {
        Eyebrow("Prochaine étape")
        Text(organization.nextStep?.trimmed.isEmpty == false ? organization.nextStep! : "À définir")
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.ink)
          .fixedSize(horizontal: false, vertical: true)
        if let followUp = organization.nextFollowUpAt {
          Text("Suivi du compte prévu le \(Fmt.shortDay(followUp))")
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
        }
      }
    }
  }

  // MARK: Address & map

  private func locationCard(_ organization: Organization) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline) {
          Eyebrow("Adresse")
          Spacer()
          if store.canAccessAttachments {
            Button {
              addressDraft = store.address(for: organization) ?? ""
              editingAddress = true
            } label: {
              Label(store.address(for: organization) == nil ? "Ajouter" : "Modifier", systemImage: "pencil")
                .font(.system(size: 11.5, weight: .semibold))
                .foregroundStyle(Theme.blue)
            }
            .buttonStyle(.plain)
          }
        }
        if let address = store.address(for: organization) {
          Text(address)
            .font(.system(size: 13.5, weight: .semibold))
            .foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
          if let coordinate = resolvedPlace?.coordinate {
            StaticMapSnapshot(coordinate: coordinate)
            Button {
              PlaceDirections.open(to: coordinate, name: organization.name)
            } label: {
              HStack(spacing: 6) {
                Image(systemName: "arrow.triangle.turn.up.right.diamond.fill")
                  .font(.system(size: 12))
                Text("Itinéraire")
                  .font(.system(size: 13, weight: .semibold))
              }
              .foregroundStyle(Theme.ivory)
              .padding(.horizontal, 14)
              .padding(.vertical, 9)
              .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blue))
            }
            .buttonStyle(.plain)
          } else {
            Text("Géolocalisation en cours…")
              .font(.system(size: 12))
              .foregroundStyle(Theme.muted.opacity(0.7))
          }
        } else {
          Text("Aucune adresse enregistrée. Ajoutez-la pour épingler ce compte sur la carte et préparer les visites.")
            .font(.system(size: 12.5))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .task(id: "\(store.uiSessionRevision)-\(store.address(for: organization) ?? "")") {
      let expectedSessionRevision = store.uiSessionRevision
      guard store.isCurrentUISessionRevision(expectedSessionRevision) else {
        resolvedPlace = nil
        return
      }
      guard let address = store.address(for: organization) else {
        resolvedPlace = nil
        return
      }
      let place = await store.placeIndex.place(
        forKey: address,
        address: address,
        expectedSessionRevision: expectedSessionRevision,
        sessionIsCurrent: {
          store.isCurrentUISessionRevision(expectedSessionRevision)
        }
      )
      guard !Task.isCancelled,
        store.isCurrentUISessionRevision(expectedSessionRevision)
      else { return }
      resolvedPlace = place
    }
  }

  private func addressEditSheet(_ organization: Organization) -> some View {
    NavigationStack {
      Form {
        Section("Adresse du compte") {
          TextField("Entrer l'adresse du compte", text: $addressDraft, axis: .vertical)
            .lineLimit(2...4)
        }
        Section {
          Text("Le champ reste local sur cet appareil tant que le serveur n'expose pas l'adresse des comptes. Une fois déployé, la valeur du CRM prime.")
            .font(.system(size: 12))
            .foregroundStyle(Theme.muted)
        }
      }
      .navigationTitle("Adresse")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .topBarLeading) {
          Button("Annuler") { editingAddress = false }
        }
        ToolbarItem(placement: .topBarTrailing) {
          Button("Enregistrer") {
            guard store.canAccessAttachments else {
              editingAddress = false
              return
            }
            store.localFields.setAddress(addressDraft, organizationId: organization.id)
            editingAddress = false
            Haptics.success()
          }
          .fontWeight(.semibold)
        }
      }
    }
    .presentationDetents([.medium])
  }

  // MARK: Attachments

  private var attachmentsSection: some View {
    AttachmentSectionView(ownerKind: .account, ownerId: organizationId)
  }

  // MARK: Dossier actions (print, share)

  private func dossierMenu(_ organization: Organization) -> some View {
    Menu {
      Button {
        DossierPrinter.printDossier(
          html: DossierComposer.html(
            organization: organization,
            contacts: store.contacts(organizationId: organization.id),
            deals: store.deals(organizationId: organization.id),
            address: store.address(for: organization)
          ),
          jobName: "Dossier \(organization.name)"
        )
      } label: {
        Label("Imprimer le dossier", systemImage: "printer")
      }
      ShareLink(
        item: DossierComposer.text(
          organization: organization,
          contacts: store.contacts(organizationId: organization.id),
          deals: store.deals(organizationId: organization.id),
          address: store.address(for: organization)
        )
      ) {
        Label("Partager la fiche", systemImage: "square.and.arrow.up")
      }
    } label: {
      Image(systemName: "ellipsis.circle")
        .foregroundStyle(Theme.ink)
    }
    .accessibilityLabel("Actions du dossier")
  }

  // MARK: Contacts

  private var contactsSection: some View {
    let organizationContacts = store.contacts(organizationId: organizationId)
    return VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "Réseau", title: "Contacts", count: organizationContacts.count)
      if organizationContacts.isEmpty {
        Card {
          Text("Aucun contact sourcé pour ce compte.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      } else {
        if let commHint {
          Text(commHint)
            .font(.system(size: 12))
            .foregroundStyle(Theme.amber)
            .fixedSize(horizontal: false, vertical: true)
        }
        VStack(spacing: 8) {
          ForEach(organizationContacts) { contact in
            contactCard(contact)
          }
        }
      }
    }
  }

  private func contactCard(_ contact: Contact) -> some View {
    Card {
      VStack(alignment: .leading, spacing: 6) {
        Text(contact.name)
          .font(.system(size: 15, weight: .semibold))
          .foregroundStyle(Theme.ink)
        Text(contact.role)
          .font(.system(size: 12.5))
          .foregroundStyle(Theme.muted)
        Text(contact.email)
          .font(.system(size: 12, design: .monospaced))
          .foregroundStyle(Theme.blueDeep)
        if let phone = store.phone(for: contact) {
          Text(phone)
            .font(.system(size: 12, design: .monospaced))
            .foregroundStyle(Theme.blueDeep)
        }
        HStack(spacing: 6) {
          Chip(
            "DNCL \(contact.dnclStatus.lowercased())",
            foreground: contact.dnclStatus == "Vérifié" ? Theme.green : Theme.amber,
            background: contact.dnclStatus == "Vérifié" ? Theme.greenSoft : Theme.amberSoft
          )
          Chip("Courriel : \(contact.emailStatus.lowercased())", foreground: Theme.muted, background: Theme.ink.opacity(0.06))
        }
        if !contact.emailReady {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(contact.emailBlockReasons, id: \.self) { reason in
              Text("• \(reason)")
                .font(.system(size: 11.5))
                .foregroundStyle(Theme.amber)
            }
          }
          .padding(.top, 2)
        }
        Text(contact.source)
          .font(.system(size: 11))
          .foregroundStyle(Theme.muted.opacity(0.75))
          .fixedSize(horizontal: false, vertical: true)
        contactActions(contact)
      }
    }
  }

  // MARK: Contact quick actions (SMS, copy, source)

  private func contactActions(_ contact: Contact) -> some View {
    HStack(spacing: 6) {
      actionButton(symbol: "message.fill", title: "Texto") {
        guard let phone = store.phone(for: contact) else { return }
        guard SMSComposerView.canSendText else {
          commHint = "Les textos ne sont pas disponibles sur cet appareil."
          return
        }
        smsTarget = ContactSMSTarget(name: contact.name, phone: phone)
      }
      actionButton(symbol: "doc.on.doc", title: "Copier courriel") {
        UIPasteboard.general.string = contact.email
        Haptics.light()
      }
      if let phone = store.phone(for: contact) {
        actionButton(symbol: "doc.on.doc", title: "Copier téléphone") {
          UIPasteboard.general.string = phone
          Haptics.light()
        }
      }
      if let urlString = contact.sourceUrl,
        let url = URL(string: urlString),
        url.scheme?.lowercased() == "https"
      {
        actionButton(symbol: "safari", title: "Source") {
          browserURL = url
        }
      }
    }
    .padding(.top, 2)
  }

  private func actionButton(symbol: String, title: String, action: @escaping () -> Void) -> some View {
    Button(action: action) {
      HStack(spacing: 5) {
        Image(systemName: symbol)
          .font(.system(size: 11, weight: .semibold))
        Text(title)
          .font(.system(size: 11.5, weight: .semibold))
      }
      .foregroundStyle(Theme.blueDeep)
      .padding(.horizontal, 10)
      .padding(.vertical, 7)
      .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
      .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.blue.opacity(0.3), lineWidth: 1))
    }
    .buttonStyle(.plain)
  }

  // MARK: Outreach strategy

  @ViewBuilder
  private var strategySection: some View {
    if let strategy = store.strategy(organizationId: organizationId) {
      VStack(alignment: .leading, spacing: 12) {
        HStack(alignment: .firstTextBaseline) {
          SectionHeader(eyebrow: "Sensibilisation", title: "Stratégie")
          Chip(strategy.status.label, foreground: Theme.blue, background: Theme.blueSoft)
        }
        readinessBanner(strategy)
        Card {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(strategy.steps.enumerated()), id: \.element.id) { index, step in
              stepRow(step)
              if index < strategy.steps.count - 1 {
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

  private func readinessBanner(_ strategy: OutreachStrategy) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Rectangle()
        .fill(strategy.emailReady ? Theme.green : Theme.amber)
        .frame(width: 4)
      VStack(alignment: .leading, spacing: 4) {
        Text(strategy.emailReady ? "Prête à contacter" : "Contact bloqué")
          .font(.system(size: 13.5, weight: .heavy))
          .kerning(0.5)
          .textCase(.uppercase)
          .foregroundStyle(strategy.emailReady ? Theme.green : Theme.amber)
        ForEach(strategy.emailBlockReasons, id: \.self) { reason in
          Text("• \(reason)")
            .font(.system(size: 12.5))
            .foregroundStyle(Theme.muted)
        }
      }
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(
      RoundedRectangle(cornerRadius: 3)
        .fill(strategy.emailReady ? Theme.greenSoft : Theme.amberSoft)
    )
  }

  private func stepRow(_ step: OutreachStep) -> some View {
    HStack(alignment: .top, spacing: 10) {
      Text("\(step.sequenceIndex)")
        .font(.display(16, weight: .bold))
        .foregroundStyle(step.status == .done ? Theme.green : Theme.blue)
        .frame(width: 22)
      VStack(alignment: .leading, spacing: 4) {
        HStack(spacing: 6) {
          Image(systemName: step.actionType.symbol)
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.muted)
          Text(step.title)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(Theme.ink)
        }
        Text(step.purpose)
          .font(.system(size: 12))
          .foregroundStyle(Theme.muted)
          .fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 6) {
          Chip(step.actionType.label, foreground: Theme.blueDeep, background: Theme.blueSoft)
          Chip(
            step.status.label,
            foreground: statusForeground(step.status),
            background: statusBackground(step.status)
          )
          Text(Fmt.shortDay(step.scheduledAt))
            .font(.system(size: 11, weight: .semibold))
            .foregroundStyle(Theme.muted)
        }
      }
      Spacer(minLength: 4)
    }
    .padding(.vertical, 10)
  }

  private func statusForeground(_ status: StepStatus) -> Color {
    switch status {
    case .done: Theme.green
    case .blocked: Theme.amber
    case .ready: Theme.blue
    default: Theme.muted
    }
  }

  private func statusBackground(_ status: StepStatus) -> Color {
    switch status {
    case .done: Theme.greenSoft
    case .blocked: Theme.amberSoft
    case .ready: Theme.blueSoft
    default: Theme.ink.opacity(0.06)
    }
  }

  // MARK: Deals & interactions

  private var dealsSection: some View {
    let organizationDeals = store.deals(organizationId: organizationId)
    return VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "Opportunités", title: "Pipeline du compte", count: organizationDeals.count)
      if organizationDeals.isEmpty {
        Card {
          Text("Aucune opportunité ouverte pour ce compte.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      } else {
        VStack(spacing: 8) {
          ForEach(organizationDeals) { deal in
            DealCard(deal: deal, onAdvance: nil)
          }
        }
      }
    }
  }

  private var interactionsSection: some View {
    let allInteractions = store.deals(organizationId: organizationId)
      .flatMap { $0.interactions }
      .sorted { $0.occurredAt > $1.occurredAt }
    return VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "Historique", title: "Interactions", count: allInteractions.count)
      if allInteractions.isEmpty {
        Card {
          Text("Aucune interaction consignée.")
            .font(.system(size: 13))
            .foregroundStyle(Theme.muted)
        }
      } else {
        Card {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(allInteractions.enumerated()), id: \.element.id) { index, interaction in
              InteractionRow(interaction: interaction)
              if index < allInteractions.count - 1 {
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
