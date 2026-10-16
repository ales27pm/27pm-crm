import CryptoKit
import Foundation
import Testing
@testable import App27pmCRM

/// Exercises the real protocol state machine at its bounded HTTP boundary.
/// URLSession streaming/redirect behaviour still requires an Apple runtime.
@Suite @MainActor
struct ChunkedAttachmentTransportTests {
  private let uploadID = "8b719718-3610-493e-9e94-87e24d3c4f0d"
  private let attachmentID = "cfbb375d-830e-4946-9bcf-34a5136d9c85"
  private let chunkBytes = 2_097_152

  private func reply(
    _ request: URLRequest, status: Int = 200, body: Data,
    contentType: String = "application/json", version: String? = nil,
    retryAfter: String? = nil
  ) -> AttachmentHTTPResult {
    AttachmentHTTPResult(
      status: status, body: body, retryAfter: retryAfter,
      contentType: contentType, contentLength: body.count,
      effectiveURL: request.url, objectVersion: version
    )
  }

  private func json(_ object: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
  }

  private func hash(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  private func status(
    byteSize: Int, received: [Int], state: String = "uploading",
    committedID: String? = nil
  ) throws -> Data {
    var object: [String: Any] = [
      "id": uploadID, "state": state, "byteSize": byteSize,
      "chunkBytes": chunkBytes, "chunkCount": (byteSize + chunkBytes - 1) / chunkBytes,
      "receivedChunks": received,
    ]
    if let committedID { object["attachmentId"] = committedID }
    return try json(object)
  }

  private func manifest(
    data: Data, version: String = "version-one", overrideHash: String? = nil
  ) throws -> Data {
    try json([
      "id": attachmentID, "byteSize": data.count, "sha256": overrideHash ?? hash(data),
      "objectVersion": version, "chunkBytes": chunkBytes,
      "chunkCount": (data.count + chunkBytes - 1) / chunkBytes,
      "contentType": "application/pdf",
    ])
  }

  private func client(
    token: @escaping () -> String? = { "device-session-one" },
    loader: @escaping CrmAPIClient.AttachmentResponseLoader
  ) -> CrmAPIClient {
    CrmAPIClient(
      baseURL: CrmAPIConfig.canonicalOriginURL, accessTokenProvider: token,
      attachmentResponseLoader: loader
    )
  }

  private func upload(_ client: CrmAPIClient, data: Data) async throws -> AttachmentHTTPResult {
    try await client.uploadAttachment(
      fileData: data, fileName: "dossier.pdf", mimeType: "application/pdf",
      ownerKind: "account", ownerId: "account-one", idempotencyKey: "persisted-upload-key"
    )
  }

  @Test func capabilitiesRequireExplicitV2NegotiationAndAllExactLimits() async throws {
    let payloads: [[String: Any]] = [
      ["attachments": true],
      ["attachments": true, "transport": "multipart-v1", "maxFileBytes": 20_971_520, "chunkBytes": chunkBytes],
      ["attachments": true, "transport": "chunked-v2", "maxFileBytes": 20_971_519, "chunkBytes": chunkBytes],
      ["attachments": true, "transport": "chunked-v2", "maxFileBytes": 20_971_520, "chunkBytes": 4_194_304],
      ["attachments": false, "transport": "chunked-v2", "maxFileBytes": 20_971_520, "chunkBytes": chunkBytes],
      ["attachments": true, "transport": "chunked-v2", "maxFileBytes": 20_971_520, "chunkBytes": chunkBytes],
    ]
    for (index, payload) in payloads.enumerated() {
      let api = client { [self] request, limit in
        #expect(request.url?.absoluteString == "https://crm.27pm.org/api/mobile/capabilities")
        #expect(request.value(forHTTPHeaderField: "X-27PM-Attachment-Transport") == "chunked-v2")
        #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer device-session-one")
        #expect(limit == 65_536)
        return reply(request, body: try json(payload))
      }
      let supported = await api.probeAttachmentsSupport()
      #expect(supported == (index == payloads.count - 1))
    }
  }

  @Test func twentyMiBUploadHasTenBoundedChunksAndPreservesStableKey() async throws {
    let data = Data(repeating: 0x5A, count: 20_971_520)
    var received: [Int] = []
    var methods: [String] = []
    let api = client { [self] request, limit in
      methods.append(request.httpMethod ?? "GET")
      #expect(request.url?.host == "crm.27pm.org")
      #expect(request.value(forHTTPHeaderField: "Authorization") == "Bearer device-session-one")
      #expect(limit == 65_536)
      let path = try #require(request.url?.path)
      if path == "/api/mobile/attachment-uploads" {
        #expect(request.value(forHTTPHeaderField: "Idempotency-Key") == "persisted-upload-key")
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/json")
        let body = try #require(request.httpBody)
        let object = try #require(JSONSerialization.jsonObject(with: body) as? [String: Any])
        let descriptors = try #require(object["chunks"] as? [[String: Any]])
        #expect(object["byteSize"] as? Int == 20_971_520)
        #expect(object["sha256"] as? String == hash(data))
        #expect(descriptors.count == 10)
        #expect(descriptors.allSatisfy { $0["byteSize"] as? Int == chunkBytes })
        return reply(request, status: 201, body: try status(byteSize: data.count, received: []))
      }
      if request.httpMethod == "PUT" {
        let index = try #require(Int(path.split(separator: "/").last ?? ""))
        #expect(request.httpBody?.count == chunkBytes)
        #expect(request.value(forHTTPHeaderField: "Content-Type") == "application/octet-stream")
        received.append(index)
      }
      if path.hasSuffix("/complete") {
        return reply(request, body: try status(
          byteSize: data.count, received: received, state: "committed", committedID: attachmentID
        ))
      }
      return reply(request, body: try status(byteSize: data.count, received: received))
    }
    let result = try await upload(api, data: data)
    #expect(result.status == 200)
    #expect(try JSONSerialization.jsonObject(with: result.body) as? [String: String] == ["id": attachmentID])
    #expect(received == Array(0..<10))
    #expect(methods == ["POST", "GET"] + Array(repeating: "PUT", count: 10) + ["POST"])
  }

  @Test func serverAcknowledgementsResumeAfterClientRecreationWithoutReupload() async throws {
    let data = Data(repeating: 0x47, count: chunkBytes + 3)
    var received: [Int] = []
    var creationKeys: [String] = []
    var puts: [Int] = []
    var dropFirstAcknowledgement = true
    let loader: CrmAPIClient.AttachmentResponseLoader = { [self] request, _ in
      let path = try #require(request.url?.path)
      if path == "/api/mobile/attachment-uploads" {
        creationKeys.append(request.value(forHTTPHeaderField: "Idempotency-Key") ?? "")
      }
      if request.httpMethod == "PUT" {
        let index = try #require(Int(path.split(separator: "/").last ?? ""))
        puts.append(index)
        received.append(index)
        if dropFirstAcknowledgement {
          dropFirstAcknowledgement = false
          throw URLError(.networkConnectionLost)
        }
      }
      if path.hasSuffix("/complete") {
        return reply(request, body: try status(
          byteSize: data.count, received: received, state: "committed", committedID: attachmentID
        ))
      }
      return reply(request, body: try status(byteSize: data.count, received: received))
    }
    await #expect(throws: URLError.self) { try await upload(client(loader: loader), data: data) }
    let recovered = try await upload(client(loader: loader), data: data)
    #expect(recovered.status == 200)
    #expect(creationKeys == ["persisted-upload-key", "persisted-upload-key"])
    #expect(puts == [0, 1])
  }

  @Test func pendingCompletionIsNotAnUploadAcknowledgement() async throws {
    let data = Data([1, 2, 3])
    var calls = 0
    let api = client { [self] request, _ in
      calls += 1
      return reply(
        request, body: try status(byteSize: data.count, received: [0], state: "finalizing"),
        retryAfter: "45"
      )
    }
    let result = try await upload(api, data: data)
    #expect(calls == 3)
    #expect(result.status == 503)
    #expect(result.retryAfter == "45")
    #expect(String(data: result.body, encoding: .utf8)?.contains("attachment_upload_pending") == true)
  }

  @Test func committedCreateNeedsNoChunksAndReturnsOnlyAttachmentIdentifier() async throws {
    var calls = 0
    let api = client { [self] request, _ in
      calls += 1
      return reply(request, body: try status(
        byteSize: 3, received: [0], state: "committed", committedID: attachmentID
      ))
    }
    let result = try await upload(api, data: Data([1, 2, 3]))
    #expect(calls == 1)
    #expect(result.status == 200)
    #expect(try JSONSerialization.jsonObject(with: result.body) as? [String: String] == ["id": attachmentID])
  }

  @Test func firstAuthenticationAuthorizationOrQuarantineFailureStopsEveryLaterRequest() async throws {
    for statusCode in [401, 403, 423] {
      var calls = 0
      let api = client { [self] request, _ in
        calls += 1
        return reply(
          request, status: statusCode, body: try json(["error": "policy_rejection"]), retryAfter: "60"
        )
      }
      let result = try await upload(api, data: Data([1, 2, 3]))
      #expect(result.status == statusCode)
      #expect(result.retryAfter == "60")
      #expect(calls == 1)
    }
  }

  @Test func sessionRotationDuringAwaitStopsBeforeTheNextRequest() async {
    var token: String? = "session-one"
    var calls = 0
    let api = client(token: { token }) { [self] request, _ in
      calls += 1
      token = "session-two"
      return reply(request, body: try status(byteSize: 3, received: []))
    }
    await #expect(throws: CrmAPIError.http(status: 401, code: "authentication_session_changed")) {
      try await upload(api, data: Data([1, 2, 3]))
    }
    #expect(calls == 1)
  }

