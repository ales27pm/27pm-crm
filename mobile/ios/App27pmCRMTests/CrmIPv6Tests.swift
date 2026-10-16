import Foundation
import Network
import Testing
@testable import App27pmCRM

/// IPv6-only (DNS64/NAT64) hardening proofs: the app contacts the single
/// canonical DNS name through system networking APIs only — never an IP
/// literal, never a subdomain like api.crm.27pm.org, never its own resolver.
@Suite struct CrmIPv6HardeningTests {
  private let canonical = CrmAPIConfig.canonicalOriginURL

  /// A DNS name must not parse as an IP literal (the positive-control test
  /// proves the parsers actually recognize literal addresses).
  private func assertDNSName(_ host: String?, sourceLocation: SourceLocation = #_sourceLocation) {
    guard let host else {
      Issue.record("Hôte absent", sourceLocation: sourceLocation)
      return
    }
    #expect(IPv4Address(host) == nil, "L'hôte \(host) est un littéral IPv4", sourceLocation: sourceLocation)
    #expect(IPv6Address(host) == nil, "L'hôte \(host) est un littéral IPv6", sourceLocation: sourceLocation)
  }

  /// Positive controls: the parsers really detect IP literals, so the
  /// DNS-name assertions above are meaningful.
  @Test func ipLiteralParsersDetectActualLiterals() {
    #expect(IPv4Address("192.0.2.10") != nil)
    #expect(IPv6Address("2001:db8::1") != nil)
    #expect(IPv4Address("crm.27pm.org") == nil)
    #expect(IPv6Address("crm.27pm.org") == nil)
  }

  @Test func canonicalOriginIsDNSNameOverHTTPS() {
    assertDNSName(canonical.host)
    #expect(canonical.scheme == "https")
    #expect(canonical.host == "crm.27pm.org")
    #expect(canonical.port == nil)
  }

