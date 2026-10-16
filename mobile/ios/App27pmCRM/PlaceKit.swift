import CoreLocation
import MapKit
import SwiftUI

// MARK: - Geocoding

struct ResolvedPlace: Codable, Equatable {
  let latitude: Double
  let longitude: Double

  var coordinate: CLLocationCoordinate2D {
    CLLocationCoordinate2D(latitude: latitude, longitude: longitude)
  }
}

/// File-backed geocoding cache: one system-geocoder lookup per distinct
/// address string, reused across launches. Addresses come from the account
/// data (server field once deployed, operator-entered local value until
/// then) — nothing is ever hardcoded.
@Observable
@MainActor
final class PlaceIndex {
  private var cache: [String: ResolvedPlace] = [:]
  private var inFlight: [String: UInt64] = [:]
  private let fileURL: URL

  init(directory: URL? = nil) {
    let base = directory ?? OfflineCache.defaultDirectory()
    fileURL = base.appending(path: "geocode-cache.json")
    if let data = try? Data(contentsOf: fileURL),
      let decoded = try? JSONDecoder().decode([String: ResolvedPlace].self, from: data)
    {
      cache = decoded
    }
  }

  func place(
    forKey key: String,
    address: String,
    expectedSessionRevision: UInt64,
    sessionIsCurrent: @escaping @MainActor () -> Bool
  ) async -> ResolvedPlace? {
    guard !Task.isCancelled, sessionIsCurrent() else { return nil }
    if let cached = cache[key] {
      return cached
    }
    // One lookup at a time per address — CLGeocoder rate-limits bursts.
    // A newer authenticated session may supersede an old suspended lookup;
    // permit its own lookup while preventing duplicates within one revision.
    guard inFlight[key] != expectedSessionRevision else { return nil }
    inFlight[key] = expectedSessionRevision
    defer {
      if inFlight[key] == expectedSessionRevision {
        inFlight.removeValue(forKey: key)
      }
    }
    do {
      let placemarks = try await CLGeocoder().geocodeAddressString(address)
      guard !Task.isCancelled, sessionIsCurrent() else { return nil }
      guard let location = placemarks.first?.location else { return nil }
      let resolved = ResolvedPlace(
        latitude: location.coordinate.latitude,
        longitude: location.coordinate.longitude
      )
      cache[key] = resolved
      persist()
      return resolved
    } catch {
      return nil
    }
  }

  private func persist() {
    guard let data = try? JSONEncoder().encode(cache) else { return }
    try? data.write(to: fileURL, options: .atomic)
  }
}

// MARK: - Directions

@MainActor
enum PlaceDirections {
  /// Opens Apple Plans with a driving itinerary to the client.
  static func open(to coordinate: CLLocationCoordinate2D, name: String) {
    let item = MKMapItem(placemark: MKPlacemark(coordinate: coordinate))
    item.name = name
    item.openInMaps(launchOptions: [
      MKLaunchOptionsDirectionsModeKey: MKLaunchOptionsDirectionsModeDriving
    ])
  }
}

// MARK: - Static snapshot (dossier mini-map)

/// Static map tile for the dossier mini-map — a snapshot rather than an
/// interactive map, so scrolling stays smooth and tiles are fetched once per
/// coordinate, then cached in memory.
struct StaticMapSnapshot: View {
  @Environment(CrmStore.self) private var store

  let coordinate: CLLocationCoordinate2D
  var height: CGFloat = 150

  @State private var image: UIImage?

  private static let snapshotCache = NSCache<NSString, UIImage>()

  var body: some View {
    Theme.ink.opacity(0.08)
      .frame(height: height)
      .overlay {
        if let image {
          Image(uiImage: image)
            .resizable()
            .scaledToFill()
            .allowsHitTesting(false)
        } else {
          ProgressView()
        }
      }
      .overlay(
        RoundedRectangle(cornerRadius: 3)
          .strokeBorder(Theme.line, lineWidth: 1)
      )
      .clipShape(.rect(cornerRadius: 3))
      .task(id: "\(coordinate.latitude),\(coordinate.longitude)-\(store.uiSessionRevision)") {
        let expectedSessionRevision = store.uiSessionRevision
        guard store.isCurrentUISessionRevision(expectedSessionRevision) else {
          image = nil
          return
        }
        let resolvedImage = await Self.snapshot(coordinate: coordinate)
        guard !Task.isCancelled,
          store.isCurrentUISessionRevision(expectedSessionRevision)
        else {
          image = nil
          return
        }
        if let resolvedImage {
          Self.snapshotCache.setObject(
            resolvedImage,
            forKey: Self.cacheKey(coordinate) as NSString
          )
        }
        image = resolvedImage
      }
  }

