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

  private var items: [Attachment] {
    store.attachments.attachments(ownerKind: ownerKind, ownerId: ownerId)
  }

  private var photos: [Attachment] {
    items.filter { $0.mediaKind == .photo }
  }

  private var documents: [Attachment] {
    items.filter { $0.mediaKind == .document }
  }

  var body: some View {
    authenticatedContent
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
      if items.isEmpty {
        Card {
          Text("Aucune pièce jointe. Ajoutez une photo ou un document : il reste sur l'appareil et rejoindra le CRM dès que le serveur sera à jour.")
            .font(.system(size: 13))
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
          .font(.system(size: 12))
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
          addError = "La photo n'a pas pu être enregistrée sur l'appareil."
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
          addError = "Le document n'a pas pu être copié sur l'appareil."
        }
      case .failure:
        break
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
          addError = "La photo n'a pas pu être enregistrée sur l'appareil."
        }
      }
    }
  }

  // MARK: Add row

  private var addRow: some View {
    HStack(spacing: 8) {
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
        .font(.system(size: 12, weight: .semibold))
      Text(title)
        .font(.system(size: 12.5, weight: .semibold))
    }
    .foregroundStyle(Theme.blueDeep)
    .padding(.horizontal, 12)
    .padding(.vertical, 8)
    .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
    .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Theme.blue.opacity(0.3), lineWidth: 1))
  }

  // MARK: Photo grid

  private var photoGrid: some View {
    LazyVGrid(columns: [GridItem(.adaptive(minimum: 84), spacing: 8)], spacing: 8) {
      ForEach(photos) { attachment in
        Button {
          guard store.isCurrentAttachmentSession(sessionContext) else { return }
          viewer = attachment
        } label: {
          Theme.ink.opacity(0.08)
            .aspectRatio(1, contentMode: .fit)
            .overlay {
              AttachmentThumb(attachment: attachment)
                .allowsHitTesting(false)
            }
            .overlay(alignment: .topTrailing) {
              if let label = store.attachments.statusLabel(for: attachment) {
                AttachmentStatusChip(label: label)
                  .padding(5)
              }
            }
            .clipShape(.rect(cornerRadius: 3))
            .overlay(
              RoundedRectangle(cornerRadius: 3)
                .strokeBorder(Theme.line, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
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
          Button {
            guard store.isCurrentAttachmentSession(sessionContext) else { return }
            viewer = attachment
          } label: {
            HStack(spacing: 10) {
              Image(systemName: "doc.fill")
                .font(.system(size: 15))
                .foregroundStyle(Theme.blue)
                .frame(width: 30, height: 30)
                .background(RoundedRectangle(cornerRadius: 3).fill(Theme.blueSoft))
              VStack(alignment: .leading, spacing: 2) {
                Text(attachment.fileName)
                  .font(.system(size: 13.5, weight: .semibold))
                  .foregroundStyle(Theme.ink)
                  .lineLimit(1)
                Text("\(Fmt.shortDay(attachment.createdAt)) · \(AttachmentSectionView.byteLabel(attachment.byteSize))")
                  .font(.system(size: 11))
                  .foregroundStyle(Theme.muted)
              }
              Spacer(minLength: 8)
              if let label = store.attachments.statusLabel(for: attachment) {
                AttachmentStatusChip(label: label)
              }
            }
            .padding(.vertical, 8)
          }
          .buttonStyle(.plain)
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

  var body: some View {
    Text(label)
      .font(.system(size: 9, weight: .heavy))
      .kerning(0.6)
      .textCase(.uppercase)
      .foregroundStyle(Theme.ivory)
      .padding(.horizontal, 6)
      .padding(.vertical, 3)
      .background(Capsule().fill(Theme.amber))
      .accessibilityIdentifier(
        label == "En vérification / fichier bloqué"
          ? "attachment-quarantine-status"
          : "attachment-sync-status"
      )
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

  var body: some View {
    Group {
      if store.isCurrentAttachmentSession(sessionContext) {
        ZStack {
          Color.black.ignoresSafeArea()
          content
          VStack {
            HStack(alignment: .top, spacing: 10) {
              VStack(alignment: .leading, spacing: 2) {
                Text(attachment.fileName)
                  .font(.system(size: 14, weight: .semibold))
                  .foregroundStyle(.white)
                  .lineLimit(1)
                Text(Fmt.longDate(attachment.createdAt))
                  .font(.system(size: 11))
                  .foregroundStyle(.white.opacity(0.6))
              }
              Spacer(minLength: 12)
              Button {
                dismiss()
              } label: {
                Image(systemName: "xmark")
                  .font(.system(size: 15, weight: .semibold))
                  .foregroundStyle(.white)
                  .frame(width: 38, height: 38)
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
      guard store.isCurrentAttachmentSession(sessionContext) else {
        dismiss()
        return
      }
      if attachment.mediaKind == .photo {
        fullImage = store.attachments.data(for: attachment).flatMap(UIImage.init(data:))
      }
    }
    .onChange(of: store.isCurrentAttachmentSession(sessionContext)) { _, isCurrent in
      if !isCurrent {
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
