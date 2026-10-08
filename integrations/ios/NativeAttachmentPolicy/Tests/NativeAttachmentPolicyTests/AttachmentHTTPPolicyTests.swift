import Foundation
import XCTest
@testable import NativeAttachmentPolicy

final class AttachmentHTTPPolicyTests: XCTestCase {
    let now = Date(timeIntervalSince1970: 1_791_126_000)

    func testQuarantineDoesNotRefreshOrRejectEvenWhenErrorBodyIsMissing() {
        for operation: AttachmentOperation in [.upload, .download, .delete] {
            XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 423, operation: operation, now: now),
                           .quarantined(retryAt: now.addingTimeInterval(30)))
        }
    }
    func testRetryAfterPreservedAndClamped() {
        for (header, expected) in [("60", 60.0), ("0", 30.0), ("99999999", 3600.0), ("-1", 30.0)] {
            XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 423, operation: .download, retryAfter: header, now: now),
                           .quarantined(retryAt: now.addingTimeInterval(expected)))
        }
    }
    func testOnly401RefreshesAndAtMostOnce() {
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 401, operation: .download), .refreshAuthenticationOnce)
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 401, operation: .download, alreadyRefreshed: true), .authenticationRequired)
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 403, operation: .download), .forbidden)
    }
    func testDelete404IsIdempotentButDownload404IsNot() {
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 404, operation: .delete), .success)
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 404, operation: .download), .notFound)
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 204, operation: .delete), .success)
    }
    func testCompletedUploadRemainsSuccessfulWhileSeparateDownloadIsQuarantined() {
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 200, operation: .upload), .success)
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 423, operation: .download, now: now),
                       .quarantined(retryAt: now.addingTimeInterval(30)))
    }
    func testBackoffCannotOverflowOnLargeFailureCount() {
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 503, operation: .upload, consecutiveFailures: Int.max, now: now),
                       .retryLater(retryAt: now.addingTimeInterval(1800)))
    }
    func testValidationFailuresAreNotRetriedAsExpiredTokens() {
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 413, operation: .upload,
            body: Data(#"{"error":"file_too_large"}"#.utf8)), .rejected(code: "file_too_large"))
    }
    func testHTTPDateRetryAfter() {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
        let header = formatter.string(from: now.addingTimeInterval(120))
        XCTAssertEqual(AttachmentHTTPPolicy.decide(status: 423, operation: .download, retryAfter: header, now: now),
                       .quarantined(retryAt: now.addingTimeInterval(120)))
    }
}
