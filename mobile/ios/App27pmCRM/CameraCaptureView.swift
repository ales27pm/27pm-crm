import AVFoundation
import SwiftUI

// MARK: - Capture manager

/// Real AVFoundation pipeline on every environment — including the cloud
/// simulator's injected external camera. Permission-denied and no-device
/// states are explicit phases; no simulated viewfinder ever replaces the
/// live feed.
final class CameraCaptureManager: NSObject {
  enum Outcome {
    case running
    case unavailable
  }

  let session = AVCaptureSession()
  let photoCapture = PhotoCapture()

  private let sessionQueue = DispatchQueue(label: "org.27pm.crm.camera")

  /// Configures and starts the session off the main thread, then resolves on
  /// the main actor with the setup outcome.
  func start() async -> Outcome {
    await withCheckedContinuation { continuation in
      sessionQueue.async { [session, photoCapture] in
        let outcome = Self.configure(session: session, photoOutput: photoCapture.output)
        if outcome == .running {
          session.startRunning()
        }
        continuation.resume(returning: outcome)
      }
    }
  }

  func stop() {
    sessionQueue.async { [session] in
      session.stopRunning()
    }
  }

  nonisolated private static func configure(
    session: AVCaptureSession,
    photoOutput: AVCapturePhotoOutput
  ) -> Outcome {
    session.beginConfiguration()
    defer { session.commitConfiguration() }
    if session.canSetSessionPreset(.photo) {
      session.sessionPreset = .photo
    }
    guard let camera = bestCamera(),
      let input = try? AVCaptureDeviceInput(device: camera),
      session.canAddInput(input)
    else { return .unavailable }
    session.addInput(input)
    guard session.canAddOutput(photoOutput) else { return .unavailable }
    session.addOutput(photoOutput)
    return .running
  }

  nonisolated private static func bestCamera() -> AVCaptureDevice? {
    // Discovery order is deliberate: built-in cameras come first; the
    // simulator has none, so discovery falls through to the injected
    // external camera.
    AVCaptureDevice.DiscoverySession(
      deviceTypes: [.builtInWideAngleCamera, .external],
      mediaType: .video,
      position: .unspecified
    ).devices.first
  }
}

// MARK: - Still capture

enum CameraCaptureError: Error {
  case busy
  case noCamera
  case noData
}

final class PhotoCapture: NSObject, AVCapturePhotoCaptureDelegate {
  let output = AVCapturePhotoOutput()

  private var continuation: CheckedContinuation<Data, Error>?

  /// One capture at a time — a second tap would replace the pending
  /// continuation and the first caller would never hear back.
  func takePhoto() async throws -> Data {
    try await withCheckedThrowingContinuation { continuation in
      guard self.continuation == nil else {
        continuation.resume(throwing: CameraCaptureError.busy)
        return
      }
      // capturePhoto raises (and kills the app) without an active video
      // connection: permission denied, no camera, or session not running.
      guard let connection = output.connection(with: .video),
        connection.isEnabled,
        connection.isActive
      else {
        continuation.resume(throwing: CameraCaptureError.noCamera)
        return
      }
      self.continuation = continuation
      output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
    }
  }

  nonisolated func photoOutput(
    _ output: AVCapturePhotoOutput,
    didFinishProcessingPhoto photo: AVCapturePhoto,
    error: Error?
  ) {
    // AVCapturePhoto is not Sendable and pixelBuffer is nil for simulator
    // captures — always go through fileDataRepresentation().
    let result: Result<Data, Error>
    if let error {
      result = .failure(error)
    } else if let data = photo.fileDataRepresentation() {
      result = .success(data)
    } else {
      result = .failure(CameraCaptureError.noData)
    }
    Task { @MainActor in
      // Clear before resuming so a capture started from the callback
      // (retake, retry) is not rejected as busy.
      guard let continuation = self.continuation else { return }
      self.continuation = nil
      continuation.resume(with: result)
    }
  }
}

// MARK: - Preview layer

struct CameraPreview: UIViewRepresentable {
  let session: AVCaptureSession

  func makeUIView(context: Context) -> PreviewView {
    let view = PreviewView()
    view.previewLayer.session = session
    view.previewLayer.videoGravity = .resizeAspectFill
    return view
  }

  func updateUIView(_ uiView: PreviewView, context: Context) {}

  /// The preview layer is the view's own layer, so it always matches the
  /// view's bounds.
  final class PreviewView: UIView {
    override class var layerClass: AnyClass {
      AVCaptureVideoPreviewLayer.self
    }

    var previewLayer: AVCaptureVideoPreviewLayer {
      layer as! AVCaptureVideoPreviewLayer
    }
  }
}

