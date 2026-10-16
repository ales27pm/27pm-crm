import Foundation

// MARK: - Configuration

/// Single public configuration: the deployed CRM backend. The app talks to
/// exactly one origin, `https://crm.27pm.org`. `EXPO_PUBLIC_CRM_API_BASE_URL`
/// is honoured only when it matches that origin exactly; anything else is a
/// hard configuration failure — no URL is derived and no token is attached.
///
/// IPv6-only readiness (DNS64/NAT64): the host is always a DNS name resolved
/// by the system resolver through URLSession / ASWebAuthenticationSession —
/// the app never performs its own DNS resolution and never embeds an IP
/// literal, so synthetic AAAA synthesis by DNS64 is handled end-to-end by
/// the OS networking stack.
enum CrmAPIConfig {
  /// Canonical origin, compiled. The only origin the app will ever contact.
  /// DNS name only — never an alternate CRM host or an IP literal.
  nonisolated static let canonicalOrigin = "https://crm.27pm.org"
  nonisolated static let canonicalOriginURL = URL(string: canonicalOrigin)!

  /// Resolves the build-time override: absent or empty → canonical origin;
  /// present but not an exact match of the canonical origin → nil (fail closed,
  /// never silently falls back to the canonical value to hide a bad setting).
  nonisolated static func validatedOrigin(forOverride raw: String?) -> URL? {
    let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return canonicalOriginURL }
    return isExactCanonicalOrigin(URLComponents(string: trimmed)) ? canonicalOriginURL : nil
  }

  /// Exact allowlist: https scheme, host crm.27pm.org, no port, no
  /// user/password, empty or "/" path, no query, no fragment.
  nonisolated static func isExactCanonicalOrigin(_ components: URLComponents?) -> Bool {
    guard let components else { return false }
    return components.scheme?.lowercased() == "https"
      && components.host?.lowercased() == "crm.27pm.org"
      && components.port == nil
      && components.user == nil
      && components.password == nil
      && (components.path.isEmpty || components.path == "/")
      && components.query == nil
      && components.fragment == nil
  }

  /// Optional build-time override embedded in the generated Info.plist.
  /// Rork's hosted builds may synthesize a `Config.swift`, but exported Xcode
  /// projects must not depend on that untracked generated source file.
  nonisolated static let configuredOriginOverride = Bundle.main.object(
    forInfoDictionaryKey: "EXPO_PUBLIC_CRM_API_BASE_URL"
  ) as? String

  /// nil when the override is invalid — every authenticated call fails closed.
  nonisolated static let baseURL: URL? = validatedOrigin(
    forOverride: configuredOriginOverride
  )

  nonisolated static var isConfigurationValid: Bool { baseURL != nil }

  /// Closed-failure message shown while the override is invalid.
  nonisolated static let configurationError: String? = baseURL == nil
    ? "Configuration refusée — EXPO_PUBLIC_CRM_API_BASE_URL doit correspondre exactement à \(canonicalOrigin). Corrigez la configuration puis reconnectez cet appareil."
    : nil

  /// OAuth 2.0 client registered with the backend for device authentication.
  nonisolated static let clientId = "org.27pm.crm.mobile"

  /// Exact universal link the backend redirects to after authorization.
  nonisolated static let redirectURI = "https://crm.27pm.org/mobile/oauth/callback"

  // Derived endpoints — nil while the configuration is invalid; never built
  // from an unvalidated URL.
  nonisolated static var authorizeURL: URL? { baseURL?.appending(path: "mobile/authorize") }
  nonisolated static var tokenURL: URL? { baseURL?.appending(path: "api/mobile/token") }
  nonisolated static var logoutURL: URL? { baseURL?.appending(path: "api/mobile/logout") }
}

// MARK: - Errors

enum CrmAPIError: LocalizedError, Equatable {
  case unauthorized
  case invalidConfiguration
  case http(status: Int, code: String)

  var errorDescription: String? {
    switch self {
    case .unauthorized:
      "Session expirée — reconnectez cet appareil pour continuer."
    case .invalidConfiguration:
      CrmAPIConfig.configurationError ?? "Configuration réseau invalide — la connexion au CRM est refusée sur cet appareil."
    case .http(_, let code):
      switch code {
      case "authentication_required":
        "Accès refusé — cet appel à l'API exige un appareil connecté."
      default:
        "Le CRM a répondu une erreur (\(code))."
      }
    }
  }
}

