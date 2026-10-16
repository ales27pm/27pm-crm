import type { CrmDatabase } from "./d1";
import type { AttachmentObjectRow } from "./attachment-v2-protocol";
import {
  ATTACHMENT_CHUNK_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_CHUNKS,
  AttachmentV2Error, attachmentClock, isSha256, isUuid, sha256Hex, type AttachmentClockInput,
} from "./attachment-v2-protocol";

export type AttachmentV2Object = AttachmentObjectRow;
export type AttachmentV2Identity = { creator: string; sessionId: string };
export type AttachmentV2Manifest = {
  ownerKind: AttachmentObjectRow["owner_kind"]; ownerId: string;
  fileName: string; contentType: string; byteSize: number; sha256: string;
  chunks: { byteSize: number; sha256: string }[];
};
export type AttachmentV2Upload = {
  id: string; creator: string; session_id: string; idempotency_key: string;
  manifest_json: string; manifest_sha256: string; byte_size: number;
  state: "uploading" | "finalizing" | "committed" | "cancelled";
  attachment_id: string | null; lease_owner: string | null; lease_expires_at: string | null;
  created_at: string; expires_at: string;
};
export type AttachmentV2Chunk = {
  upload_id: string; part_index: number; byte_size: number; sha256: string;
  storage_key: string; object_version: string; etag: string; created_at: string;
};
export type AttachmentV2UploadStatus = {
  id: string; state: AttachmentV2Upload["state"]; byteSize: number;
  chunkBytes: number; chunkCount: number; receivedChunks: number[];
  attachmentId: string | null; expiresAt: string;
};
const OWNER_TABLES = { account: "organizations", deal: "deals", conversation: "conversations" } as const;
const TYPES = new Set(["image/jpeg", "image/png", "image/heic", "application/pdf", "text/plain", "text/csv",
  "application/msword", "application/vnd.ms-excel", "application/zip", "application/octet-stream"]);
const EXECUTABLE = /\.(?:exe|dll|com|scr|msi|bat|cmd|ps1|sh|js|mjs|cjs|vbs|jar|class|dmg|app|apk)$/iu;
const MAX_ACTIVE_UPLOADS = 3;
const MAX_DAILY_UPLOADS = 40;
const MAX_DAILY_BYTES = 100 * 1024 * 1024;
const UPLOAD_TTL_MS = 60 * 60 * 1000;
const controls = (value: string) => /[\u0000-\u001f\u007f]/u.test(value);
const fail = (status = 400, code = "attachment_validation_failed"): never => { throw new AttachmentV2Error(status, code); };

