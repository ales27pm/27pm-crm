import Foundation
import Testing

/// Build-identity proofs for the TestFlight 10 round: the archived app must
/// carry the exact bundle identifiers the server's association file
/// authorizes (org.27pm.crm.mobile family), the bumped build number, and the
/// Associated Domains entitlements in both configurations.
///
/// The proof material travels inside the built bundle: the app target's
/// "Write compiled source root" phase snapshots the relevant project.pbxproj
/// settings into `BuildIdentity.txt` and copies `App27pmCRM.entitlements` as
/// `BuildEntitlements.plist`. Tests read them from `Bundle.main`, which works
/// even though the managed runner executes tests on a simulator that shares
/// no filesystem with the build machine.
@Suite
struct CrmBuildIdentityTests {

  /// Reads a proof resource embedded in the host app bundle at build time.
  private func bundledProof(_ name: String, extension ext: String) throws -> String {
    guard let path = Bundle.main.path(forResource: name, ofType: ext),
          let content = try? String(contentsOfFile: path, encoding: .utf8)
    else {
      throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: "\(name).\(ext) (ressource du bundle hôte)"])
    }
    return content
  }

  private func count(_ needle: String, in haystack: String) -> Int {
    haystack.components(separatedBy: needle).count - 1
  }

  // MARK: Runtime identity of the built host app (TEST_HOST)

  @Test func hostAppBundleIdentifierIsTheAssociatedApp() {
    #expect(Bundle.main.bundleIdentifier == "org.27pm.crm.mobile",
            "L'app doit porter l'identifiant autorisé par l'AASA de crm.27pm.org")
  }

  @Test func hostAppCarriesBuild10OfMarketingVersion100() {
    #expect(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String == "10",
            "CURRENT_PROJECT_VERSION doit être 10 pour le nouveau build TestFlight")
    #expect(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String == "1.0.0")
  }

  // MARK: Build-settings snapshot (project.pbxproj at build time)

  @Test func appTargetKeepsTheAssociatedBundleIdentifierInBothConfigurations() throws {
    let identity = try bundledProof("BuildIdentity", extension: "txt")
    #expect(count("PRODUCT_BUNDLE_IDENTIFIER = org.27pm.crm.mobile;", in: identity) == 2,
            "App Debug + Release doivent porter l'identifiant autorisé par l'AASA")
    #expect(!identity.contains("PRODUCT_BUNDLE_IDENTIFIER = org.27pm.crm;"),
            "L'identifiant nu org.27pm.crm n'est pas déclaré par l'association du domaine")
  }

  @Test func testTargetsKeepTheMobileTestBundleIdentifiers() throws {
    let identity = try bundledProof("BuildIdentity", extension: "txt")
    #expect(count("PRODUCT_BUNDLE_IDENTIFIER = org.27pm.crm.mobile.tests;", in: identity) == 2)
    #expect(count("PRODUCT_BUNDLE_IDENTIFIER = org.27pm.crm.mobile.uitests;", in: identity) == 2)
  }

  @Test func currentProjectVersionIs10InAllSixConfigurations() throws {
    let identity = try bundledProof("BuildIdentity", extension: "txt")
    #expect(count("CURRENT_PROJECT_VERSION = 10;", in: identity) == 6,
            "Trois targets × deux configurations")
    #expect(!identity.contains("CURRENT_PROJECT_VERSION = 9;"))
  }

  @Test func marketingVersionStaysAt100InEveryConfiguration() throws {
    let identity = try bundledProof("BuildIdentity", extension: "txt")
    #expect(count("MARKETING_VERSION = 1.0.0;", in: identity) == 6)
  }

  @Test func entitlementsAreReferencedInBothAppConfigurations() throws {
    let identity = try bundledProof("BuildIdentity", extension: "txt")
    #expect(count("CODE_SIGN_ENTITLEMENTS = App27pmCRM/App27pmCRM.entitlements;", in: identity) == 2)
  }

  @Test func entitlementsDeclareTheAssociatedDomains() throws {
    let entitlements = try bundledProof("BuildEntitlements", extension: "plist")
    #expect(entitlements.contains("applinks:crm.27pm.org"))
    #expect(entitlements.contains("webcredentials:crm.27pm.org"))
  }
}
