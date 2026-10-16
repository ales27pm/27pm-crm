import CryptoKit
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
  let transportProvider: String?
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
  let lastActivityAt: String?
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
      transportProvider: TransportProvider(rawValue: payload.transportProvider ?? "") ?? .unknown,
      conversations: payload.conversations.map { conversation in
        let newestParsedMessageDate = (conversation.messages ?? [])
          .compactMap { ApiDate.parse($0.sentAtIso) }
          .max()
        let messages = (conversation.messages ?? []).map { message in
          CrmMessage(
            id: message.id,
            direction: MessageDirection(rawValue: message.direction) ?? .inbound,
            senderName: message.senderName ?? "Inconnu",
            senderEmail: message.senderEmail ?? "",
            recipientLabel: message.recipientLabel ?? "",
            sentAt: ApiDate.parse(message.sentAtIso) ?? now,
            body: message.body,
            deliveryState: DeliveryState.canonical(message.deliveryState),
            deliveryEvents: (message.deliveryEvents ?? []).map { event in
              DeliveryEvent(
                id: "\(message.id)-\(event.state)-\(event.occurredAt ?? "")",
                state: DeliveryState.canonical(event.state),
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
          lastActivity: ApiDate.parse(conversation.lastActivityAt)
            ?? newestParsedMessageDate
            ?? .distantPast
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

nonisolated struct AttachmentHTTPResult: Sendable {
  let status: Int
  let body: Data
  let retryAfter: String?
  let contentType: String?
  let contentLength: Int?
  let effectiveURL: URL?
  /// Required on every chunk so a concurrent replacement can never mix
  /// object versions inside a single reconstructed download.
  var objectVersion: String? = nil
}

/// A versioned wire contract, not a loose boolean capability. Older servers
/// deliberately remain unavailable rather than receiving an oversized POST.
enum ChunkedAttachmentContract {
  nonisolated static let maxFileBytes = 20 * 1_024 * 1_024
  nonisolated static let chunkBytes = 2 * 1_024 * 1_024
  nonisolated static let maxMetadataBytes = 64 * 1_024
  nonisolated static let maxCollectionBytes = 512 * 1_024
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
  /// Injection seam for deterministic protocol tests. Production always uses
  /// the bounded URLSession byte stream below; the seam never changes origin,
  /// session-stability, response-size or acknowledgement validation.
  typealias AttachmentResponseLoader = @MainActor (URLRequest, Int) async throws -> AttachmentHTTPResult

  /// nil while the build-time override is invalid — every call then fails closed.
  private let baseURL: URL?
  private let accessTokenProvider: () -> String?
  private let session: URLSession
  private let attachmentResponseLoader: AttachmentResponseLoader?

  init(
    baseURL: URL?,
    accessTokenProvider: @escaping () -> String?,
    session injectedSession: URLSession? = nil,
    attachmentResponseLoader: AttachmentResponseLoader? = nil
  ) {
    self.baseURL = baseURL
    self.accessTokenProvider = accessTokenProvider
    self.attachmentResponseLoader = attachmentResponseLoader
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
    let attachments: Bool
    let transport: String
    let maxFileBytes: Int
    let chunkBytes: Int

    var supportsChunkedAttachments: Bool {
      attachments && transport == "chunked-v2"
        && maxFileBytes == ChunkedAttachmentContract.maxFileBytes
        && chunkBytes == ChunkedAttachmentContract.chunkBytes
    }
  }

  private struct UploadChunkDTO: Encodable {
    let byteSize: Int
    let sha256: String
  }

  private struct UploadManifestDTO: Encodable {
    let ownerKind: String
    let ownerId: String
    let fileName: String
    let contentType: String
    let byteSize: Int
    let sha256: String
    let chunks: [UploadChunkDTO]
  }

  private struct UploadStatusDTO: Decodable {
    let id: String
    let state: String
    let byteSize: Int
    let chunkBytes: Int
    let chunkCount: Int
    let receivedChunks: [Int]
    let attachmentId: String?
  }

  private struct DownloadManifestDTO: Decodable {
    let id: String
    let byteSize: Int
    let sha256: String
    let objectVersion: String
    let chunkBytes: Int
    let chunkCount: Int
    let contentType: String
  }

  /// GET /api/mobile/capabilities — probes whether the deployed backend
  /// implements the attachment endpoints. Any failure (404, network,
  /// authentication) conservatively reports false: the client then keeps
  /// every upload in its local outbox instead of sending anything.
  func probeAttachmentsSupport() async -> Bool {
    do {
      let token = try attachmentAccessToken()
      var request = try attachmentRequest("api/mobile/capabilities", token: token)
      request.setValue("chunked-v2", forHTTPHeaderField: "X-27PM-Attachment-Transport")
      let result = try await attachmentResult(
        for: request, token: token
      )
      guard result.status == 200 else { return false }
      let capabilities: CapabilitiesPayloadDTO = try attachmentMetadata(result)
      return capabilities.supportsChunkedAttachments
    } catch {
      return false
    }
  }

  /// Resumable, bounded upload. The caller's durable idempotency key is reused
  /// after every interruption; server status alone decides which chunks exist.
  /// No internal authentication refresh, retry loop or new upload key is used.
  func uploadAttachment(
    fileData: Data, fileName: String, mimeType: String,
    ownerKind: String, ownerId: String, idempotencyKey: String
  ) async throws -> AttachmentHTTPResult {
    guard !fileData.isEmpty, fileData.count <= ChunkedAttachmentContract.maxFileBytes,
      ["account", "deal", "conversation"].contains(ownerKind),
      Self.isBoundedHeader(ownerId, maxBytes: 256),
      ownerId == ownerId.trimmingCharacters(in: .whitespacesAndNewlines),
      Self.isBoundedHeader(fileName, maxBytes: 255),
      Self.isBoundedHeader(mimeType, maxBytes: 255),
      Self.isIdempotencyKey(idempotencyKey)
    else { throw CrmAPIError.http(status: 422, code: "invalid_upload_manifest") }
    let token = try attachmentAccessToken()
    let chunkSize = ChunkedAttachmentContract.chunkBytes
    var chunks: [UploadChunkDTO] = []
    for start in stride(from: 0, to: fileData.count, by: chunkSize) {
      let bytes = fileData.subdata(in: start..<min(start + chunkSize, fileData.count))
      chunks.append(UploadChunkDTO(byteSize: bytes.count, sha256: Self.sha256(bytes)))
    }
    let manifest = UploadManifestDTO(
      ownerKind: ownerKind, ownerId: ownerId, fileName: fileName,
      contentType: mimeType, byteSize: fileData.count,
      sha256: Self.sha256(fileData), chunks: chunks
    )
    var request = try attachmentRequest("api/mobile/attachment-uploads", token: token)
    request.httpMethod = "POST"
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key")
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    request.httpBody = try encoder.encode(manifest)
    let created = try await attachmentResult(for: request, token: token)
    guard (200..<300).contains(created.status) else { return created }
    var status = try uploadStatus(created, byteSize: fileData.count, chunkCount: chunks.count)
    if status.state == "committed" { return try committedUpload(status, response: created) }
    if status.state == "cancelled" { return Self.cancelledUpload(created) }

    let uploadPath = "api/mobile/attachment-uploads/\(status.id)"
    let current = try await attachmentResult(
      for: attachmentRequest(uploadPath, token: token), token: token
    )
    guard (200..<300).contains(current.status) else { return current }
    status = try uploadStatus(
      current, byteSize: fileData.count, chunkCount: chunks.count, expectedID: status.id
    )
    if status.state == "committed" { return try committedUpload(status, response: current) }
    if status.state == "cancelled" { return Self.cancelledUpload(current) }

    var received = Set(status.receivedChunks)
    if status.state == "uploading" {
      for index in chunks.indices where !received.contains(index) {
        try Task.checkCancellation()
        let start = index * chunkSize
        var put = try attachmentRequest("\(uploadPath)/chunks/\(index)", token: token)
        put.httpMethod = "PUT"
        put.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        put.httpBody = fileData.subdata(in: start..<min(start + chunkSize, fileData.count))
        let acknowledgement = try await attachmentResult(for: put, token: token)
        guard (200..<300).contains(acknowledgement.status) else { return acknowledgement }
        status = try uploadStatus(
          acknowledgement, byteSize: fileData.count, chunkCount: chunks.count,
          expectedID: status.id
        )
        if status.state == "committed" {
          return try committedUpload(status, response: acknowledgement)
        }
        if status.state == "cancelled" { return Self.cancelledUpload(acknowledgement) }
        let acknowledged = Set(status.receivedChunks)
        guard acknowledged.contains(index), received.isSubset(of: acknowledged) else {
          throw CrmAPIError.http(status: 502, code: "invalid_chunk_acknowledgement")
        }
        received = acknowledged
        if status.state == "finalizing" { break }
      }
    }
    guard received.count == chunks.count else {
      throw CrmAPIError.http(status: 502, code: "incomplete_upload_acknowledgement")
    }
    var complete = try attachmentRequest("\(uploadPath)/complete", token: token)
    complete.httpMethod = "POST"
    let completed = try await attachmentResult(for: complete, token: token)
    guard (200..<300).contains(completed.status) else { return completed }
    status = try uploadStatus(
      completed, byteSize: fileData.count, chunkCount: chunks.count, expectedID: status.id
    )
    if status.state == "committed" { return try committedUpload(status, response: completed) }
    if status.state == "cancelled" { return Self.cancelledUpload(completed) }
    // The coordinator owns backoff. A later pass repeats create with the same
    // persisted key and recovers this same server upload, including all ACKs.
    return AttachmentHTTPResult(
      status: 503, body: Data(#"{"error":"attachment_upload_pending"}"#.utf8),
      retryAfter: completed.retryAfter ?? "30", contentType: "application/json",
      contentLength: nil, effectiveURL: completed.effectiveURL
    )
  }

  /// No signed R2 URLs or full-file responses. Each chunk is pinned to the
  /// clean manifest version; only a length- and SHA-256-verified file escapes.
  func downloadAttachment(id: String) async throws -> AttachmentHTTPResult {
    guard Self.isIdentifier(id) else {
      throw CrmAPIError.http(status: 422, code: "invalid_attachment_identifier")
    }
    let token = try attachmentAccessToken()
    let path = "api/mobile/attachments/\(id)"
    let result = try await attachmentResult(
      for: attachmentRequest("\(path)/manifest", token: token), token: token
    )
    guard result.status == 200 else { return result }
    let manifest: DownloadManifestDTO = try attachmentMetadata(result)
    guard manifest.id == id,
      (1...ChunkedAttachmentContract.maxFileBytes).contains(manifest.byteSize),
      manifest.chunkBytes == ChunkedAttachmentContract.chunkBytes,
      manifest.chunkCount == (manifest.byteSize + manifest.chunkBytes - 1) / manifest.chunkBytes,
      Self.isSHA256(manifest.sha256),
      Self.isBoundedHeader(manifest.objectVersion, maxBytes: 256),
      Self.isBoundedHeader(manifest.contentType, maxBytes: 255)
    else { throw CrmAPIError.http(status: 502, code: "invalid_download_manifest") }
    var data = Data()
    data.reserveCapacity(manifest.byteSize)
    for index in 0..<manifest.chunkCount {
      try Task.checkCancellation()
      let expectedSize = min(manifest.chunkBytes, manifest.byteSize - index * manifest.chunkBytes)
      let chunk = try await attachmentResult(
        for: attachmentRequest(
          "\(path)/chunks/\(index)", token: token,
          queryItems: [URLQueryItem(name: "version", value: manifest.objectVersion)]
        ),
        token: token,
        maxResponseBytes: max(expectedSize, ChunkedAttachmentContract.maxMetadataBytes)
      )
      guard chunk.status == 200 else { return chunk }
      guard chunk.objectVersion == manifest.objectVersion,
        chunk.body.count == expectedSize,
        chunk.contentLength == nil || chunk.contentLength == expectedSize,
        chunk.contentType?.split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
          .lowercased() == "application/octet-stream"
      else { throw CrmAPIError.http(status: 502, code: "attachment_chunk_mismatch") }
      data.append(chunk.body)
    }
    guard data.count == manifest.byteSize, Self.sha256(data) == manifest.sha256 else {
      throw CrmAPIError.http(status: 502, code: "attachment_integrity_mismatch")
    }
    return AttachmentHTTPResult(
      status: 200, body: data, retryAfter: nil, contentType: manifest.contentType,
      contentLength: data.count, effectiveURL: result.effectiveURL,
      objectVersion: manifest.objectVersion
    )
  }

  /// GET collection metadata for restart/reconciliation diagnostics. The
  /// backend deliberately never exposes private object keys or receipts.
  func listAttachments(ownerKind: String, ownerId: String) async throws -> AttachmentHTTPResult {
    let token = try attachmentAccessToken()
    let request = try attachmentRequest(
      "api/mobile/attachments", token: token,
      queryItems: [
        URLQueryItem(name: "ownerKind", value: ownerKind),
        URLQueryItem(name: "ownerId", value: ownerId),
      ]
    )
    return try await attachmentResult(
      for: request, token: token, maxResponseBytes: ChunkedAttachmentContract.maxCollectionBytes
    )
  }

  /// DELETE /api/mobile/attachments/{id} — removes a server attachment.
  /// Per the contract, a 404 means the attachment is already gone
  /// server-side: it is treated as a success so the outbox never retries it
  /// forever.
  func deleteAttachment(id: String) async throws -> AttachmentHTTPResult {
    guard Self.isIdentifier(id) else {
      throw CrmAPIError.http(status: 422, code: "invalid_attachment_identifier")
    }
    let token = try attachmentAccessToken()
    var request = try attachmentRequest("api/mobile/attachments/\(id)", token: token)
    request.httpMethod = "DELETE"
    return try await attachmentResult(for: request, token: token)
  }

  private func uploadStatus(
    _ result: AttachmentHTTPResult, byteSize: Int, chunkCount: Int, expectedID: String? = nil
  ) throws -> UploadStatusDTO {
    let status: UploadStatusDTO = try attachmentMetadata(result)
    guard Self.isIdentifier(status.id), expectedID == nil || status.id == expectedID,
      ["uploading", "finalizing", "committed", "cancelled"].contains(status.state),
      status.byteSize == byteSize, status.chunkBytes == ChunkedAttachmentContract.chunkBytes,
      status.chunkCount == chunkCount,
      Set(status.receivedChunks).count == status.receivedChunks.count,
      status.receivedChunks.allSatisfy({ (0..<chunkCount).contains($0) })
    else { throw CrmAPIError.http(status: 503, code: "invalid_upload_status") }
    return status
  }

  private func committedUpload(
    _ status: UploadStatusDTO, response: AttachmentHTTPResult
  ) throws -> AttachmentHTTPResult {
    guard let id = status.attachmentId, UUID(uuidString: id) != nil else {
      throw CrmAPIError.http(status: 502, code: "invalid_upload_acknowledgement")
    }
    return AttachmentHTTPResult(
      status: 200, body: try JSONEncoder().encode(["id": id]), retryAfter: nil,
      contentType: "application/json", contentLength: nil, effectiveURL: response.effectiveURL
    )
  }

  private func attachmentMetadata<Payload: Decodable>(
    _ result: AttachmentHTTPResult
  ) throws -> Payload {
    guard let contentType = result.contentType,
      contentType.split(separator: ";").first?.trimmingCharacters(in: .whitespaces)
        .lowercased() == "application/json"
    else { throw CrmAPIError.http(status: 502, code: "invalid_attachment_metadata") }
    return try JSONDecoder().decode(Payload.self, from: result.body)
  }

  private static func cancelledUpload(_ response: AttachmentHTTPResult) -> AttachmentHTTPResult {
    AttachmentHTTPResult(
      status: 409, body: Data(#"{"error":"attachment_upload_cancelled"}"#.utf8),
      retryAfter: nil, contentType: "application/json", contentLength: nil,
      effectiveURL: response.effectiveURL
    )
  }

  nonisolated private static func sha256(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  nonisolated private static func isSHA256(_ value: String) -> Bool {
    value.utf8.count == 64 && value.utf8.allSatisfy {
      (48...57).contains($0) || (97...102).contains($0)
    }
  }

  nonisolated private static func isIdentifier(_ value: String) -> Bool {
    !value.isEmpty && value.utf8.count <= 128 && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
        || $0 == 45 || $0 == 95
    }
  }

  nonisolated private static func isIdempotencyKey(_ value: String) -> Bool {
    (8...128).contains(value.utf8.count) && value.utf8.allSatisfy {
      (48...57).contains($0) || (65...90).contains($0) || (97...122).contains($0)
        || $0 == 45 || $0 == 46 || $0 == 58 || $0 == 95
    }
  }

  nonisolated private static func isBoundedHeader(_ value: String, maxBytes: Int) -> Bool {
    !value.isEmpty && value.utf8.count <= maxBytes && !value.unicodeScalars.contains {
      CharacterSet.controlCharacters.contains($0)
    }
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

  private func attachmentAccessToken() throws -> String {
    guard let baseURL,
      CrmAPIConfig.isExactCanonicalOrigin(URLComponents(url: baseURL, resolvingAgainstBaseURL: false))
    else { throw CrmAPIError.invalidConfiguration }
    guard let token = accessTokenProvider(), !token.isEmpty else {
      throw CrmAPIError.unauthorized
    }
    return token
  }

  private func attachmentRequest(
    _ path: String, token: String, queryItems: [URLQueryItem] = []
  ) throws -> URLRequest {
    guard accessTokenProvider() == token else {
      throw CrmAPIError.http(status: 401, code: "authentication_session_changed")
    }
    guard let baseURL,
      CrmAPIConfig.isExactCanonicalOrigin(URLComponents(url: baseURL, resolvingAgainstBaseURL: false)),
      var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false)
    else { throw CrmAPIError.invalidConfiguration }
    components.queryItems = queryItems.isEmpty ? nil : queryItems
    guard let url = components.url else { throw CrmAPIError.invalidConfiguration }
    var request = URLRequest(url: url)
    request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
    request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    request.cachePolicy = .reloadIgnoringLocalCacheData
    return request
  }

  private func attachmentResult(
    for request: URLRequest, token: String,
    maxResponseBytes: Int = ChunkedAttachmentContract.maxMetadataBytes
  ) async throws -> AttachmentHTTPResult {
    try Task.checkCancellation()
    guard accessTokenProvider() == token else {
      throw CrmAPIError.http(status: 401, code: "authentication_session_changed")
    }
    let result: AttachmentHTTPResult
    if let attachmentResponseLoader {
      result = try await attachmentResponseLoader(request, maxResponseBytes)
    } else {
      result = try await Self.boundedAttachmentResult(
        session: session, request: request, maxResponseBytes: maxResponseBytes
      )
    }
    // A logout or rotation while URLSession was suspended must stop the whole
    // operation before any next chunk or acknowledgement is used. The existing
    // coordinator remains the sole owner of a permitted refresh/retry.
    try Task.checkCancellation()
    guard accessTokenProvider() == token else {
      throw CrmAPIError.http(status: 401, code: "authentication_session_changed")
    }
    guard let effective = result.effectiveURL,
      effective.scheme?.lowercased() == "https",
      effective.host?.lowercased() == "crm.27pm.org",
      effective.port == nil,
      effective.user == nil,
      effective.password == nil,
      effective == request.url,
      !(300..<400).contains(result.status)
    else {
      throw CrmAPIError.http(status: 502, code: "redirect_forbidden")
    }
    let validLength = result.contentLength.map {
      (0...maxResponseBytes).contains($0) && $0 == result.body.count
    } ?? true
    guard result.body.count <= maxResponseBytes, validLength
    else { throw CrmAPIError.http(status: 502, code: "attachment_response_too_large") }
    return result
  }

  /// The cap is enforced while bytes arrive, not after data(for:) has already
  /// buffered an untrusted response. A task-specific redirect delegate also
  /// protects injected URLSessions; no bearer is replayed onto another URL.
  nonisolated private static func boundedAttachmentResult(
    session: URLSession, request: URLRequest, maxResponseBytes: Int
  ) async throws -> AttachmentHTTPResult {
    let (bytes, response) = try await session.bytes(
      for: request, delegate: AttachmentRedirectDelegate()
    )
    guard let http = response as? HTTPURLResponse else {
      throw CrmAPIError.http(status: -1, code: "invalid_response")
    }
    guard http.url == request.url, !(300..<400).contains(http.statusCode) else {
      throw CrmAPIError.http(status: 502, code: "redirect_forbidden")
    }
    let length: Int?
    if let raw = http.value(forHTTPHeaderField: "Content-Length") {
      guard let parsed = Int(raw), (0...maxResponseBytes).contains(parsed) else {
        throw CrmAPIError.http(status: 502, code: "attachment_response_too_large")
      }
      length = parsed
    } else {
      length = nil
    }
    if let encoding = http.value(forHTTPHeaderField: "Content-Encoding"),
      encoding.lowercased() != "identity"
    {
      throw CrmAPIError.http(status: 502, code: "attachment_encoding_forbidden")
    }
    var data = Data()
    data.reserveCapacity(length ?? min(maxResponseBytes, 64 * 1_024))
    for try await byte in bytes {
      guard data.count < maxResponseBytes else {
        throw CrmAPIError.http(status: 502, code: "attachment_response_too_large")
      }
      data.append(byte)
      if data.count.isMultiple(of: 64 * 1_024) { try Task.checkCancellation() }
    }
    return AttachmentHTTPResult(
      status: http.statusCode,
      body: data,
      retryAfter: http.value(forHTTPHeaderField: "Retry-After"),
      contentType: http.value(forHTTPHeaderField: "Content-Type"),
      contentLength: length,
      effectiveURL: http.url,
      objectVersion: http.value(forHTTPHeaderField: "X-Attachment-Object-Version")
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