// MARK: - Date parsing

enum ApiDate {
  private static let montreal = TimeZone(identifier: "America/Montreal") ?? .current

  /// Lenient parser for the API's mixed formats: ISO 8601 (with or without
  /// fractional seconds), SQLite "YYYY-MM-DD HH:MM:SS" (UTC) and date-only
  /// fields ("YYYY-MM-DD", read in America/Montreal).
  static func parse(_ raw: String?) -> Date? {
    guard let raw, !raw.isEmpty else { return nil }
    let value = raw.trimmingCharacters(in: .whitespaces)
    if let date = try? Date(value, strategy: .iso8601) { return date }
    if let date = try? Date(value, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true)) { return date }
    if let date = try? Date(
      value,
      strategy: Date.ParseStrategy(
        format: "yyyy-MM-dd HH:mm:ss",
        locale: Locale(identifier: "en_US_POSIX"),
        timeZone: TimeZone(identifier: "UTC") ?? .current
      )
    ) { return date }
    if let date = try? Date(
      value,
      strategy: Date.ParseStrategy(
        format: "yyyy-MM-dd",
        locale: Locale(identifier: "en_US_POSIX"),
        timeZone: montreal
      )
    ) { return date }
    return nil
  }
}

// MARK: - Dashboard payload (mirrors app/api/dashboard/route.ts)

struct DashboardPayloadDTO: Decodable {
  let mailboxes: [MailboxDTO]
  let transportState: String
  let conversations: [ConversationDTO]
  let organizations: [OrganizationDTO]
  let contacts: [ContactDTO]
  let deals: [DealDTO]
  let tasks: [TaskDTO]
  let strategies: [StrategyDTO]
  let intakes: [IntakeDTO]
  let activities: [ActivityDTO]
}

struct MailboxDTO: Decodable {
  let address: String
  let label: String
  let kind: String?
}

struct ConversationDTO: Decodable {
  let id: String
  let mailboxAddress: String
  let contactId: String?
  let contactName: String?
  let contactEmail: String?
  let organization: String?
  let subject: String
  let preview: String?
  let unread: Bool
  let followUp: Bool
  let dealId: String?
  let messages: [MessageDTO]?
}

struct MessageDTO: Decodable {
  let id: String
  let direction: String
  let senderName: String?
  let senderEmail: String?
  let recipientLabel: String?
  let sentAtIso: String?
  let body: String
  let deliveryState: String?
  let deliveryEvents: [DeliveryEventDTO]?
}

struct DeliveryEventDTO: Decodable {
  let state: String
  let occurredAt: String?
}

struct OrganizationDTO: Decodable {
  let id: String
  let name: String
  let score: Int?
  let priority: String?
  let budgetMinCents: Int?
  let budgetMaxCents: Int?
  let budgetIsHypothesis: Bool?
  let nextStep: String?
  let notes: String?
  let nextFollowUpAt: String?
  let sourceLabel: String?
  // Server contract (native capabilities): optional until deployed.
  let address: String?
  let city: String?
}

struct ContactDTO: Decodable {
  let id: String
  let name: String?
  let email: String
  let role: String?
  let organization: String?
  let organizationId: String?
  let source: String?
  let sourceUrl: String?
  let dnclStatus: String?
  let emailStatus: String?
  let emailReady: Bool?
  let emailBlockReasons: [String]?
  let lastContactAt: String?
  // Server contract (native capabilities): optional until deployed.
  let phone: String?
}

struct InteractionDTO: Decodable {
  let id: String
  let kind: String?
  let summary: String
  let occurredAt: String?
  let createdBy: String?
}

struct DealDTO: Decodable {
  let id: String
  let organizationId: String?
  let contactId: String?
  let title: String
  let contactName: String?
  let organization: String?
  let projectType: String?
  let stage: String
  let nextAction: String?
  let nextActionDate: String?
  let note: String?
  let interactions: [InteractionDTO]?
}

struct TaskDTO: Decodable {
  let id: String
  let title: String
  let completed: Bool
  let dueAt: String?
  let organizationId: String?
  let organization: String?
  let dealId: String?
}

struct StepDTO: Decodable {
  let id: String
  let sequenceIndex: Int?
  let actionType: String?
  let title: String
  let purpose: String?
  let status: String?
  let scheduledAt: String?
}