// MARK: - View

/// Full-screen capture sheet. `onCapture` receives the JPEG data (nil when
/// the user closes without shooting).
struct CameraCaptureView: View {
  let onCapture: (Data?) -> Void

  @State private var manager = CameraCaptureManager()
  @State private var phase: Phase = .requesting
  @State private var captureError: String?
  @Environment(\.dismiss) private var dismiss

  enum Phase {
    case requesting
    case denied
    case unavailable
    case running
  }

  var body: some View {
    ZStack {
      Color.black.ignoresSafeArea()
      switch phase {
      case .requesting:
        ProgressView().tint(.white)
      case .denied:
        deniedState
      case .unavailable:
        unavailableState
      case .running:
        CameraPreview(session: manager.session)
          .ignoresSafeArea()
          .overlay(alignment: .bottom) { captureControls }
      }
    }
    .task { await start() }
    .onDisappear { manager.stop() }
  }

  private func start() async {
    let status = AVCaptureDevice.authorizationStatus(for: .video)
    var granted = status == .authorized
    if status == .notDetermined {
      granted = await AVCaptureDevice.requestAccess(for: .video)
    }
    guard granted else {
      phase = .denied
      return
    }
    let outcome = await manager.start()
    phase = outcome == .running ? .running : .unavailable
  }

  private func capture() {
    Task {
      do {
        let data = try await manager.photoCapture.takePhoto()
        onCapture(data)
        dismiss()
      } catch CameraCaptureError.busy {
        captureError = "Une capture est déjà en cours."
      } catch CameraCaptureError.noCamera {
        phase = .unavailable
      } catch {
        captureError = "Capture impossible — vérifiez la caméra et réessayez."
      }
    }
  }

  // MARK: Controls

  private var captureControls: some View {
    VStack(spacing: 14) {
      if let captureError {
        Text(captureError)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 14)
          .padding(.vertical, 8)
          .background(Capsule().fill(.black.opacity(0.6)))
      }
      HStack(spacing: 44) {
        Button {
          dismiss()
        } label: {
          Image(systemName: "xmark")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.white)
            .frame(width: 46, height: 46)
            .background(Circle().fill(.white.opacity(0.18)))
        }
        .accessibilityLabel("Fermer la caméra")

        Button {
          capture()
        } label: {
          ZStack {
            Circle().strokeBorder(.white, lineWidth: 4).frame(width: 72, height: 72)
            Circle().fill(.white).frame(width: 58, height: 58)
          }
        }
        .accessibilityLabel("Prendre la photo")

        Color.clear.frame(width: 46, height: 46)
      }
      .padding(.bottom, 34)
    }
    .buttonStyle(.plain)
  }

  // MARK: Refused / unavailable states

  private var deniedState: some View {
    VStack(spacing: 12) {
      Image(systemName: "camera.badge.ellipsis")
        .font(.system(size: 38))
        .foregroundStyle(.white.opacity(0.6))
      Text("Accès à la caméra refusé")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(.white)
      Text("Autorisez la caméra dans Réglages pour photographier les locaux et les documents clients.")
        .font(.system(size: 13))
        .foregroundStyle(.white.opacity(0.7))
        .multilineTextAlignment(.center)
      stateButtons
    }
    .padding(24)
  }

  private var unavailableState: some View {
    VStack(spacing: 12) {
      Image(systemName: "camera.on.rectangle")
        .font(.system(size: 38))
        .foregroundStyle(.white.opacity(0.6))
      Text("Aucune caméra disponible")
        .font(.system(size: 16, weight: .semibold))
        .foregroundStyle(.white)
      Text("Cet appareil n'expose pas de caméra utilisable. Les photos de la photothèque restent disponibles.")
        .font(.system(size: 13))
        .foregroundStyle(.white.opacity(0.7))
        .multilineTextAlignment(.center)
      stateButtons
    }
    .padding(24)
  }

  private var stateButtons: some View {
    VStack(spacing: 10) {
      if phase == .denied {
        Button {
          SystemSettings.open()
        } label: {
          Text("Ouvrir Réglages")
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(.black)
            .padding(.horizontal, 20)
            .padding(.vertical, 11)
            .background(Capsule().fill(.white))
        }
        .buttonStyle(.plain)
      }
      Button {
        onCapture(nil)
        dismiss()
      } label: {
        Text("Fermer")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(.white)
          .padding(.horizontal, 20)
          .padding(.vertical, 11)
          .background(Capsule().strokeBorder(.white.opacity(0.5), lineWidth: 1))
      }
      .buttonStyle(.plain)
    }
    .padding(.top, 6)
  }
}