  @Test func oversizedOrEmptyFileNeverCreatesRemoteUpload() async {
    var calls = 0
    let api = client { [self] request, _ in
      calls += 1
      return reply(request, body: Data())
    }
    for data in [Data(), Data(repeating: 0x42, count: 20_971_521)] {
      await #expect(throws: CrmAPIError.http(status: 422, code: "invalid_upload_manifest")) {
        try await upload(api, data: data)
      }
    }
    #expect(calls == 0)
  }

  @Test func unknownOrUnacknowledgedServerStateFailsClosed() async {
    for state in ["processing", "uploading"] {
      var calls = 0
      let api = client { [self] request, _ in
        calls += 1
        return reply(request, body: try status(byteSize: 3, received: [], state: state))
      }
      do {
        _ = try await upload(api, data: Data([1, 2, 3]))
        Issue.record("Invalid state or missing chunk acknowledgement was accepted")
      } catch let error as CrmAPIError {
        if state == "processing" {
          #expect(error == .http(status: 503, code: "invalid_upload_status"))
          #expect(calls == 1)
        } else {
          #expect(error == .http(status: 502, code: "invalid_chunk_acknowledgement"))
          #expect(calls == 3)
        }
      } catch { Issue.record("Unexpected error: \(error)") }
    }
  }

  @Test func verifiedDownloadReassemblesVersionPinnedChunks() async throws {
    let data = Data(repeating: 0x63, count: chunkBytes + 7)
    var chunks: [Int] = []
    let api = client { [self] request, limit in
      let path = try #require(request.url?.path)
      if path.hasSuffix("/manifest") { return reply(request, body: try manifest(data: data)) }
      let index = try #require(Int(path.split(separator: "/").last ?? ""))
      chunks.append(index)
      #expect(request.url?.query == "version=version-one")
      let start = index * chunkBytes
      let bytes = data.subdata(in: start..<min(start + chunkBytes, data.count))
      #expect(limit == max(bytes.count, 65_536))
      return reply(request, body: bytes, contentType: "application/octet-stream", version: "version-one")
    }
    let result = try await api.downloadAttachment(id: attachmentID)
    #expect(result.status == 200)
    #expect(result.body == data)
    #expect(result.contentLength == data.count)
    #expect(result.contentType == "application/pdf")
    #expect(chunks == [0, 1])
  }

  @Test func changedOrMissingChunkVersionNeverReturnsPartialFile() async {
    let data = Data([1, 2, 3])
    for version in [nil, "replacement-version"] {
      let api = client { [self] request, _ in
        if request.url?.path.hasSuffix("/manifest") == true {
          return reply(request, body: try manifest(data: data))
        }
        return reply(request, body: data, contentType: "application/octet-stream", version: version)
      }
      await #expect(throws: CrmAPIError.http(status: 502, code: "attachment_chunk_mismatch")) {
        try await api.downloadAttachment(id: attachmentID)
      }
    }
  }

  @Test func mismatchedFullHashNeverReturnsAnApparentlySuccessfulFile() async {
    let data = Data([1, 2, 3])
    let api = client { [self] request, _ in
      if request.url?.path.hasSuffix("/manifest") == true {
        return reply(request, body: try manifest(data: data, overrideHash: String(repeating: "0", count: 64)))
      }
      return reply(request, body: data, contentType: "application/octet-stream", version: "version-one")
    }
    await #expect(throws: CrmAPIError.http(status: 502, code: "attachment_integrity_mismatch")) {
      try await api.downloadAttachment(id: attachmentID)
    }
  }

  @Test func quarantineBetweenDownloadChunksStopsWithoutFetchingLaterBytes() async throws {
    let data = Data(repeating: 0x73, count: chunkBytes + 1)
    var calls = 0
    let api = client { [self] request, _ in
      calls += 1
      if request.url?.path.hasSuffix("/manifest") == true {
        return reply(request, body: try manifest(data: data))
      }
      return reply(request, status: 423, body: try json(["error": "attachment_quarantined"]), retryAfter: "90")
    }
    let result = try await api.downloadAttachment(id: attachmentID)
    #expect(result.status == 423)
    #expect(result.retryAfter == "90")
    #expect(calls == 2)
  }

  @Test func oversizedResponseIsRejectedEvenWhenTheHeaderLies() async {
    let api = client { [self] request, limit in
      var result = reply(request, body: Data(repeating: 0, count: limit + 1))
      result = AttachmentHTTPResult(
        status: result.status, body: result.body, retryAfter: nil,
        contentType: result.contentType, contentLength: 10, effectiveURL: result.effectiveURL
      )
      return result
    }
    await #expect(throws: CrmAPIError.http(status: 502, code: "attachment_response_too_large")) {
      try await api.listAttachments(ownerKind: "account", ownerId: "account-one")
    }
  }

  @Test func redirectOrForeignOriginIsRejectedBeforeAnotherRequest() async {
    var calls = 0
    let api = client { request, _ in
      calls += 1
      return AttachmentHTTPResult(
        status: 200, body: Data(), retryAfter: nil,
        contentType: "application/json", contentLength: 0,
        effectiveURL: URL(string: "https://objects.example.test/private-file")
      )
    }
    await #expect(throws: CrmAPIError.http(status: 502, code: "redirect_forbidden")) {
      try await api.downloadAttachment(id: attachmentID)
    }
    #expect(calls == 1)
  }

  @Test func invalidOriginOrPathIdentifierNeverCallsNetworkLoader() async {
    var calls = 0
    let loader: CrmAPIClient.AttachmentResponseLoader = { [self] request, _ in
      calls += 1
      return reply(request, body: Data())
    }
    let api = CrmAPIClient(
      baseURL: URL(string: "https://api.crm.27pm.org"), accessTokenProvider: { "secret" },
      attachmentResponseLoader: loader
    )
    await #expect(throws: CrmAPIError.invalidConfiguration) {
      try await api.listAttachments(ownerKind: "account", ownerId: "account-one")
    }
    let valid = client(loader: loader)
    await #expect(throws: CrmAPIError.http(status: 422, code: "invalid_attachment_identifier")) {
      try await valid.downloadAttachment(id: "../unrelated")
    }
    #expect(calls == 0)
  }
}
