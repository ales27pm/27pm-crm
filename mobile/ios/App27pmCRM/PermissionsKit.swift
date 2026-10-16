import AVFoundation
import CoreLocation
import Foundation
import Photos
import SwiftUI
import UserNotifications

// MARK: - Capability catalog

enum AppCapability: String, CaseIterable {
  case camera
  case photoLibrary
  case location
  case notifications

  var label: String {
    switch self {
    case .camera: "Caméra"
    case .photoLibrary: "Photothèque"
    case .location: "Position"
    case .notifications: "Notifications"
    }
  }

  var purpose: String {
    switch self {
    case .camera: "Prendre des photos à joindre aux dossiers clients."
    case .photoLibrary: "Choisir des images via le sélecteur système — aucune autorisation n'est requise."
    case .location: "Afficher votre position sur la carte des comptes."
    case .notifications: "Recevoir les rappels quotidiens de suivi."
    }
  }
}

enum PermissionState: String {
  case granted
  case denied
  case notDetermined

  var label: String {
    switch self {
    case .granted: "Accordée"
    case .denied: "Refusée"
    case .notDetermined: "Non demandée"
    }
  }
}

// MARK: - Center

/// Central, honest view of every permission the app can use. Nothing here
/// simulates a state: statuses are read from the system, requests go through
/// the system dialogs, and a refused capability degrades cleanly (the UI
/// shows a proper state instead of blocking or crashing).
final class PermissionsCenter: NSObject, CLLocationManagerDelegate {
  private(set) var states: [AppCapability: PermissionState] = [:]

  private let locationManager = CLLocationManager()

  override init() {
    super.init()
    locationManager.delegate = self
  }

  func refresh() {
    states[.camera] = Self.cameraState()
    states[.location] = Self.locationState(CLLocationManager().authorizationStatus)
    states[.notifications] = .notDetermined
    Task { await refreshNotificationState() }
  }

  private func refreshNotificationState() async {
    let settings = await UNUserNotificationCenter.current().notificationSettings()
    states[.notifications] = Self.notificationState(settings.authorizationStatus)
  }

  // MARK: System status readers

  static func cameraState() -> PermissionState {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: .granted
    case .denied, .restricted: .denied
    default: .notDetermined
    }
  }

  static func locationState(_ status: CLAuthorizationStatus) -> PermissionState {
    switch status {
    case .authorizedWhenInUse, .authorizedAlways: .granted
    case .denied, .restricted: .denied
    default: .notDetermined
    }
  }

  static func notificationState(_ status: UNAuthorizationStatus) -> PermissionState {
    switch status {
    case .authorized, .provisional, .ephemeral: .granted
    case .denied: .denied
    default: .notDetermined
    }
  }

  // MARK: Requests

  @discardableResult
  func requestCamera() async -> Bool {
    let granted = await AVCaptureDevice.requestAccess(for: .video)
    states[.camera] = Self.cameraState()
    return granted
  }

  func requestLocation() {
    locationManager.requestWhenInUseAuthorization()
    states[.location] = Self.locationState(CLLocationManager().authorizationStatus)
  }

  @discardableResult
  func requestNotifications() async -> Bool {
    let granted = (try? await UNUserNotificationCenter.current()
      .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
    states[.notifications] = granted ? .granted : .denied
    return granted
  }

  /// CLLocationManager delegate — authorization can change from Settings
  /// while the app runs, so every change refreshes the snapshot.
  nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    let status = manager.authorizationStatus
    Task { @MainActor in
      states[.location] = Self.locationState(status)
    }
  }
}

// MARK: - Settings deep link

@MainActor
enum SystemSettings {
  static func open() {
    guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
    UIApplication.shared.open(url)
  }
}
