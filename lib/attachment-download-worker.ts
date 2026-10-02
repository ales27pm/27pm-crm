import { attachmentDownloadDecision } from "./attachments";
import { boundedRequest } from "./bounded-request";
import { pruneExpiredInternalApiNonces } from "./internal-api-nonce-store";
import {
  attachmentDownloadPath,
  attachmentDownloadReplayKey,
  attachmentObjectDigest,
  attachmentObjectMatches,
  canonicalAttachmentDownloadOrigin,
  safeAttachmentContentDisposition,
  validAttachmentDownloadSigningSecret,
  verifyAttachmentDownloadTicket,
  type AttachmentDownloadRecord,
  type AttachmentObjectMetadata,
} from "./attachment-download";

type DownloadRow = AttachmentDownloadRecord & { scanStatus: string };

type D1RunResult = {
  success: boolean;
  meta?: { changes?: number };
};

type D1Statement = {
  bind(...values: unknown[]): D1Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1RunResult>;
};

type AttachmentDownloadDatabase = {
  prepare(query: string): D1Statement;
};

type AttachmentObjectBody = AttachmentObjectMetadata & {
  body: ReadableStream<Uint8Array>;
};

type AttachmentDownloadBucket = {
  head(key: string): Promise<AttachmentObjectMetadata | null>;
  get(
    key: string,
    options: { onlyIf: { etagMatches: string } },
  ): Promise<AttachmentObjectBody | AttachmentObjectMetadata | null>;
};

export type AttachmentDownloadEnvironment = {
  DB: AttachmentDownloadDatabase;
  BUCKET: AttachmentDownloadBucket;
  CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY?: string;
  CRM_ATTACHMENT_DOWNLOAD_ORIGIN?: string;
};

type AttachmentDownloadExecutionContext = {
  waitUntil(promise: Promise<unknown>): void;
};

const DOWNLOAD_PATH = /^\/downloads\/attachments\/([A-Za-z0-9_-]{1,128})$/u;
const MAXIMUM_TICKET_BODY_BYTES = 8 * 1_024;
const FORM_CONTENT_TYPE = "application/x-www-form-urlencoded";

