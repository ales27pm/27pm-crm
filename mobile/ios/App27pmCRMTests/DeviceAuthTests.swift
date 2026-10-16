import CryptoKit
import Foundation
import Testing
@testable import App27pmCRM

@MainActor
struct DeviceAuthTests {

  // MARK: PKCE (RFC 7636)

  @Test func verifierMeetsRFC7636LengthAndCharset() {
    let challenge = PKCE.generate()
    #expect((43...128).contains(challenge.verifier.count))
    let allowed = Set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_")
    #expect(challenge.verifier.allSatisfy { allowed.contains($0) })
  }

  @Test func challengeIsS256Base64URLOfVerifier() {
    let challenge = PKCE.generate()
    let digest = SHA256.hash(data: Data(challenge.verifier.utf8))
    let expected = Data(digest).base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
    #expect(challenge.challenge == expected)
  }

  @Test func stateHasAtLeast128BitsOfEntropy() {
    // 128 bits of base64url-encoded entropy is at least 22 characters.
    #expect(PKCE.generate().state.count >= 22)
  }

  @Test func generatedMaterialsDifferBetweenFlows() {
    let first = PKCE.generate()
    let second = PKCE.generate()
    #expect(first.verifier != second.verifier)
    #expect(first.challenge != second.challenge)
    #expect(first.state != second.state)
  }

  // MARK: Universal link callback validation

  private func callbackURL(code: String = "single-use-code", state: String) -> URL {
    URL(string: "https://crm.27pm.org/mobile/oauth/callback?code=\(code)&state=\(state)")!
  }

  @Test func acceptsExactUniversalLinkCallback() {
    let state = PKCE.generate().state
    #expect(DeviceAuth.isValidCallback(callbackURL(state: state), expectedState: state))
  }

  @Test func rejectsForeignHost() {
    let state = PKCE.generate().state
    let url = URL(string: "https://evil.example.com/mobile/oauth/callback?code=x&state=\(state)")!
    #expect(!DeviceAuth.isValidCallback(url, expectedState: state))
  }

  @Test func rejectsDowngradedProtocol() {
    let state = PKCE.generate().state
    let url = URL(string: "http://crm.27pm.org/mobile/oauth/callback?code=x&state=\(state)")!
    #expect(!DeviceAuth.isValidCallback(url, expectedState: state))
  }

  @Test func rejectsForeignPort() {
    let state = PKCE.generate().state
    let url = URL(string: "https://crm.27pm.org:8443/mobile/oauth/callback?code=x&state=\(state)")!
    #expect(!DeviceAuth.isValidCallback(url, expectedState: state))
  }

  @Test func rejectsForeignPath() {
    let state = PKCE.generate().state
    let url = URL(string: "https://crm.27pm.org/other/path?code=x&state=\(state)")!
    #expect(!DeviceAuth.isValidCallback(url, expectedState: state))
  }

  @Test func rejectsTamperedState() {
    let state = PKCE.generate().state
    let url = URL(string: "https://crm.27pm.org/mobile/oauth/callback?code=x&state=tampered-state")!
    #expect(!DeviceAuth.isValidCallback(url, expectedState: state))
  }

  @Test func rejectsMissingCode() {
    let state = PKCE.generate().state
    let url = URL(string: "https://crm.27pm.org/mobile/oauth/callback?state=\(state)")!
    #expect(!DeviceAuth.isValidCallback(url, expectedState: state))
  }
}
