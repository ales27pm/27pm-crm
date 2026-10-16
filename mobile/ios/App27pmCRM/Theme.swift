import SwiftUI
import UIKit

// MARK: - Design tokens (ported from 27pm-crm app/globals.css :root)

enum Theme {
  static let ivory = Color(hex: 0xF4F0E7)
  static let ivoryRaised = Color(hex: 0xFBF8F1)
  static let ink = Color(hex: 0x171714)
  static let muted = Color(hex: 0x65625B)
  static let blue = Color(hex: 0x2846B8)
  static let blueDeep = Color(hex: 0x1D3697)
  static let green = Color(hex: 0x225C3A)
  static let greenSoft = Color(hex: 0xE3F1E8)
  static let amber = Color(hex: 0xB56D2A)
  static let amberSoft = Color(hex: 0xFFF4E7)
  static let rust = Color(hex: 0xA83224)
  static let rustSoft = Color(hex: 0xF9E9E4)

  static var line: Color { ink.opacity(0.16) }
  static var blueSoft: Color { blue.opacity(0.08) }
}

extension Color {
  init(hex: UInt32) {
    self.init(
      red: Double((hex >> 16) & 0xFF) / 255.0,
      green: Double((hex >> 8) & 0xFF) / 255.0,
      blue: Double(hex & 0xFF) / 255.0
    )
  }
}

// MARK: - Typography

extension Font {
  /// Editorial serif display, mirroring the source's Newsreader headings.
  static func display(_ size: CGFloat, weight: Font.Weight = .semibold) -> Font {
    .system(size: size, weight: weight, design: .serif)
  }

  /// Uppercase micro-label used above section titles (`.dt` styles in the source).
  static var eyebrowFont: Font { .system(size: 11, weight: .heavy) }
}

// MARK: - Formatting (fr-CA, America/Montreal — as in the source)

enum Fmt {
  static let montreal = TimeZone(identifier: "America/Montreal") ?? TimeZone.current

  static let calendar: Calendar = {
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = montreal
    return calendar
  }()

  private static let longDateFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "fr_CA")
    formatter.timeZone = montreal
    formatter.dateStyle = .full
    formatter.timeStyle = .none
    return formatter
  }()

  private static let shortDayFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "fr_CA")
    formatter.timeZone = montreal
    formatter.setLocalizedDateFormatFromTemplate("d MMM")
    return formatter
  }()

  private static let clockFormatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "fr_CA")
    formatter.timeZone = montreal
    formatter.timeStyle = .short
    formatter.dateStyle = .none
    return formatter
  }()

  private static let currencyFormatter: NumberFormatter = {
    let formatter = NumberFormatter()
    formatter.locale = Locale(identifier: "fr_CA")
    formatter.numberStyle = .currency
    formatter.currencyCode = "CAD"
    formatter.maximumFractionDigits = 0
    return formatter
  }()

  private static let relativeFormatter: RelativeDateTimeFormatter = {
    let formatter = RelativeDateTimeFormatter()
    formatter.locale = Locale(identifier: "fr_CA")
    formatter.unitsStyle = .abbreviated
    return formatter
  }()

  static func longDate(_ date: Date) -> String {
    longDateFormatter.string(from: date).capitalizingFirstLetter
  }

  static func shortDay(_ date: Date) -> String {
    shortDayFormatter.string(from: date)
  }

  static func clock(_ date: Date) -> String {
    clockFormatter.string(from: date)
  }

  static func relative(_ date: Date, to now: Date = Date()) -> String {
    relativeFormatter.localizedString(for: date, relativeTo: now)
  }

  static func currencyCents(_ cents: Int) -> String {
    currencyFormatter.string(from: NSNumber(value: Double(cents) / 100.0)) ?? "\(cents / 100) $"
  }

  static func budgetRange(minCents: Int, maxCents: Int) -> String {
    "\(currencyCents(minCents)) – \(currencyCents(maxCents))"
  }

  static func startOfDay(for date: Date) -> Date {
    calendar.startOfDay(for: date)
  }
}

extension String {
  var capitalizingFirstLetter: String {
    guard let first = first else { return self }
    return first.uppercased() + dropFirst()
  }

  var trimmed: String {
    trimmingCharacters(in: .whitespacesAndNewlines)
  }
}

// MARK: - Haptics

enum Haptics {
  static func light() {
    UIImpactFeedbackGenerator(style: .light).impactOccurred()
  }

  static func success() {
    UINotificationFeedbackGenerator().notificationOccurred(.success)
  }
}

// MARK: - Shared components

/// Uppercase micro-label (eyebrow) used above section titles.
struct Eyebrow: View {
  let text: String

  init(_ text: String) {
    self.text = text
  }

  var body: some View {
    Text(text)
      .font(.eyebrowFont)
      .kerning(1.2)
      .textCase(.uppercase)
      .foregroundStyle(Theme.muted)
  }
}

/// Section header with eyebrow, serif title and optional pill count.
struct SectionHeader: View {
  let eyebrow: String
  let title: String
  var count: Int?

  var body: some View {
    HStack(alignment: .firstTextBaseline) {
      VStack(alignment: .leading, spacing: 3) {
        Eyebrow(eyebrow)
        Text(title)
          .font(.display(22))
          .foregroundStyle(Theme.ink)
      }
      Spacer(minLength: 8)
      if let count {
        Text("\(count)")
          .font(.display(17, weight: .bold))
          .foregroundStyle(Theme.blue)
          .padding(.horizontal, 12)
          .padding(.vertical, 4)
          .background(Capsule().fill(Theme.blueSoft))
      }
    }
  }
}

/// Raised ivory surface with a hairline border — the source's editorial card.
struct Card<Content: View>: View {
  private let content: Content

  init(@ViewBuilder content: () -> Content) {
    self.content = content()
  }

  var body: some View {
    content
      .padding(14)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(
        RoundedRectangle(cornerRadius: 3)
          .fill(Theme.ivoryRaised)
      )
      .overlay(
        RoundedRectangle(cornerRadius: 3)
          .strokeBorder(Theme.line, lineWidth: 1)
      )
  }
}

/// Rounded pill badge, matching `.outreach-status` / `.today-kind` chips.
struct Chip: View {
  let text: String
  let foreground: Color
  let background: Color

  init(_ text: String, foreground: Color, background: Color) {
    self.text = text
    self.foreground = foreground
    self.background = background
  }

  var body: some View {
    Text(text)
      .font(.system(size: 11, weight: .heavy))
      .kerning(0.8)
      .textCase(.uppercase)
      .foregroundStyle(foreground)
      .padding(.horizontal, 8)
      .padding(.vertical, 4)
      .background(Capsule().fill(background))
      .lineLimit(1)
  }
}

extension View {
  /// Shared chrome for CRM screens: ivory background and hairline nav bar.
  func crmScreenChrome() -> some View {
    self
      .navigationBarTitleDisplayMode(.inline)
      .toolbarBackground(Theme.ivory, for: .navigationBar)
      .toolbarBackground(.visible, for: .navigationBar)
      .background(Theme.ivory)
  }
}