export async function handleAttachmentDownloadRequest(
  request: Request,
  environment: AttachmentDownloadEnvironment,
  now = new Date(),
  context?: AttachmentDownloadExecutionContext,
): Promise<Response | null> {
  const url = new URL(request.url);
  const match = DOWNLOAD_PATH.exec(url.pathname);
  if (!match) return null;

  const configuredOrigin = canonicalAttachmentDownloadOrigin(
    environment.CRM_ATTACHMENT_DOWNLOAD_ORIGIN,
  );
  if (
    !configuredOrigin ||
    !validAttachmentDownloadSigningSecret(
      environment.CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY,
    )
  ) return downloadError(503, "attachment_download_unavailable");
  if (url.origin !== configuredOrigin) {
    return downloadError(403, "attachment_download_origin_forbidden");
  }
  if (url.search) {
    return downloadError(400, "attachment_download_query_forbidden");
  }
  if (request.method !== "POST") {
    return downloadError(405, "attachment_download_method_not_allowed", {
      allow: "POST",
    });
  }
  if (request.headers.has("range")) {
    return downloadError(400, "attachment_range_not_supported");
  }
  if (request.headers.has("content-encoding")) {
    return downloadError(415, "attachment_download_content_encoding_invalid");
  }
  const contentType = request.headers.get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== FORM_CONTENT_TYPE) {
    return downloadError(415, "attachment_download_content_type_invalid");
  }
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength)) {
      return downloadError(400, "attachment_download_content_length_invalid");
    }
    const declaredBytes = Number(contentLength);
    if (
      !Number.isSafeInteger(declaredBytes) ||
      declaredBytes > MAXIMUM_TICKET_BODY_BYTES
    ) {
      return downloadError(413, "attachment_download_request_too_large");
    }
  }
  const bounded = await boundedRequest(request, MAXIMUM_TICKET_BODY_BYTES);
  if (!bounded) {
    return downloadError(413, "attachment_download_request_too_large");
  }
  let ticketToken: string;
  try {
    const fields = [...new URLSearchParams(await bounded.text()).entries()];
    if (
      fields.length !== 1 ||
      fields[0]?.[0] !== "ticket" ||
      !fields[0][1]
    ) return downloadError(401, "attachment_download_invalid");
    ticketToken = fields[0][1];
  } catch {
    return downloadError(400, "attachment_download_request_invalid");
  }

  const attachmentId = match[1];
  const pathname = attachmentDownloadPath(attachmentId);
  const claims = await verifyAttachmentDownloadTicket(
    environment.CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY,
    ticketToken,
    { attachmentId, origin: configuredOrigin, pathname },
    now,
  );
  if (!claims) return downloadError(401, "attachment_download_invalid");

  let attachment: DownloadRow | null;
  try {
    attachment = await environment.DB
      .prepare(
        `SELECT r2_key AS r2Key, file_name AS fileName,
                size_bytes AS sizeBytes, sha256,
                scan_status AS scanStatus
         FROM attachments WHERE id = ? LIMIT 1`,
      )
      .bind(attachmentId)
      .first<DownloadRow>();
  } catch {
    return downloadError(503, "attachment_download_store_unavailable");
  }
  if (!attachment) return downloadError(404, "attachment_not_found");

  const decision = attachmentDownloadDecision(attachment.scanStatus);
  if (!decision.allowed) return downloadError(decision.status, decision.code);

  let object: AttachmentObjectMetadata | null;
  try {
    object = await environment.BUCKET.head(attachment.r2Key);
  } catch {
    return downloadError(503, "attachment_object_store_unavailable");
  }
  if (!object) return downloadError(404, "attachment_object_not_found");
  if (!attachmentObjectMatches(attachment, object)) {
    return downloadError(423, "attachment_integrity_unverified");
  }

  let objectDigest: string;
  try {
    objectDigest = await attachmentObjectDigest({
      attachmentId,
      attachment,
      object,
    });
  } catch {
    return downloadError(423, "attachment_integrity_unverified");
  }
  if (objectDigest !== claims.objectDigest) {
    return downloadError(409, "attachment_object_changed");
  }

  let consumed = false;
  try {
    const nonceKey = await attachmentDownloadReplayKey(claims.nonce);
    const expiresAt = new Date(claims.expiresAt * 1000).toISOString();
    const result = await environment.DB
      .prepare(
        `INSERT INTO internal_api_nonces (nonce, expires_at)
         SELECT ?, ?
         WHERE EXISTS (
           SELECT 1 FROM attachments
           WHERE id = ? AND r2_key = ? AND size_bytes = ? AND sha256 = ?
             AND scan_status = 'clean'
         )
         ON CONFLICT(nonce) DO NOTHING`,
      )
      .bind(
        nonceKey,
        expiresAt,
        attachmentId,
        attachment.r2Key,
        attachment.sizeBytes,
        attachment.sha256,
      )
      .run();
    consumed = result.success && result.meta?.changes === 1;
  } catch {
    return downloadError(503, "attachment_download_store_unavailable");
  }
  if (!consumed) {
    return downloadError(401, "attachment_download_used_or_changed");
  }
  context?.waitUntil(
    pruneExpiredInternalApiNonces(environment.DB, now).catch(() => undefined),
  );

  let getResult: AttachmentObjectBody | AttachmentObjectMetadata | null;
  try {
    getResult = await environment.BUCKET.get(attachment.r2Key, {
      onlyIf: { etagMatches: object.etag },
    });
  } catch {
    return downloadError(503, "attachment_object_store_unavailable");
  }
  if (!getResult || !("body" in getResult) || !getResult.body) {
    return downloadError(409, "attachment_object_changed");
  }
  const bodyObject = getResult;

  try {
    const currentDigest = await attachmentObjectDigest({
      attachmentId,
      attachment,
      object: bodyObject,
    });
    if (
      !attachmentObjectMatches(attachment, bodyObject) ||
      currentDigest !== claims.objectDigest
    ) {
      await bodyObject.body.cancel().catch(() => undefined);
      return downloadError(409, "attachment_object_changed");
    }
  } catch {
    await bodyObject.body.cancel().catch(() => undefined);
    return downloadError(409, "attachment_object_changed");
  }

  return new Response(bodyObject.body, {
    headers: {
      ...downloadResponseHeaders(),
      "content-disposition": safeAttachmentContentDisposition(
        attachment.fileName,
      ),
      "content-length": String(bodyObject.size),
      "content-type": "application/octet-stream",
    },
  });
}

function downloadError(
  status: number,
  error: string,
  headers: HeadersInit = {},
): Response {
  return Response.json(
    { error },
    {
      status,
      headers: { ...downloadResponseHeaders(), ...headers },
    },
  );
}

function downloadResponseHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store, max-age=0",
    "content-security-policy": "sandbox; default-src 'none'",
    "cross-origin-resource-policy": "same-site",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  };
}
