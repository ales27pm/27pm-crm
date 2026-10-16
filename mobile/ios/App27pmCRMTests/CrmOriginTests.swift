import Foundation
import Testing
@testable import App27pmCRM

/// Allowlist of the single compiled origin: `EXPO_PUBLIC_CRM_API_BASE_URL` is
/// honoured only when it matches https://crm.27pm.org exactly; anything else
/// fails closed before any URL is derived or token attached.
@Suite struct CrmOriginAllowlistTests {
  private let canonical = CrmAPIConfig.canonicalOriginURL

  @Test func acceptsEmptyOverrideAsCanonicalOrigin() {
    for raw in [nil, "", "   "] {
      #expect(CrmAPIConfig.validatedOrigin(forOverride: raw) == canonical)
    }
  }

  @Test func acceptsExactCanonicalOverride() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org") == canonical)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org/") == canonical)
  }

  /// A standalone Xcode export has no Rork-generated `Config.swift`. The host
  /// app must still compile and resolve its sole allowed origin from the
  /// optional Info.plist value (or the canonical default when it is absent).
  @Test func standaloneXcodeBuildResolvesCanonicalOrigin() {
    #expect(CrmAPIConfig.baseURL == canonical)
    #expect(CrmAPIConfig.isConfigurationValid)
    #expect(CrmAPIConfig.configurationError == nil)
  }

  @Test func rejectsDowngradedScheme() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "http://crm.27pm.org") == nil)
  }

  @Test func rejectsSubdomain() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://www.crm.27pm.org") == nil)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org.evil.test") == nil)
  }

  @Test func rejectsExplicitPort() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org:8443") == nil)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org:443") == nil)
  }

  @Test func rejectsEmbeddedCredentials() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://user@crm.27pm.org") == nil)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://user:pass@crm.27pm.org") == nil)
  }

  @Test func rejectsForeignPath() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org/api") == nil)
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org/mobile") == nil)
  }

  @Test func rejectsQuery() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org?debug=1") == nil)
  }

  @Test func rejectsFragment() {
    #expect(CrmAPIConfig.validatedOrigin(forOverride: "https://crm.27pm.org#section") == nil)
  }

  /// With an invalid configuration the client throws before deriving any URL
  /// and before attaching the bearer token — no authenticated request exists.
  @MainActor @Test func invalidConfigurationFailsClosedWithoutAuthorization() async {
    let client = CrmAPIClient(baseURL: nil, accessTokenProvider: { "secret-device-token" })
    await #expect(throws: CrmAPIError.invalidConfiguration) {
      try await client.fetchDashboard()
    }
  }
}
