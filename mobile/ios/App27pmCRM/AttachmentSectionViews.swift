import PhotosUI
import QuickLook
import SwiftUI
import UIKit
import UniformTypeIdentifiers

// MARK: - Section

/// Shared « Photos et documents » section, used on the account dossier, the
/// deal detail and the conversation thread. Local files and queued operations
/// stay durable across logout, but their names, bytes and actions are exposed
/// only to an authenticated live CRM session.
struct AttachmentSectionView: View {
  @Environment(CrmStore.self) private var store

  let ownerKind: AttachmentOwnerKind
  let ownerId: String

  var body: some View {
    Group {
      if let sessionContext = store.captureAttachmentSessionContext() {
        AuthenticatedAttachmentSectionView(
          ownerKind: ownerKind,
          ownerId: ownerId,
          sessionContext: sessionContext
        )
        // All picker/dialog/viewer @State belongs to this session identity.
        // A logout/new login destroys the old subtree and its callbacks.
        .id(sessionContext)
      } else {
        VStack(alignment: .leading, spacing: 12) {
          SectionHeader(eyebrow: "Pièces jointes", title: "Photos et documents", count: 0)
          Card {
            Text("Connectez cet appareil pour consulter ou ajouter des pièces jointes CRM.")
              .font(.system(size: 13))
              .foregroundStyle(Theme.muted)
              .fixedSize(horizontal: false, vertical: true)
          }
        }
        .accessibilityIdentifier("attachment-session-required")
      }
    }
  }

  static func byteLabel(_ bytes: Int) -> String {
    ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
  }
}

private struct AuthenticatedAttachmentSectionView: View {
  @Environment(CrmStore.self) private var store

  let ownerKind: AttachmentOwnerKind
  let ownerId: String
  let sessionContext: CrmStore.AttachmentSessionContext

  @State private var cameraPresented = false
  @State private var documentPickerPresented = false
  @State private var photoPickerPresented = false
  @State private var photoItem: PhotosPickerItem?
  @State private var viewer: Attachment?
  @State private var pendingDelete: Attachment?
  @State private var addError: String?
  @State private var isRefreshing = false

  private var items: [Attachment] {
    store.attachments.attachments(ownerKind: ownerKind, ownerId: ownerId)
  }

  private var photos: [Attachment] {
    items.filter { $0.mediaKind == .photo }
  }

  private var documents: [Attachment] {
    items.filter { $0.mediaKind == .document }
  }

  private var collectionState: AttachmentCollectionState {
    store.attachmentCollectionState(ownerKind: ownerKind, ownerId: ownerId)
  }

  var body: some View {
    authenticatedContent
    .task(id: "\(ownerKind.rawValue):\(ownerId)") {
      await refreshCollection()
    }
    .onChange(of: store.network.isOnline) { _, isOnline in
      if isOnline { Task { await refreshCollection() } }
    }
    .onChange(of: store.serverSupportsAttachments) { _, supportsAttachments in
      if supportsAttachments { Task { await refreshCollection() } }
    }
    .onChange(of: store.isCurrentAttachmentSession(sessionContext)) { _, isCurrent in
      guard !isCurrent else { return }
      cameraPresented = false
      documentPickerPresented = false
      photoPickerPresented = false
      photoItem = nil
      viewer = nil
      pendingDelete = nil
      addError = nil
    }
  }