struct StrategyDTO: Decodable {
  let id: String
  let organizationId: String
  let organization: String?
  let contactName: String?
  let status: String
  let objective: String?
  let targetRole: String?
  let valueProposition: String?
  let openingAngle: String?
  let emailReady: Bool?
  let emailBlockReasons: [String]?
  let steps: [StepDTO]?
}

struct IntakeDTO: Decodable {
  let id: String
  let organizationName: String
  let contactName: String?
  let contactEmail: String?
  let projectType: String?
  let message: String?
  let createdAt: String?
}

struct ActivityDTO: Decodable {
  let id: String
  let action: String
  let createdAt: String?
}

// MARK: - Mapping

enum DashboardMapper {
  /// Maps the API dashboard payload onto the app's domain models. The backend
  /// already resolves presentation values (labels, stage mapping, readiness).
  static func map(_ payload: DashboardPayloadDTO, now: Date = Date()) -> DashboardData {
    DashboardData(
      mailboxes: payload.mailboxes.map { mailbox in
        Mailbox(
          id: mailbox.address,
          address: mailbox.address,
          label: mailbox.label,
          kind: mailbox.kind == "operations" ? .operations : .sales
        )
      },
      transportState: TransportState(rawValue: payload.transportState) ?? .configuration,
      conversations: payload.conversations.map { conversation in
        let messages = (conversation.messages ?? []).map { message in
          CrmMessage(
            id: message.id,
            direction: MessageDirection(rawValue: message.direction) ?? .inbound,
            senderName: message.senderName ?? "Inconnu",
            senderEmail: message.senderEmail ?? "",
            recipientLabel: message.recipientLabel ?? "",
            sentAt: ApiDate.parse(message.sentAtIso) ?? now,
            body: message.body,
            deliveryState: DeliveryState(rawValue: message.deliveryState ?? "") ?? .received,
            deliveryEvents: (message.deliveryEvents ?? []).map { event in
              DeliveryEvent(
                id: "\(message.id)-\(event.state)-\(event.occurredAt ?? "")",
                state: DeliveryState(rawValue: event.state) ?? .sent,
                occurredAt: ApiDate.parse(event.occurredAt) ?? now
              )
            }
          )
        }
        return Conversation(
          id: conversation.id,
          mailboxAddress: conversation.mailboxAddress,
          contactId: conversation.contactId ?? "",
          contactName: (conversation.contactName?.isEmpty == false ? conversation.contactName : nil) ?? "Contact inconnu",
          contactEmail: conversation.contactEmail ?? "",
          organization: conversation.organization ?? "",
          subject: conversation.subject,
          preview: conversation.preview ?? "",
          unread: conversation.unread,
          followUp: conversation.followUp,
          messages: messages,
          dealId: conversation.dealId,
          lastActivity: messages.last?.sentAt ?? now
        )
      },
      organizations: payload.organizations.map { organization in
        Organization(
          id: organization.id,
          name: organization.name,
          score: organization.score ?? 0,
          priority: Priority(rawValue: organization.priority ?? "") ?? .normal,
          budgetMinCents: organization.budgetMinCents ?? 0,
          budgetMaxCents: organization.budgetMaxCents ?? 0,
          budgetIsHypothesis: organization.budgetIsHypothesis ?? false,
          nextStep: organization.nextStep,
          notes: organization.notes ?? "",
          nextFollowUpAt: ApiDate.parse(organization.nextFollowUpAt),
          sourceLabel: organization.sourceLabel ?? "Non renseignée",
          address: organization.address,
          city: organization.city
        )
      },
      contacts: payload.contacts.map { contact in
        Contact(
          id: contact.id,
          name: contact.name ?? contact.email,
          email: contact.email,
          role: contact.role ?? "",
          organization: contact.organization ?? "",
          organizationId: contact.organizationId ?? "",
          source: contact.source ?? "",
          sourceUrl: contact.sourceUrl,
          dnclStatus: contact.dnclStatus ?? "À vérifier",
          emailStatus: contact.emailStatus ?? "inconnu",
          emailReady: contact.emailReady ?? false,
          emailBlockReasons: contact.emailBlockReasons ?? ["contact_compliance_missing"],
          lastContactAt: ApiDate.parse(contact.lastContactAt),
          phone: contact.phone
        )
      },
      deals: payload.deals.map { deal in
        Deal(
          id: deal.id,
          organizationId: deal.organizationId ?? "",
          contactId: deal.contactId ?? "",
          title: deal.title,
          contactName: deal.contactName ?? "Aucun contact vérifié",
          organization: deal.organization ?? "",
          projectType: ProjectType(rawValue: deal.projectType ?? "") ?? .siteWeb,
          stage: PipelineStage(rawValue: deal.stage) ?? .nouveau,
          nextAction: deal.nextAction ?? "",
          nextActionDate: ApiDate.parse(deal.nextActionDate),
          note: deal.note ?? "",
          interactions: (deal.interactions ?? []).map { interaction in
            Interaction(
              id: interaction.id,
              kind: InteractionKind(rawValue: interaction.kind ?? "") ?? .other,
              summary: interaction.summary,
              occurredAt: ApiDate.parse(interaction.occurredAt) ?? now,
              createdBy: interaction.createdBy ?? ""
            )
          }
        )
      },
      tasks: payload.tasks.map { task in
        CrmTask(
          id: task.id,
          title: task.title,
          completed: task.completed,
          dueDate: ApiDate.parse(task.dueAt),
          organizationId: task.organizationId ?? "",
          organization: task.organization ?? "",
          dealId: task.dealId
        )
      },
      strategies: payload.strategies.map { strategy in
        OutreachStrategy(
          id: strategy.id,
          organizationId: strategy.organizationId,
          organization: strategy.organization ?? "",
          contactName: strategy.contactName,
          status: StrategyStatus(rawValue: strategy.status) ?? .draft,
          objective: strategy.objective ?? "",
          targetRole: strategy.targetRole ?? "",
          valueProposition: strategy.valueProposition ?? "",
          openingAngle: strategy.openingAngle ?? "",
          emailReady: strategy.emailReady ?? false,
          emailBlockReasons: strategy.emailBlockReasons ?? ["strategy_contact_missing"],
          steps: (strategy.steps ?? []).map { step in
            OutreachStep(
              id: step.id,
              sequenceIndex: step.sequenceIndex ?? 0,
              actionType: StepAction(rawValue: step.actionType ?? "") ?? .research,
              title: step.title,
              purpose: step.purpose ?? "",
              status: StepStatus(rawValue: step.status ?? "") ?? .planned,
              scheduledAt: ApiDate.parse(step.scheduledAt) ?? now
            )
          }
        )
      },
      intakes: payload.intakes.map { intake in
        IntakeSubmission(
          id: intake.id,
          organizationName: intake.organizationName,
          contactName: intake.contactName ?? "",
          contactEmail: intake.contactEmail ?? "",
          projectType: intake.projectType,
          message: intake.message ?? "",
          createdAt: ApiDate.parse(intake.createdAt) ?? now
        )
      },
      activities: payload.activities.map { activity in
        ActivityEntry(
          id: activity.id,
          action: activity.action,
          createdAt: ApiDate.parse(activity.createdAt) ?? now
        )
      }
    )
  }
}

