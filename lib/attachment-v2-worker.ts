import type { CrmDatabase } from "./d1";
import type { PrivateObjectBucket } from "./runtime";
import { activeMobileSession } from "./mobile-auth-store";
import { hasMobileScope, mobileBearerToken, verifyMobileAccessToken } from "./mobile-auth";
import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_TRANSPORT, MAX_ATTACHMENT_BYTES,
  AttachmentV2Error, attachmentV2ErrorResponse, isUuid, readBoundedBytes,
  attachmentClock, type AttachmentClockInput,
} from "./attachment-v2-protocol";
import { SCANNER_API_PREFIX, verifyScannerRequest } from "./attachment-scanner-auth";
import {
  claimScanJob, enqueueScanJob, recordScanFailure, recordScannerHeartbeat, renewScanJob,
  scannerFresh, validScanLease, type ScanLease,
} from "./attachment-scan-store";
import { authorizedScanObject, completeScanJob, scannedAttachment } from "./attachment-scan-service";
import {
  createUpload, deleteAttachment, getAttachment, listAttachments, requireAttachmentOwner,
  uploadStatus, validAttachmentOwner, type AttachmentV2Identity,
} from "./attachment-v2-store";
import { attachmentDownloadManifest, finishUpload, putUploadChunk, readAttachmentChunk } from "./attachment-v2-transfer";

export type AttachmentV2Environment = {
  DB: CrmDatabase;
  BUCKET: PrivateObjectBucket;
  ATTACHMENTS_V2_ENABLED?: string;
  CRM_ATTACHMENT_SCANNER_ENABLED?: string;
  CRM_SCANNER_KEY_ID?: string;
  CRM_SCANNER_ID?: string;
  CRM_SCANNER_SIGNING_KEY?: string;
  CRM_MOBILE_TOKEN_SIGNING_KEY?: string;
  CRM_PUBLIC_ORIGIN?: string;
  CRM_ADMIN_EMAILS?: string;
};
const UPLOADS = "/api/mobile/attachment-uploads";
const ATTACHMENTS = "/api/mobile/attachments";
const CAPABILITIES = "/api/mobile/capabilities";
const json = (value: unknown, status = 200): Response => Response.json(value, {
  status, headers: { "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" },
});
const error = (status: number, code: string): never => { throw new AttachmentV2Error(status, code); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return error(400, "attachment_validation_failed");
  return value as Record<string, unknown>;
}
async function payload(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.has("content-encoding")
    || !/^application\/json(?:\s*;|$)/iu.test(request.headers.get("content-type") ?? "")) return error(400, "attachment_content_type_invalid");
  try { return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedBytes(request.body, 16 * 1024, request.signal)))); }
  catch (cause) { if (cause instanceof AttachmentV2Error) throw cause; return error(400, "attachment_validation_failed"); }
}
async function identity(request: Request, env: AttachmentV2Environment, write: boolean, clock: () => Date): Promise<AttachmentV2Identity> {
  // Intentionally no browser-cookie / forwarded-email / machine-role fallback.
  const bearer = mobileBearerToken(request);
  if (!bearer) return error(401, "authentication_required");
  if (!env.CRM_MOBILE_TOKEN_SIGNING_KEY || env.CRM_PUBLIC_ORIGIN !== "https://crm.27pm.org") return error(503, "mobile_authentication_unavailable");
  if ((request.headers.has("origin") && request.headers.get("origin") !== env.CRM_PUBLIC_ORIGIN)
    || (request.headers.has("sec-fetch-site") && request.headers.get("sec-fetch-site") !== "same-origin")) {
    return error(403, "cross_origin_request_forbidden");
  }
  const claims = await verifyMobileAccessToken(env.CRM_MOBILE_TOKEN_SIGNING_KEY, bearer, env.CRM_PUBLIC_ORIGIN, clock());
  if (!claims) return error(401, "mobile_token_invalid");
  if (!hasMobileScope(claims, write ? "crm:work" : "crm:dashboard:read")) return error(403, "mobile_scope_forbidden");
  const operator = await activeMobileSession(env.DB, claims, env.CRM_ADMIN_EMAILS, clock());
  if (!operator?.mobileSessionId) return error(401, "mobile_session_invalid");
  if (claims.expiresAt <= Math.floor(clock().valueOf() / 1000)) return error(401, "mobile_token_invalid");
  return { creator: operator.email, sessionId: operator.mobileSessionId };
}
async function schemaReady(db: CrmDatabase): Promise<boolean> {
  try {
    for (const query of [
      "SELECT id,object_version,sha256 FROM attachment_v2_objects WHERE 0",
      "SELECT id,manifest_json,state,lease_expires_at FROM attachment_v2_uploads WHERE 0",
      "SELECT upload_id,part_index,object_version FROM attachment_v2_chunks WHERE 0",
      "SELECT id,generation,receipt_key,policy FROM attachment_scan_jobs WHERE 0",
      "SELECT scanner_id,heartbeat_at FROM attachment_scanner_heartbeats WHERE 0",
      "SELECT nonce,expires_at FROM attachment_scanner_request_nonces WHERE 0",
    ]) if (!(await db.prepare(query).all()).success) return false;
    return true;
  } catch { return false; }
}
function leaseFrom(value: Record<string, unknown>, scannerId: string): ScanLease {
  const lease = { jobId: value.jobId, scannerId: value.scannerId, leaseToken: value.leaseToken, generation: value.generation };
  if (lease.scannerId !== scannerId || typeof lease.jobId !== "string" || typeof lease.leaseToken !== "string"
    || typeof lease.generation !== "number" || !validScanLease(lease as ScanLease)) return error(403, "scanner_lease_invalid");
  return lease as ScanLease;
}
function chunkResponse(part: { body: Uint8Array; byteSize: number; objectVersion: string }): Response {
  return new Response(new Uint8Array(part.body), { headers: { "content-type": "application/octet-stream",
    "content-length": String(part.byteSize), "x-attachment-object-version": part.objectVersion,
    "cache-control": "private, no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff" } });
}