  private var authenticatedContent: some View {
    VStack(alignment: .leading, spacing: 12) {
      SectionHeader(eyebrow: "Pièces jointes", title: "Photos et documents", count: items.count)
      collectionStatus
      if items.isEmpty {
        Card {
          Text(emptyMessage)
            .font(.footnote)
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        }
      } else {
        if !photos.isEmpty {
          photoGrid
        }
        if !documents.isEmpty {
          documentRows
        }
      }
      addRow
      if let addError {
        Text(addError)
          .font(.footnote)
          .foregroundStyle(Theme.rust)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .sheet(isPresented: $cameraPresented) {
      CameraCaptureView { data in
        guard let data,
          store.isCurrentAttachmentSession(sessionContext)
        else { return }
        do {
          _ = try store.attachments.addPhoto(data, ownerKind: ownerKind, ownerId: ownerId)
          store.attachmentWasAdded()
          Haptics.success()
        } catch {
          addError = importError(error, fallback: "La photo n'a pas pu être enregistrée sur l'appareil.")
        }
      }
    }
    .fileImporter(
      isPresented: $documentPickerPresented,
      allowedContentTypes: [.item],
      allowsMultipleSelection: false
    ) { result in
      guard store.isCurrentAttachmentSession(sessionContext) else { return }
      switch result {
      case .success(let urls):
        guard let url = urls.first else { return }
        do {
          _ = try store.attachments.addDocument(from: url, ownerKind: ownerKind, ownerId: ownerId)
          store.attachmentWasAdded()
          Haptics.success()
        } catch {
          addError = importError(error, fallback: "Le document n'a pas pu être copié sur l'appareil.")
        }
      case .failure(let error):
        if (error as NSError).code != NSUserCancelledError {
          addError = importError(error, fallback: "Le document n'a pas pu être importé.")
        }
      }
    }
    .fullScreenCover(item: $viewer) { attachment in
      AttachmentViewer(attachment: attachment, sessionContext: sessionContext)
    }
    .confirmationDialog(
      "Supprimer « \(pendingDelete?.fileName ?? "") » ?",
      isPresented: Binding(
        get: { pendingDelete != nil },
        set: {
          if !$0 {
            pendingDelete = nil
          }
        }
      ),
      titleVisibility: .visible
    ) {
      Button("Supprimer", role: .destructive) {
        if let attachment = pendingDelete,
          store.isCurrentAttachmentSession(sessionContext)
        {
          do {
            try store.attachments.delete(attachment)
            store.drainOutboxIfPossible()
            Haptics.light()
          } catch {
            addError = "La suppression n'a pas pu être enregistrée durablement."
          }
        }
        pendingDelete = nil
      }
      Button("Annuler", role: .cancel) {
        pendingDelete = nil
      }
    }
    .onChange(of: photoItem) { _, item in
      guard let item else { return }
      guard store.isCurrentAttachmentSession(sessionContext) else {
        photoItem = nil
        return
      }
      Task { @MainActor in
        defer { photoItem = nil }
        guard store.isCurrentAttachmentSession(sessionContext) else { return }
        let loadedData = try? await item.loadTransferable(type: Data.self)
        guard store.isCurrentAttachmentSession(sessionContext) else { return }
        guard let data = loadedData else {
          addError = "L'image n'a pas pu être lue depuis la photothèque."
          return
        }
        do {
          _ = try store.attachments.addPhoto(data, ownerKind: ownerKind, ownerId: ownerId)
          store.attachmentWasAdded()
          Haptics.success()
        } catch {
          addError = importError(error, fallback: "La photo n'a pas pu être enregistrée sur l'appareil.")
        }
      }
    }
  }

  // MARK: Add row

  private var emptyMessage: String {
    if !store.network.isOnline {
      return "Aucun fichier connu sur cet appareil. La liste du CRM sera vérifiée à la reconnexion."
    }
    if collectionState == .loaded {
      return "Aucune pièce jointe sur ce dossier. Ajoutez une photo ou un document."
    }
    return "Aucun fichier local. La liste du CRM n'est pas encore confirmée. Vous pouvez ajouter un fichier sur cet appareil."
  }

  private var collectionStatus: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !store.network.isOnline {
        Label("Hors ligne · fichiers déjà connus seulement", systemImage: "wifi.slash")
          .foregroundStyle(Theme.muted)
      } else if isRefreshing || collectionState == .loading {
        HStack(spacing: 8) {
          ProgressView()
          Text("Chargement de la liste du CRM…")
        }
        .foregroundStyle(Theme.muted)
      } else if collectionState == .failed {
        Label("Liste du CRM indisponible. Les fichiers déjà connus sont conservés.", systemImage: "exclamationmark.triangle")
          .foregroundStyle(Theme.rust)
      } else if !store.serverSupportsAttachments {
        Label("Transport CRM non confirmé · ajouts conservés sur l'appareil", systemImage: "externaldrive.badge.exclamationmark")
          .foregroundStyle(Theme.muted)
      } else if collectionState == .loaded {
        Label("Liste du CRM à jour · téléchargement sur demande", systemImage: "checkmark.circle")
          .foregroundStyle(Theme.green)
      }
      Button {
        Task { await refreshCollection() }
      } label: {
        Label("Actualiser la liste", systemImage: "arrow.clockwise")
          .frame(minHeight: 44, alignment: .leading)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .foregroundStyle(Theme.blueDeep)
      .disabled(!store.network.isOnline || isRefreshing || collectionState == .loading)
      .accessibilityIdentifier("attachment-refresh-list")
    }
    .font(.footnote)
    .fixedSize(horizontal: false, vertical: true)
    .accessibilityIdentifier("attachment-collection-status")
  }

  @MainActor
  private func refreshCollection() async {
    guard !isRefreshing, store.isCurrentAttachmentSession(sessionContext) else { return }
    isRefreshing = true
    defer { isRefreshing = false }
    await store.refreshRemoteAttachments(ownerKind: ownerKind, ownerId: ownerId, context: sessionContext)
  }

  private func importError(_ error: Error, fallback: String) -> String {
    (error as? LocalizedError)?.errorDescription ?? fallback
  }

  private var addRow: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 140), spacing: 8)], spacing: 8) {
      Button {
        guard store.isCurrentAttachmentSession(sessionContext) else { return }
        photoPickerPresented = true
      } label: {
        addButton(symbol: "photo.on.rectangle", title: "Photothèque")
      }
      .buttonStyle(.plain)
      .photosPicker(
        isPresented: $photoPickerPresented,
        selection: $photoItem,
        matching: .images
      )

      Button {
        guard store.isCurrentAttachmentSession(sessionContext) else { return }
        cameraPresented = true
      } label: {
        addButton(symbol: "camera", title: "Caméra")
      }
      .buttonStyle(.plain)

      Button {
        guard store.isCurrentAttachmentSession(sessionContext) else { return }
        documentPickerPresented = true
      } label: {
        addButton(symbol: "doc", title: "Document")
      }
      .buttonStyle(.plain)
    }
  }

  private func addButton(symbol: String, title: String) -> some View {
    HStack(spacing: 6) {
      Image(systemName: symbol)
        .accessibilityHidden(true)
      Text(title)
        .fixedSize(horizontal: false, vertical: true)
    }
    .font(.footnote.weight(.semibold))
    .foregroundStyle(Theme.blueDeep)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .frame(maxWidth: .infinity, minHeight: 44)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.blue.opacity(0.3), lineWidth: 1))
  }

  // MARK: Photo grid

  private var photoGrid: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 150), spacing: 8)], spacing: 8) {
      ForEach(photos) { attachment in
        VStack(alignment: .leading, spacing: 8) {
          Theme.ink.opacity(0.08)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
              if !isBlocked(attachment), store.attachments.hasLocalCopy(attachment) {
                AttachmentThumb(attachment: attachment)
              } else {
                Image(systemName: isBlocked(attachment) ? "lock.shield" : "photo")
                  .font(.title2)
                  .foregroundStyle(Theme.muted)
              }
            }
            .compositingGroup()
            .clipShape(.rect(cornerRadius: 3))
            .accessibilityHidden(true)
          Text(attachment.fileName)
            .font(.footnote.weight(.semibold))
            .foregroundStyle(Theme.ink)
            .fixedSize(horizontal: false, vertical: true)
          attachmentState(attachment)
          attachmentActions(attachment)
        }
        .contextMenu {
          deleteButton(attachment)
        }
      }
    }
  }

  // MARK: Document rows

  private var documentRows: some View {
    Card {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(documents.enumerated()), id: \.element.id) { index, attachment in
          VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
              Image(systemName: "doc.fill")
                .font(.body)
                .foregroundStyle(Theme.blue)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
                .accessibilityHidden(true)
              VStack(alignment: .leading, spacing: 2) {
                Text(attachment.fileName)
                  .font(.footnote.weight(.semibold))
                  .foregroundStyle(Theme.ink)
                  .fixedSize(horizontal: false, vertical: true)
                Text("\(Fmt.shortDay(attachment.createdAt)) · \(AttachmentSectionView.byteLabel(attachment.byteSize))")
                  .font(.caption)
                  .foregroundStyle(Theme.muted)
              }
            }
            attachmentState(attachment)
            attachmentActions(attachment)
          }
          .padding(.vertical, 8)
          .contextMenu {
            deleteButton(attachment)
          }
          if index < documents.count - 1 {
            Rectangle().fill(Theme.line).frame(height: 1)
          }
        }
      }
    }
  }

  private func isBlocked(_ attachment: Attachment) -> Bool {
    store.attachments.remoteRecord(localId: attachment.id)?.lastErrorCode == "attachment_blocked"
  }

  private func failureCode(_ attachment: Attachment) -> String? {
    if attachment.pendingSync {
      return store.outbox.item(idempotencyKey: "upload-\(attachment.id)")?.lastErrorCode
    }
    return store.attachments.remoteRecord(localId: attachment.id)?.lastErrorCode
  }

  private func canRetry(_ attachment: Attachment) -> Bool {
    guard let code = failureCode(attachment) else { return false }
    // Only known transient/persistence errors offer an explicit retry. Unknown
    // validation, authorization and security decisions never become a bypass.
    let recoverableCodes: Set<String> = [
      "transport_unavailable", "attachment_storage_unavailable", "attachment_transport_disabled",
      "attachment_transport_unavailable", "attachment_chunked_transport_required",
      "attachment_chunk_mismatch", "download_integrity_mismatch", "download_integrity_failed",
      "attachment_ack_persistence_failed", "attachment_state_persistence_failed",
      "outbox_persistence_failed", "attachment_scanner_unavailable", "attachment_unavailable",
      "rate_limited", "service_unavailable", "internal_error"
    ]
    return recoverableCodes.contains(code)
  }

  @ViewBuilder
  private func attachmentState(_ attachment: Attachment) -> some View {
    if let label = store.attachments.statusLabel(for: attachment) {
      AttachmentStatusChip(label: label)
    }
    if isBlocked(attachment) {
      Text("Le contrôle de sécurité a bloqué ce fichier. Aucun aperçu ni téléchargement n'est disponible.")
        .font(.caption)
        .foregroundStyle(Theme.rust)
        .fixedSize(horizontal: false, vertical: true)
    }
  }

  private func attachmentActions(_ attachment: Attachment) -> some View {
    let hasLocalCopy = store.attachments.hasLocalCopy(attachment)
    let record = store.attachments.remoteRecord(localId: attachment.id)
    let downloadPending = !hasLocalCopy && record?.downloadRequested == true && record?.status != .failed
    let actionTitle: String
    if hasLocalCopy {
      actionTitle = "Aperçu local"
    } else if downloadPending {
      actionTitle = "Téléchargement demandé"
    } else if canRetry(attachment) {
      actionTitle = "Réessayer le téléchargement"
    } else {
      actionTitle = "Télécharger"
    }
    return VStack(alignment: .leading, spacing: 0) {
      Button {
        guard store.isCurrentAttachmentSession(sessionContext), !isBlocked(attachment) else { return }
        if store.attachments.hasLocalCopy(attachment) {
          viewer = attachment
        } else {
          do {
            if canRetry(attachment) {
              try store.retryAttachment(attachment, context: sessionContext)
            } else {
              try store.requestAttachmentDownload(attachment, context: sessionContext)
            }
            addError = nil
          } catch {
            addError = importError(error, fallback: "Le téléchargement n'a pas pu être enregistré.")
          }
        }
      } label: {
        Label(
          actionTitle,
          systemImage: hasLocalCopy ? "eye" : "arrow.down.circle"
        )
        .frame(minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
      }
      .disabled(isBlocked(attachment) || downloadPending || (!hasLocalCopy && failureCode(attachment) != nil && !canRetry(attachment)))
      .accessibilityHint(hasLocalCopy ? "Ouvre la copie de cet appareil. Ne confirme pas l'analyse antivirus." : "Enregistre une demande de téléchargement. Le fichier reste fermé pendant la vérification.")
      if hasLocalCopy && canRetry(attachment) {
        Button {
          guard store.isCurrentAttachmentSession(sessionContext) else { return }
          do {
            try store.retryAttachment(attachment, context: sessionContext)
            addError = nil
          } catch {
            addError = importError(error, fallback: "La reprise n'a pas pu être enregistrée.")
          }
        } label: {
          Label("Réessayer la synchronisation", systemImage: "arrow.clockwise")
            .frame(minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
      }
    }
    .font(.footnote.weight(.semibold))
    .foregroundStyle(Theme.blueDeep)
    .buttonStyle(.plain)
    .fixedSize(horizontal: false, vertical: true)
  }

  private func deleteButton(_ attachment: Attachment) -> some View {
    Button(role: .destructive) {
      guard store.isCurrentAttachmentSession(sessionContext) else { return }
      pendingDelete = attachment
    } label: {
      Label("Supprimer", systemImage: "trash")
    }
  }

}

// MARK: - Pieces

struct AttachmentStatusChip: View {
  let label: String

  private var isBlocked: Bool { label == "Fichier bloqué" }
  private var symbol: String {
    if isBlocked { return "lock.shield" }
    if label == "Sur le CRM · non téléchargé" { return "cloud" }
    if ["reprendre", "interrompu", "refusé", "non accepté", "requise"].contains(where: { label.contains($0) }) {
      return "exclamationmark.triangle"
    }
    return "clock"
  }

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 5) {
      Image(systemName: symbol)
        .accessibilityHidden(true)
      Text(label)
        .accessibilityIdentifier(
          isBlocked ? "attachment-blocked-status"
            : (label == "Analyse en attente" ? "attachment-quarantine-status" : "attachment-sync-status")
        )
    }
    .font(.caption.weight(.semibold))
    .foregroundStyle(isBlocked ? Theme.rust : Theme.ink)
    .padding(.horizontal, 8)
    .padding(.vertical, 5)
    .background(RoundedRectangle(cornerRadius: 4).fill(isBlocked ? Theme.rustSoft : Theme.amberSoft))
    .fixedSize(horizontal: false, vertical: true)
  }
}