// MARK: - Client

struct AttachmentHTTPResult {
  let status: Int
  let body: Data
  let retryAfter: String?
  let contentType: String?
  let contentLength: Int?
  let effectiveURL: URL?
}

protocol AttachmentAPITransport: AnyObject {
  func uploadAttachment(
    fileData: Data,
    fileName: String,
    mimeType: String,
    ownerKind: String,
    ownerId: String,
    idempotencyKey: String
  ) async throws -> AttachmentHTTPResult
  func downloadAttachment(id: String) async throws -> AttachmentHTTPResult
  func deleteAttachment(id: String) async throws -> AttachmentHTTPResult
  func listAttachments(ownerKind: String, ownerId: String) async throws -> AttachmentHTTPResult
}

/// Redirects are rejected at URLSession's hand-off boundary so an
/// Authorization header can never be replayed to a redirected destination.
nonisolated final class AttachmentRedirectDelegate: NSObject, URLSessionTaskDelegate {
  nonisolated func urlSession(
    _ session: URLSession,
    task: URLSessionTask,
    willPerformHTTPRedirection response: HTTPURLResponse,
    newRequest request: URLRequest,
    completionHandler: @escaping @Sendable (URLRequest?) -> Void
  ) {
    completionHandler(nil)
  }
}

/// HTTP client for the CRM backend. Every call carries the device's bearer
/// token read at request time; no client-provided identity header is sent.
final class CrmAPIClient: AttachmentAPITransport {
  /// nil while the build-time override is invalid — every call then fails closed.
  private let baseURL: URL?
  private let accessTokenProvider: () -> String?
  private let session: URLSession