  nonisolated private static func snapshot(coordinate: CLLocationCoordinate2D) async -> UIImage? {
    let key = cacheKey(coordinate) as NSString
    if let cached = snapshotCache.object(forKey: key) {
      return cached
    }
    let options = MKMapSnapshotter.Options()
    options.region = MKCoordinateRegion(
      center: coordinate,
      latitudinalMeters: 700,
      longitudinalMeters: 700
    )
    options.size = CGSize(width: 660, height: 420)
    options.pointOfInterestFilter = .excludingAll
    let snapshotter = MKMapSnapshotter(options: options)
    let snapshot: MKMapSnapshotter.Snapshot? = await withCheckedContinuation { continuation in
      snapshotter.start { snapshot, error in
        continuation.resume(returning: error == nil ? snapshot : nil)
      }
    }
    guard let snapshot else { return nil }
    return drawPin(on: snapshot, coordinate: coordinate)
  }

  nonisolated private static func cacheKey(_ coordinate: CLLocationCoordinate2D) -> String {
    "\(coordinate.latitude),\(coordinate.longitude)"
  }

  nonisolated private static func drawPin(
    on snapshot: MKMapSnapshotter.Snapshot,
    coordinate: CLLocationCoordinate2D
  ) -> UIImage {
    let point = snapshot.point(for: coordinate)
    let image = snapshot.image
    return UIGraphicsImageRenderer(size: image.size).image { context in
      image.draw(at: .zero)
      let rect = CGRect(x: point.x - 10, y: point.y - 10, width: 20, height: 20)
      context.cgContext.setFillColor(UIColor(Theme.blue).cgColor)
      context.cgContext.fillEllipse(in: rect)
      context.cgContext.setStrokeColor(UIColor.white.cgColor)
      context.cgContext.setLineWidth(2.5)
      context.cgContext.strokeEllipse(in: rect.insetBy(dx: 2.5, dy: 2.5))
    }
  }
}

// MARK: - Accounts map (Comptes header)

/// Interactive map with one brand-blue pin per addressed account; pins tap
/// through to the dossier. The operator's position is shown once location is
/// granted — a refusal never blocks the map itself.
struct AccountsMapCard: View {
  @Environment(CrmStore.self) private var store

  @State private var pins: [AccountPin] = []

  struct AccountPin: Identifiable {
    let id: String
    let name: String
    let coordinate: CLLocationCoordinate2D
  }

  var body: some View {
    Card {
      VStack(alignment: .leading, spacing: 10) {
        HStack(alignment: .firstTextBaseline) {
          Eyebrow("Territoire")
          Spacer()
          if !pins.isEmpty {
            Text("\(pins.count) compte\(pins.count == 1 ? "" : "s") localisé\(pins.count == 1 ? "" : "s")")
              .font(.system(size: 11.5, weight: .semibold))
              .foregroundStyle(Theme.muted)
          }
        }
        if pins.isEmpty {
          Text("Aucun compte localisé. Ajoutez une adresse dans un dossier 360° pour l'épingler ici et préparer les visites.")
            .font(.system(size: 12.5))
            .foregroundStyle(Theme.muted)
            .fixedSize(horizontal: false, vertical: true)
        } else {
          map
        }
      }
    }
    .task(id: "\(store.uiSessionRevision)-\(store.data.organizations.count)") {
      await resolvePins(expectedSessionRevision: store.uiSessionRevision)
    }
  }

  private var map: some View {
    Map(position: .constant(.automatic)) {
      UserAnnotation()
      ForEach(pins) { pin in
        Annotation(pin.name, coordinate: pin.coordinate) {
          NavigationLink(value: Route.account(pin.id)) {
            VStack(spacing: 2) {
              Image(systemName: "mappin.circle.fill")
                .font(.system(size: 24))
                .foregroundStyle(Theme.blue)
              Text(pin.name)
                .font(.system(size: 9, weight: .heavy))
                .kerning(0.3)
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(Capsule().fill(Theme.ivoryRaised.opacity(0.92)))
                .lineLimit(1)
            }
          }
          .buttonStyle(.plain)
        }
      }
    }
    .mapStyle(.standard(elevation: .flat))
    .frame(height: 220)
    .clipShape(.rect(cornerRadius: 3))
    .overlay(
      RoundedRectangle(cornerRadius: 3)
        .strokeBorder(Theme.line, lineWidth: 1)
    )
  }

  private func resolvePins(expectedSessionRevision: UInt64) async {
    guard store.isCurrentUISessionRevision(expectedSessionRevision) else {
      pins = []
      return
    }
    var resolved: [AccountPin] = []
    for organization in store.data.organizations {
      guard !Task.isCancelled,
        store.isCurrentUISessionRevision(expectedSessionRevision)
      else { return }
      guard let address = store.address(for: organization) else { continue }
      guard let place = await store.placeIndex.place(
        forKey: address,
        address: address,
        expectedSessionRevision: expectedSessionRevision,
        sessionIsCurrent: {
          store.isCurrentUISessionRevision(expectedSessionRevision)
        }
      ) else { continue }
      resolved.append(
        AccountPin(id: organization.id, name: organization.name, coordinate: place.coordinate)
      )
    }
    guard !Task.isCancelled,
      store.isCurrentUISessionRevision(expectedSessionRevision)
    else { return }
    pins = resolved
  }
}