struct AttachmentThumb: View {
  @Environment(CrmStore.self) private var store
  let attachment: Attachment

  @State private var image: UIImage?

  var body: some View {
    ZStack {
      if let image {
        Image(uiImage: image)
          .resizable()
          .scaledToFill()
      } else {
        Image(systemName: "photo")
          .font(.system(size: 20))
          .foregroundStyle(Theme.muted)
      }
    }
    .task(id: attachment.id) {
      image = store.attachments.image(for: attachment)
    }
  }
}

// MARK: - Full-screen viewer

struct AttachmentViewer: View {
  @Environment(CrmStore.self) private var store
  @Environment(\.dismiss) private var dismiss

  let attachment: Attachment
  let sessionContext: CrmStore.AttachmentSessionContext

  @State private var zoom: CGFloat = 1
  @GestureState private var pinch: CGFloat = 1
  @State private var fullImage: UIImage?

  private var canPreview: Bool {
    store.isCurrentAttachmentSession(sessionContext)
      && store.attachments.hasLocalCopy(attachment)
      && store.attachments.remoteRecord(localId: attachment.id)?.lastErrorCode != "attachment_blocked"
  }

  var body: some View {
    Group {
      if canPreview {
        ZStack {
          Color.black.ignoresSafeArea()
          content
          VStack {
            HStack(alignment: .top, spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(attachment.fileName)
                  .font(.subheadline.weight(.semibold))
                  .foregroundStyle(.white)
                  .lineLimit(2)
                Text("Aperçu local · \(Fmt.longDate(attachment.createdAt))")
                  .font(.caption)
                  .foregroundStyle(.white.opacity(0.85))
                if store.attachments.remoteRecord(localId: attachment.id)?.status != .available {
                  Text("L'analyse antivirus du CRM n'est pas confirmée.")
                    .font(.caption)
                    .foregroundStyle(.white)
                    .fixedSize(horizontal: false, vertical: true)
                }
              }
              Spacer(minLength: 12)
              Button {
                dismiss()
              } label: {
                Image(systemName: "xmark")
                  .font(.system(size: 15, weight: .semibold))
                  .foregroundStyle(.white)
                  .frame(width: 44, height: 44)
                  .background(Circle().fill(.white.opacity(0.18)))
              }
              .accessibilityLabel("Fermer")
            }
            .padding(16)
            Spacer()
          }
        }
      } else {
        Color.black.ignoresSafeArea()
      }
    }
    .task {
      guard canPreview else {
        dismiss()
        return
      }
      if attachment.mediaKind == .photo {
        fullImage = store.attachments.data(for: attachment).flatMap(UIImage.init(data:))
      }
    }
    .onChange(of: canPreview) { _, canPreview in
      if !canPreview {
        fullImage = nil
        dismiss()
      }
    }
  }

  @ViewBuilder
  private var content: some View {
    switch attachment.mediaKind {
    case .photo:
      Group {
        if let fullImage {
          Image(uiImage: fullImage)
            .resizable()
            .scaledToFit()
        } else {
          ProgressView().tint(.white)
        }
      }
      .scaleEffect(zoom * pinch)
      .gesture(
        MagnifyGesture()
          .updating($pinch) { value, state, _ in
            state = value.magnification
          }
          .onEnded { value in
            zoom = min(6, max(1, zoom * value.magnification))
          }
      )
      .onTapGesture(count: 2) {
        withAnimation(.snappy) {
          zoom = zoom > 1 ? 1 : 2.5
        }
      }
    case .document:
      QuickLookPreview(url: store.attachments.fileURL(for: attachment))
        .ignoresSafeArea(edges: .bottom)
    }
  }
}

// MARK: - QuickLook

struct QuickLookPreview: UIViewControllerRepresentable {
  let url: URL

  func makeUIViewController(context: Context) -> QLPreviewController {
    let controller = QLPreviewController()
    controller.dataSource = context.coordinator
    return controller
  }

  func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {}

  func makeCoordinator() -> Coordinator {
    Coordinator(url: url)
  }

  final class Coordinator: NSObject, QLPreviewControllerDataSource {
    let url: URL

    init(url: URL) {
      self.url = url
    }

    func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
      1
    }

    func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
      url as QLPreviewItem
    }
  }
}