async function machine(request: Request, env: AttachmentV2Environment, clock: () => Date): Promise<Response> {
  if (env.CRM_ATTACHMENT_SCANNER_ENABLED !== "1") return error(503, "attachment_scanner_disabled");
  const url = new URL(request.url), suffix = url.pathname.slice(SCANNER_API_PREFIX.length);
  if (request.method !== "POST" || url.search) return error(405, "scanner_route_forbidden");
  const credentials = { keyId: env.CRM_SCANNER_KEY_ID ?? "", scannerId: env.CRM_SCANNER_ID ?? "", signingKey: env.CRM_SCANNER_SIGNING_KEY ?? "" };
  const authenticated = await verifyScannerRequest(request, credentials, env.DB, clock);
  let data: Record<string, unknown>;
  try { data = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(authenticated.body))); }
  catch { return error(400, "scanner_payload_invalid"); }
  const scannerId = authenticated.scannerId;
  if (suffix === "heartbeat") {
    if (typeof data.engineVersion !== "string" || typeof data.signatureVersion !== "string" || typeof data.signatureUpdatedAt !== "string"
      || !await recordScannerHeartbeat(env.DB, scannerId, { engineVersion: data.engineVersion,
        signatureVersion: data.signatureVersion, signatureUpdatedAt: data.signatureUpdatedAt }, clock())) return error(400, "scanner_heartbeat_invalid");
    return json({ ok: true });
  }
  if (suffix === "claim") {
    const claimed = await claimScanJob(env.DB, scannerId, clock());
    if (!claimed) return new Response(null, { status: 204, headers: { "cache-control": "private, no-store" } });
    const { job, lease } = claimed;
    return json({ ...lease, leaseExpiresAt: job.leaseExpiresAt, byteSize: job.byteSize,
      sha256: job.sha256, objectVersion: job.objectVersion, chunkBytes: ATTACHMENT_CHUNK_BYTES,
      chunkCount: Math.ceil(job.byteSize / ATTACHMENT_CHUNK_BYTES) });
  }
  const match = /^jobs\/([0-9a-f-]{36})\/(renew|complete|fail|chunks\/(0|[1-9]))$/u.exec(suffix);
  if (!match || !isUuid(match[1])) return error(404, "scanner_route_not_found");
  const lease = leaseFrom(data, scannerId);
  if (lease.jobId !== match[1]) return error(403, "scanner_lease_invalid");
  if (match[2] === "renew") {
    const renewed = await renewScanJob(env.DB, lease, clock());
    if (!renewed) return error(409, "scanner_lease_expired");
    return json({ leaseExpiresAt: renewed.leaseExpiresAt });
  }
  if (match[2] === "complete") {
    const result = await completeScanJob(env.DB, env.BUCKET, lease, data.verdict, clock);
    if (result === "rejected") return error(409, "scanner_result_rejected");
    return json({ status: result });
  }
  if (match[2] === "fail") {
    if (typeof data.code !== "string" || !await recordScanFailure(env.DB, lease, data.code, clock())) return error(409, "scanner_failure_rejected");
    return json({ ok: true });
  }
  const authorized = await authorizedScanObject(env.DB, env.BUCKET, lease, clock);
  if (!authorized) return error(409, "scanner_lease_expired");
  const part = await readAttachmentChunk(env.BUCKET, authorized.attachment, Number(match[3]), authorized.job.objectVersion, async () => {
    if (!await authorizedScanObject(env.DB, env.BUCKET, lease, clock)) return error(409, "scanner_lease_expired");
  });
  return chunkResponse(part);
}