  init(
    baseURL: URL?,
    accessTokenProvider: @escaping () -> String?,
    session injectedSession: URLSession? = nil
  ) {
    self.baseURL = baseURL
    self.accessTokenProvider = accessTokenProvider
    if let injectedSession {
      session = injectedSession
    } else {
      let configuration = URLSessionConfiguration.default
      configuration.timeoutIntervalForRequest = 20
      configuration.httpAdditionalHeaders = ["Accept": "application/json"]
      session = URLSession(
        configuration: configuration,
        delegate: AttachmentRedirectDelegate(),
        delegateQueue: nil
      )
    }
  }

  deinit {
    session.finishTasksAndInvalidate()
  }

  /// GET /api/dashboard — full CRM snapshot, with the raw JSON kept so the
  /// offline cache can persist the exact server payload.
  func fetchDashboard() async throws -> (data: DashboardData, rawJSON: Data) {
    let raw = try await fetchData("api/dashboard")
    let payload = try JSONDecoder().decode(DashboardPayloadDTO.self, from: raw)
    return (DashboardMapper.map(payload), raw)
  }

  /// PATCH /api/tasks/{id} — toggle completion.
  func setTask(_ id: String, completed: Bool) async throws {
    try await patch("api/tasks/\(id)", body: ["completed": completed])
  }

  /// PATCH /api/conversations/{id} — read state.
  func setConversation(_ id: String, unread: Bool) async throws {
    try await patch("api/conversations/\(id)", body: ["isUnread": unread])
  }

  /// PATCH /api/deals/{id} — pipeline stage.
  func setDealStage(_ id: String, stage: PipelineStage) async throws {
    try await patch("api/deals/\(id)", body: ["stage": stage.rawValue])
  }

  /// PATCH /api/deals/{id} — push the next action date forward.
  func snoozeDeal(_ id: String, until date: Date) async throws {
    try await patch("api/deals/\(id)", body: ["nextActionAt": Self.iso(date)])
  }

  // MARK: Server contract — native capabilities (see docs/crm-27pm-org-api-contract.md)

  private struct CapabilitiesPayloadDTO: Decodable {
    let attachments: Bool?
  }

  /// GET /api/mobile/capabilities — probes whether the deployed backend
  /// implements the attachment endpoints. Any failure (404, network,
  /// authentication) conservatively reports false: the client then keeps
  /// every upload in its local outbox instead of sending anything.
  func probeAttachmentsSupport() async -> Bool {
    guard baseURL != nil else { return false }
    do {
      let raw = try await fetchData("api/mobile/capabilities")
      return (try JSONDecoder().decode(CapabilitiesPayloadDTO.self, from: raw)).attachments ?? false
    } catch {
      return false
    }
  }

  /// POST /api/mobile/attachments — multipart upload of one local file.
  /// Requires an active device session; returns the server identifier.
  func uploadAttachment(
    fileData: Data, fileName: String, mimeType: String,
    ownerKind: String, ownerId: String, idempotencyKey: String
  ) async throws -> AttachmentHTTPResult {
    let boundary = "27pm-\(UUID().uuidString)"
    var request = try securedRequest("api/mobile/attachments")
    request.httpMethod = "POST"
    request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
    // The current server deduplicates on owner + SHA-256. Carry the stable
    // local key as an additional correlation hint without placing it in the
    // multipart body, whose accepted fields are intentionally exact.
    request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
    request.httpBody = Self.multipartBody(
      fields: ["ownerKind": ownerKind, "ownerId": ownerId],
      fileField: "file", fileName: fileName, mimeType: mimeType,
      fileData: fileData, boundary: boundary
    )
    return try await attachmentResult(for: request)
  }

  /// GET /api/mobile/attachments/{id}/file. A 423 is returned verbatim with
  /// Retry-After so the policy can defer verification without re-uploading.
  func downloadAttachment(id: String) async throws -> AttachmentHTTPResult {
    try await attachmentResult(for: securedRequest("api/mobile/attachments/\(id)/file"))
  }

  /// GET collection metadata for restart/reconciliation diagnostics. The
  /// backend deliberately never exposes private object keys or receipts.
  func listAttachments(ownerKind: String, ownerId: String) async throws -> AttachmentHTTPResult {
    guard let baseURL else { throw CrmAPIError.invalidConfiguration }
    var components = URLComponents(
      url: baseURL.appending(path: "api/mobile/attachments"),
      resolvingAgainstBaseURL: false
    )
    components?.queryItems = [
      URLQueryItem(name: "ownerKind", value: ownerKind),
      URLQueryItem(name: "ownerId", value: ownerId),
    ]
    guard let url = components?.url else { throw CrmAPIError.invalidConfiguration }
    var request = URLRequest(url: url)
    if let token = accessTokenProvider(), !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return try await attachmentResult(for: request)
  }