export function validAttachmentOwner(kind: unknown, id: unknown): kind is AttachmentObjectRow["owner_kind"] {
  return typeof kind === "string" && Object.hasOwn(OWNER_TABLES, kind)
    && typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 256 && !controls(id);
}
export function validateAttachmentManifest(value: unknown): AttachmentV2Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const v = value as Record<string, unknown>;
  if (Object.keys(v).sort().join(",") !== "byteSize,chunks,contentType,fileName,ownerId,ownerKind,sha256"
    || !validAttachmentOwner(v.ownerKind, v.ownerId) || typeof v.fileName !== "string"
    || !v.fileName || v.fileName.length > 255 || controls(v.fileName)
    || /[\\/]/u.test(v.fileName) || v.fileName.normalize("NFKC") !== v.fileName
    || EXECUTABLE.test(v.fileName.replace(/[.\s]+$/u, ""))
    || typeof v.contentType !== "string" || !TYPES.has(v.contentType)
    || !Number.isSafeInteger(v.byteSize) || (v.byteSize as number) <= 0
    || (v.byteSize as number) > MAX_ATTACHMENT_BYTES || !isSha256(v.sha256)
    || !Array.isArray(v.chunks) || v.chunks.length < 1 || v.chunks.length > MAX_ATTACHMENT_CHUNKS
    || v.chunks.length !== Math.ceil((v.byteSize as number) / ATTACHMENT_CHUNK_BYTES)) return fail();
  const chunks = v.chunks.map((part, index) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) return fail();
    const c = part as Record<string, unknown>;
    const expected = Math.min(ATTACHMENT_CHUNK_BYTES, (v.byteSize as number) - index * ATTACHMENT_CHUNK_BYTES);
    if (Object.keys(c).sort().join(",") !== "byteSize,sha256" || c.byteSize !== expected || !isSha256(c.sha256)) return fail();
    return { byteSize: expected, sha256: c.sha256 };
  });
  return { ownerKind: v.ownerKind as AttachmentObjectRow["owner_kind"], ownerId: v.ownerId as string,
    fileName: v.fileName, contentType: v.contentType, byteSize: v.byteSize as number, sha256: v.sha256, chunks };
}
export function validateIdentity(identity: AttachmentV2Identity) {
  if (!identity || typeof identity.creator !== "string" || identity.creator.length < 3 || identity.creator.length > 320
    || controls(identity.creator) || identity.creator.trim() !== identity.creator
    || typeof identity.sessionId !== "string" || !/^[A-Za-z0-9._:@-]{1,256}$/u.test(identity.sessionId)) fail(401, "authentication_required");
}
export async function requireAttachmentOwner(db: CrmDatabase, kind: AttachmentObjectRow["owner_kind"], id: string) {
  if (!validAttachmentOwner(kind, id)) fail();
  const active = kind === "account" ? " AND deleted_at IS NULL" : "";
  if (!await db.prepare(`SELECT id FROM ${OWNER_TABLES[kind]} WHERE id = ?${active}`).bind(id).first()) fail(404, "owner_not_found");
}
/** Fixed identifier selected only from the validated enum, never user SQL. */
export function attachmentOwnerCondition(kind: AttachmentObjectRow["owner_kind"]) {
  if (!Object.hasOwn(OWNER_TABLES, kind)) return fail();
  return `EXISTS (SELECT 1 FROM ${OWNER_TABLES[kind]} WHERE id = ?${kind === "account" ? " AND deleted_at IS NULL" : ""})`;
}
export async function getAttachment(db: CrmDatabase, id: string): Promise<AttachmentObjectRow | null> {
  if (!isUuid(id)) return fail();
  return db.prepare("SELECT * FROM attachment_v2_objects WHERE id = ? AND deleted_at IS NULL").bind(id).first<AttachmentObjectRow>();
}
export async function requireUpload(db: CrmDatabase, id: string, identity: AttachmentV2Identity,
  now: AttachmentClockInput = () => new Date()) {
  const clock = attachmentClock(now);
  validateIdentity(identity);
  if (!isUuid(id)) return fail();
  const row = await db.prepare("SELECT * FROM attachment_v2_uploads WHERE id = ? AND creator = ? AND session_id = ?")
    .bind(id, identity.creator, identity.sessionId).first<AttachmentV2Upload>();
  if (!row) return fail(404, "attachment_upload_not_found");
  if (row.state !== "committed" && row.expires_at <= clock().toISOString()) return fail(410, "attachment_upload_expired");
  if (row.state === "cancelled") return fail(410, "attachment_upload_cancelled");
  return row;
}
export async function uploadChunks(db: CrmDatabase, uploadId: string): Promise<AttachmentV2Chunk[]> {
  const result = await db.prepare("SELECT * FROM attachment_v2_chunks WHERE upload_id = ? ORDER BY part_index").bind(uploadId).all<AttachmentV2Chunk>();
  if (!result.success) return fail(503, "attachment_storage_unavailable");
  return result.results;
}
export async function statusForUpload(db: CrmDatabase, row: AttachmentV2Upload): Promise<AttachmentV2UploadStatus> {
  const manifest = validateAttachmentManifest(JSON.parse(row.manifest_json));
  return { id: row.id, state: row.state, byteSize: row.byte_size, chunkBytes: ATTACHMENT_CHUNK_BYTES,
    chunkCount: manifest.chunks.length, receivedChunks: (await uploadChunks(db, row.id)).map(chunk => chunk.part_index),
    attachmentId: row.attachment_id, expiresAt: row.expires_at };
}
export async function uploadStatus(db: CrmDatabase, id: string, identity: AttachmentV2Identity,
  now: AttachmentClockInput = () => new Date()) {
  return statusForUpload(db, await requireUpload(db, id, identity, now));
}
export async function createUpload(db: CrmDatabase, value: unknown, identity: AttachmentV2Identity,
  idempotencyKey: string, now: AttachmentClockInput = () => new Date()): Promise<AttachmentV2UploadStatus> {
  const clock = attachmentClock(now);
  validateIdentity(identity);
  if (typeof idempotencyKey !== "string" || !/^[A-Za-z0-9._:-]{8,128}$/u.test(idempotencyKey)) return fail();
  const manifest = validateAttachmentManifest(value);
  const encoded = JSON.stringify(manifest), digest = await sha256Hex(encoded);
  await requireAttachmentOwner(db, manifest.ownerKind, manifest.ownerId);
  const lookup = () => db.prepare("SELECT * FROM attachment_v2_uploads WHERE creator = ? AND session_id = ? AND idempotency_key = ?")
    .bind(identity.creator, identity.sessionId, idempotencyKey).first<AttachmentV2Upload>();
  const previous = await lookup();
  if (previous) {
    if (previous.manifest_sha256 !== digest) return fail(409, "attachment_idempotency_conflict");
    return uploadStatus(db, previous.id, identity, clock);
  }
  const current = clock(), timestamp = current.toISOString(), since = new Date(current.getTime() - 86400000).toISOString();
  // Quota selection and insertion execute as one SQLite statement: concurrent
  // creators cannot race a separate COUNT check. Expired sessions retain daily accounting.
  const result = await db.prepare(`INSERT INTO attachment_v2_uploads
    (id,creator,session_id,idempotency_key,manifest_json,manifest_sha256,byte_size,created_at,expires_at)
    SELECT ?,?,?,?,?,?,?,?,?
    WHERE (SELECT COUNT(*) FROM attachment_v2_uploads WHERE creator = ? AND state IN ('uploading','finalizing') AND expires_at > ?) < ?
      AND (SELECT COUNT(*) FROM attachment_v2_uploads WHERE creator = ? AND created_at >= ?) < ?
      AND COALESCE((SELECT SUM(byte_size) FROM attachment_v2_uploads WHERE creator = ? AND created_at >= ?),0) + ? <= ?
    ON CONFLICT(creator,session_id,idempotency_key) DO NOTHING`)
    .bind(crypto.randomUUID(), identity.creator, identity.sessionId, idempotencyKey, encoded, digest, manifest.byteSize,
      timestamp, new Date(current.getTime() + UPLOAD_TTL_MS).toISOString(), identity.creator, timestamp, MAX_ACTIVE_UPLOADS,
      identity.creator, since, MAX_DAILY_UPLOADS, identity.creator, since, manifest.byteSize, MAX_DAILY_BYTES).run();
  if (!result.success) return fail(503, "attachment_storage_unavailable");
  const row = await lookup();
  if (!row) return fail(429, "attachment_upload_quota_exceeded");
  if (row.manifest_sha256 !== digest) return fail(409, "attachment_idempotency_conflict");
  return statusForUpload(db, row);
}
export async function listAttachments(db: CrmDatabase, ownerKind: AttachmentObjectRow["owner_kind"], ownerId: string) {
  await requireAttachmentOwner(db, ownerKind, ownerId);
  const result = await db.prepare("SELECT * FROM attachment_v2_objects WHERE owner_kind = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC,id DESC LIMIT 200")
    .bind(ownerKind, ownerId).all<AttachmentObjectRow>();
  if (!result.success) return fail(503, "attachment_storage_unavailable");
  return result.results.map(row => ({ id: row.id, ownerKind: row.owner_kind, ownerId: row.owner_id,
    fileName: row.file_name, contentType: row.content_type, byteSize: row.byte_size, sha256: row.sha256,
    objectVersion: row.object_version, createdAt: row.created_at }));
}
/** Logical deletion preserves authoritative bytes for backups/recovery. */
export async function deleteAttachment(db: CrmDatabase, id: string, now = new Date()): Promise<void> {
  if (!isUuid(id)) return fail();
  const result = await db.prepare("UPDATE attachment_v2_objects SET deleted_at = COALESCE(deleted_at,?) WHERE id = ?")
    .bind(now.toISOString(), id).run();
  if (!result.success) return fail(503, "attachment_storage_unavailable");
}