/** Narrow versioned routes, dispatched before the legacy operator identity bridge. */
export async function handleAttachmentV2Request(
  request: Request, env: AttachmentV2Environment, now: AttachmentClockInput = () => new Date(),
): Promise<Response | null> {
  const clock = attachmentClock(now);
  const url = new URL(request.url), path = url.pathname;
  const isMachine = path.startsWith(SCANNER_API_PREFIX);
  const isMobile = path === CAPABILITIES || path === UPLOADS || path.startsWith(UPLOADS + "/")
    || path === ATTACHMENTS || path.startsWith(ATTACHMENTS + "/");
  if (!isMachine && !isMobile) return null;
  try {
    if (isMachine) return await machine(request, env, clock);
    if (env.ATTACHMENTS_V2_ENABLED !== "1") {
      if (path !== CAPABILITIES) return error(503, "attachment_transport_disabled");
      await identity(request, env, false, clock);
      return json({ attachments: false });
    }
    const write = !["GET", "HEAD"].includes(request.method);
    const actor = await identity(request, env, write, clock);
    const authorize = async () => {
      const current = await identity(request, env, write, clock);
      if (current.creator !== actor.creator || current.sessionId !== actor.sessionId) return error(401, "mobile_session_invalid");
    };
    if (path === CAPABILITIES) {
      if (request.method !== "GET") return error(405, "attachment_method_forbidden");
      const ready = request.headers.get("x-27pm-attachment-transport") === ATTACHMENT_TRANSPORT
        && env.CRM_ATTACHMENT_SCANNER_ENABLED === "1" && await schemaReady(env.DB) && await scannerFresh(env.DB, clock());
      return json({ attachments: ready, transport: ATTACHMENT_TRANSPORT,
        maxFileBytes: MAX_ATTACHMENT_BYTES, chunkBytes: ATTACHMENT_CHUNK_BYTES });
    }
    if (request.headers.has("range") || request.headers.has("content-encoding") || request.headers.has("transfer-encoding")) return error(400, "attachment_encoding_forbidden");
    if (path === UPLOADS && request.method === "POST") {
      if (url.search) return error(400, "attachment_query_forbidden");
      const manifest = await payload(request);
      await authorize();
      return json(await createUpload(env.DB, manifest, actor, request.headers.get("idempotency-key") ?? "", clock), 201);
    }
    const upload = /^\/api\/mobile\/attachment-uploads\/([0-9a-f-]{36})(?:\/(complete|chunks\/(0|[1-9])))?$/u.exec(path);
    if (upload) {
      if (!isUuid(upload[1]) || url.search) return error(400, "attachment_validation_failed");
      if (!upload[2] && request.method === "GET") return json(await uploadStatus(env.DB, upload[1], actor, clock));
      if (upload[2] === "complete" && request.method === "POST") {
        const status = await finishUpload(env.DB, env.BUCKET, upload[1], actor, clock, authorize);
        if (status.attachmentId) await enqueueScanJob(env.DB, status.attachmentId, clock()).catch(() => undefined);
        return json(status, status.state === "committed" ? 200 : 202);
      }
      if (upload[3] !== undefined && request.method === "PUT") {
        if (request.headers.get("content-type") !== "application/octet-stream") return error(400, "attachment_content_type_invalid");
        return json(await putUploadChunk(env.DB, env.BUCKET, upload[1], Number(upload[3]), request.body, actor, clock, authorize));
      }
      return error(405, "attachment_method_forbidden");
    }
    if (path === ATTACHMENTS && request.method === "GET") {
      const kind = url.searchParams.get("ownerKind"), id = url.searchParams.get("ownerId");
      if (!validAttachmentOwner(kind, id) || !id || [...url.searchParams.keys()].sort().join(",") !== "ownerId,ownerKind") return error(400, "attachment_validation_failed");
      return json({ attachments: await listAttachments(env.DB, kind, id) });
    }
    const attachment = /^\/api\/mobile\/attachments\/([0-9a-f-]{36})(?:\/(manifest|chunks\/(0|[1-9])|file))?$/u.exec(path);
    if (!attachment || !isUuid(attachment[1])) return error(404, "attachment_route_not_found");
    const row = await getAttachment(env.DB, attachment[1]);
    if (!row) return error(404, "attachment_not_found");
    await requireAttachmentOwner(env.DB, row.owner_kind, row.owner_id);
    if (!attachment[2] && request.method === "DELETE") {
      if (url.search) return error(400, "attachment_query_forbidden");
      await deleteAttachment(env.DB, row.id, clock());
      return json({ deleted: true });
    }
    if (request.method !== "GET") return error(405, "attachment_method_forbidden");
    if (attachment[2] === "file") return error(503, "attachment_chunked_transport_required");
    await enqueueScanJob(env.DB, row.id, clock());
    const verified = await scannedAttachment(env.DB, env.BUCKET, row.id, clock);
    if (!verified) return error(423, "attachment_quarantined");
    await authorize();
    if (attachment[2] === "manifest") {
      if (url.search) return error(400, "attachment_query_forbidden");
      return json(attachmentDownloadManifest(verified));
    }
    if (attachment[3] !== undefined && [...url.searchParams.keys()].join(",") === "version") {
      const part = await readAttachmentChunk(env.BUCKET, verified, Number(attachment[3]), url.searchParams.get("version") ?? "", async () => {
        const current = await scannedAttachment(env.DB, env.BUCKET, row.id, clock);
        if (!current || current.object_version !== verified.object_version) return error(423, "attachment_quarantined");
        await authorize();
      });
      return chunkResponse(part);
    }
    return error(400, "attachment_validation_failed");
  } catch (cause) { return attachmentV2ErrorResponse(cause); }
}