  /// The allowlist itself rejects IP literals — IPv4, IPv6, with or without
  /// port — in addition to every other deviation from the exact origin.
  @Test func allowlistRejectsIPLiteralOverrides() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://192.0.2.10") == nil)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://[2001:db8::1]") == nil)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://192.0.2.10:8443") == nil)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "http://[2001:db8::1]") == nil)
  }

  /// Every derived endpoint (authorize, token, logout) and the universal-link
  /// redirect use the canonical DNS host over HTTPS, with no port.
  @Test func derivedEndpointsUseCanonicalDNSHost() {
    #expect(CrmAPIConfig.baseURL != nil, "La configuration doit être valide dans cet environnement")
    let endpoints = [CrmAPIConfig.authorizeURL, CrmAPIConfig.tokenURL, CrmAPIConfig.logoutURL].compactMap { $0 }
    #expect(endpoints.count == 3)
    for url in endpoints {
      assertDNSName(url.host())
      #expect(url.scheme == "https")
      #expect(url.host() == "crm.27pm.org")
      #expect(url.port == nil)
    }
    let redirect = URLComponents(string: CrmAPIConfig.redirectURI)
    assertDNSName(redirect?.host)
    #expect(redirect?.scheme == "https")
    #expect(redirect?.port == nil)
  }

  // MARK: Source-level proofs

  private struct SourceViolation {
    let file: String
    let line: Int
    let text: String
  }

  /// Locates the shipped app target's source folder. Priority:
  /// 1. absolute `SRCROOT` written into the host app bundle at build time
  ///    (the test-bundle copy is a fallback),
  /// 2. `#filePath` (relative on CI) resolved against the process cwd,
  /// 3. walking up from the host app bundle (local Xcode runs).
  private func locateShippedSourceDirectory() -> URL? {
    let marker = "App27pmCRM/CrmAPI.swift"
    func exists(_ appDir: URL) -> Bool {
      FileManager.default.fileExists(atPath: appDir.appendingPathComponent("CrmAPI.swift").path)
    }
    for bundle in [Bundle.main, Bundle(for: BundleToken.self)] {
      if let path = bundle.path(forResource: "SourceRoot", ofType: "txt"),
         let data = FileManager.default.contents(atPath: path),
         let sourceRoot = String(data: data, encoding: .utf8)?
           .trimmingCharacters(in: .whitespacesAndNewlines),
         !sourceRoot.isEmpty {
        let appDir = URL(fileURLWithPath: sourceRoot)
          .appendingPathComponent("App27pmCRM", isDirectory: true)
        if exists(appDir) { return appDir }
      }
    }
    let fromFilePath = URL(fileURLWithPath: #filePath)
      .deletingLastPathComponent() // App27pmCRMTests
      .deletingLastPathComponent() // project root
      .appendingPathComponent("App27pmCRM", isDirectory: true)
    if exists(fromFilePath) { return fromFilePath }
    var dir = Bundle.main.bundleURL
    for _ in 0..<16 {
      let candidate = dir.appendingPathComponent(marker)
      if FileManager.default.fileExists(atPath: candidate.path) {
        return candidate.deletingLastPathComponent()
      }
      guard dir.pathComponents.count > 1 else { return nil }
      dir.deleteLastPathComponent()
    }
    return nil
  }

  /// Scans the shipped app target's source for patterns that would break
  /// IPv6-only operation.
  private func scanShippedSource(for pattern: String) throws -> [SourceViolation] {
    guard let appDir = locateShippedSourceDirectory() else {
      throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "App27pmCRM (source du target applicatif introuvable depuis le processus de test)"])
    }
    guard let enumerator = FileManager.default.enumerator(at: appDir, includingPropertiesForKeys: nil) else {
      throw CocoaError(.fileReadUnknown, userInfo: [NSFilePathErrorKey: appDir.path])
    }
    let regex = try NSRegularExpression(pattern: pattern)
    let extensions = Set(["swift", "plist", "entitlements"])
    var violations: [SourceViolation] = []
    for case let fileURL as URL in enumerator {
      guard extensions.contains(fileURL.pathExtension) else { continue }
      let content = try String(contentsOf: fileURL, encoding: .utf8)
      let full = NSRange(content.startIndex..., in: content)
      for match in regex.matches(in: content, range: full) {
        guard let matchRange = Range(match.range, in: content) else { continue }
        let prefix = content[content.startIndex..<matchRange.lowerBound]
        violations.append(SourceViolation(
          file: fileURL.lastPathComponent,
          line: prefix.components(separatedBy: "\n").count,
          text: String(content[matchRange])
        ))
      }
    }
    return violations
  }

  @Test func shippedSourceContainsNoIPLiterals() throws {
    // Four dotted decimals (IPv4) and bracketed IPv6 URL literals.
    let violations = try scanShippedSource(for: #"\b(?:[0-9]{1,3}\.){3}[0-9]{1,3}\b|https?://\["#)
    #expect(
      violations.isEmpty,
      "Littéraux IP trouvés : \(violations.map { "\($0.file):\($0.line) → \($0.text)" })"
    )
  }

  @Test func shippedSourceHasNoSubdomainOrForbiddenAPIs() throws {
    // No api.crm.27pm.org, no hand-rolled DNS resolution, no raw sockets —
    // URLSession/ASWebAuthenticationSession handle name resolution themselves.
    let forbidden = [
      "api\\.crm\\.27pm\\.org",
      "getaddrinfo", "gethostbyname", "getnameinfo",
      "CFHost", "CFSocket", "NWConnection", "NWEndpoint",
      "SCNetworkReachability",
    ].joined(separator: "|")
    let violations = try scanShippedSource(for: forbidden)
    #expect(
      violations.isEmpty,
      "Usages interdits trouvés : \(violations.map { "\($0.file):\($0.line) → \($0.text)" })"
    )
  }

  /// No App Transport Security exception is present: HTTPS only, so the
  /// connection policy cannot be weakened into an IP-literal HTTP fallback.
  @Test func hostAppHasNoATSExceptions() {
    let ats = Bundle.main.object(forInfoDictionaryKey: "NSAppTransportSecurity") as? [String: Any]
    #expect(ats == nil || (ats?["NSAllowsArbitraryLoads"] as? Bool) != true)
  }
}

/// Anchor for `Bundle(for:)` — the suite is a struct.
private final class BundleToken {}