  /// DELETE /api/mobile/attachments/{id} — removes a server attachment.
  /// Per the contract, a 404 means the attachment is already gone
  /// server-side: it is treated as a success so the outbox never retries it
  /// forever.
  func deleteAttachment(id: String) async throws -> AttachmentHTTPResult {
    var request = try securedRequest("api/mobile/attachments/\(id)")
    request.httpMethod = "DELETE"
    return try await attachmentResult(for: request)
  }

  nonisolated private static func multipartBody(
    fields: [String: String], fileField: String, fileName: String,
    mimeType: String, fileData: Data, boundary: String
  ) -> Data {
    var body = Data()
    for (name, value) in fields {
      append(&body, "--\(boundary)\r\n")
      append(&body, "Content-Disposition: form-data; name=\"\(name)\"\r\n\r\n")
      append(&body, "\(value)\r\n")
    }
    append(&body, "--\(boundary)\r\n")
    append(&body, "Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(fileName)\"\r\n")
    append(&body, "Content-Type: \(mimeType)\r\n\r\n")
    body.append(fileData)
    append(&body, "\r\n--\(boundary)--\r\n")
    return body
  }

  // MARK: Plumbing

  /// Builds a request against the validated origin only. Throws before any
  /// URL is derived and before the bearer token is attached when the
  /// configuration is invalid — no authenticated request can exist.
  private func securedRequest(_ path: String) throws -> URLRequest {
    guard let baseURL else { throw CrmAPIError.invalidConfiguration }
    var request = URLRequest(url: baseURL.appending(path: path))
    if let token = accessTokenProvider(), !token.isEmpty {
      request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    }
    return request
  }

  private func get<Response: Decodable>(_ path: String) async throws -> Response {
    let raw = try await fetchData(path)
    return try JSONDecoder().decode(Response.self, from: raw)
  }

  private func fetchData(_ path: String) async throws -> Data {
    let request = try securedRequest(path)
    let (data, response) = try await session.data(for: request)
    try Self.validate(response, data: data)
    return data
  }

  private func attachmentResult(for request: URLRequest) async throws -> AttachmentHTTPResult {
    let (data, response) = try await session.data(for: request)
    guard let http = response as? HTTPURLResponse else {
      throw CrmAPIError.http(status: -1, code: "invalid_response")
    }
    guard let effective = http.url,
      effective.scheme?.lowercased() == "https",
      effective.host?.lowercased() == "crm.27pm.org",
      effective.port == nil,
      effective.user == nil,
      effective.password == nil
    else {
      throw CrmAPIError.http(status: 502, code: "redirect_forbidden")
    }
    let length = http.value(forHTTPHeaderField: "Content-Length").flatMap(Int.init)
    return AttachmentHTTPResult(
      status: http.statusCode,
      body: data,
      retryAfter: http.value(forHTTPHeaderField: "Retry-After"),
      contentType: http.value(forHTTPHeaderField: "Content-Type"),
      contentLength: length,
      effectiveURL: effective
    )
  }

  private func patch(_ path: String, body: [String: Any]) async throws {
    var request = try securedRequest(path)
    request.httpMethod = "PATCH"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.httpBody = try JSONSerialization.data(withJSONObject: body)
    let (data, response) = try await session.data(for: request)
    try Self.validate(response, data: data)
  }

  private static func iso(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
  }

  nonisolated private static func append(_ body: inout Data, _ string: String) {
    body.append(string.data(using: .utf8) ?? Data())
  }

  private static func validate(_ response: URLResponse, data: Data) throws {
    guard let http = response as? HTTPURLResponse else {
      throw CrmAPIError.http(status: -1, code: "invalid_response")
    }
    guard (200..<300).contains(http.statusCode) else {
      if http.statusCode == 401 { throw CrmAPIError.unauthorized }
      let code = (try? JSONDecoder().decode(ErrorBody.self, from: data).error) ?? "http_\(http.statusCode)"
      throw CrmAPIError.http(status: http.statusCode, code: code)
    }
  }

  private struct ErrorBody: Decodable {
    let error: String
  }
}
