import Foundation

/// Pure decision policy, awaiting wiring into the actual iOS store/network layer.
/// It never touches credentials, files, server IDs or queue records.
public enum AttachmentOperation: Sendable { case upload, download, delete }
public enum AttachmentHTTPDecision: Equatable, Sendable {
    case success
    case refreshAuthenticationOnce
    case authenticationRequired
    case quarantined(retryAt: Date)
    case retryLater(retryAt: Date)
    case forbidden
    case notFound
    case rejected(code: String?)
}

public enum AttachmentHTTPPolicy {
    private struct ErrorBody: Decodable { let error: String? }

    public static func decide(
        status: Int, operation: AttachmentOperation,
        body: Data = Data(), retryAfter: String? = nil,
        alreadyRefreshed: Bool = false, consecutiveFailures: Int = 0,
        now: Date = Date()
    ) -> AttachmentHTTPDecision {
        if (200..<300).contains(status) || (operation == .delete && status == 404) {
            return .success
        }
        // 423 is a storage/security state, never an expired token or failed upload.
        if status == 423 {
            return .quarantined(retryAt: retryDate(retryAfter, failures: consecutiveFailures, now: now))
        }
        if status == 401 {
            return alreadyRefreshed ? .authenticationRequired : .refreshAuthenticationOnce
        }
        if status == 403 { return .forbidden }
        if status == 404 || status == 410 { return .notFound }
        if status == 408 || status == 429 || (500..<600).contains(status) {
            return .retryLater(retryAt: retryDate(retryAfter, failures: consecutiveFailures, now: now))
        }
        let error = body.count <= 4096 ? try? JSONDecoder().decode(ErrorBody.self, from: body) : nil
        return .rejected(code: error?.error)
    }

    private static func retryDate(_ header: String?, failures: Int, now: Date) -> Date {
        let exponent = min(max(failures, 0), 6)
        let fallback = min(30 * pow(2, Double(exponent)), 1800)
        var seconds = fallback
        if let header, header.count <= 128 {
            if header.range(of: "^[0-9]{1,10}$", options: .regularExpression) != nil,
               let numeric = Double(header) {
                seconds = numeric
            } else {
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "en_US_POSIX")
                formatter.timeZone = TimeZone(secondsFromGMT: 0)
                formatter.dateFormat = "EEE, dd MMM yyyy HH:mm:ss 'GMT'"
                formatter.isLenient = false
                if let date = formatter.date(from: header) { seconds = date.timeIntervalSince(now) }
            }
        }
        // Prevent hot retry loops and unbounded server-provided delays.
        return now.addingTimeInterval(min(max(seconds, 30), 3600))
    }
}
