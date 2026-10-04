import type { CrmDatabase } from "./d1";
import type { PrivateObjectBucket } from "./runtime";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const TYPES = new Set([
  "image/jpeg", "image/png", "image/heic", "application/pdf", "text/plain",
  "text/csv", "application/msword", "application/vnd.ms-excel",
  "application/zip", "application/octet-stream",
]);
const TABLES = { account: "organizations", deal: "deals", conversation: "conversations" } as const;
export type AttachmentOwner = keyof typeof TABLES;
export type MobileAttachmentRow = {
  id: string; owner_kind: AttachmentOwner; owner_id: string; file_name: string;
  content_type: string; byte_size: number; sha256: string; storage_key: string;
  created_at: string; created_by: string; deleted_at: string | null;
};
export class AttachmentError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export function validAttachmentOwner(kind: string, id: string): kind is AttachmentOwner {
  return Object.hasOwn(TABLES, kind) && id.trim().length > 0 && id.length <= 256;
}
export function attachmentsConfigured(enabled: string | null, runtime: string | null, vercel: string | null) {
  // An environment flag alone must never advertise 20 MB uploads on Vercel.
  return enabled === "1" && runtime === "cloudflare-r2" && !vercel;
}
// Bound the full multipart envelope before formData materializes files/fields.
export async function readAttachmentForm(request: Request): Promise<FormData> {
  const limit = MAX_ATTACHMENT_BYTES + 1024 * 1024;
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) throw new AttachmentError(413, "file_too_large");
  let received = 0;
  let tooLarge = false;
  const bounded = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > limit) {
        tooLarge = true;
        throw new AttachmentError(413, "file_too_large");
      }
      controller.enqueue(chunk);
    },
  }));
  try {
    return await new Response(bounded ?? null, { headers: {
      "content-type": request.headers.get("content-type") ?? "",
    } }).formData();
  } catch {
    throw new AttachmentError(tooLarge ? 413 : 400, tooLarge ? "file_too_large" : "validation_failed");
  }
}
export async function requireAttachmentOwner(db: CrmDatabase, kind: AttachmentOwner, id: string) {
  const active = kind === "account" ? " AND deleted_at IS NULL" : "";
  const row = await db.prepare(`SELECT id FROM ${TABLES[kind]} WHERE id = ?${active}`).bind(id).first();
  if (!row) throw new AttachmentError(404, "owner_not_found");
}
export async function uploadMobileAttachment(
  db: CrmDatabase, bucket: PrivateObjectBucket, kind: AttachmentOwner,
  ownerId: string, file: File, createdBy: string,
) {
  if (file.size === 0) throw new AttachmentError(400, "validation_failed");
  if (file.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(413, "file_too_large");
  const contentType = file.type || "application/octet-stream";
  if (!TYPES.has(contentType)) throw new AttachmentError(415, "unsupported_media_type");
  await requireAttachmentOwner(db, kind, ownerId);
  const bytes = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, "0")).join("");
  const existing = () => db.prepare(`SELECT id FROM mobile_attachments
    WHERE owner_kind = ? AND owner_id = ? AND sha256 = ? AND deleted_at IS NULL`)
    .bind(kind, ownerId, sha).first<{ id: string }>();
  const previous = await existing();
  if (previous) return previous.id;
  const id = crypto.randomUUID();
  const now = new Date();
  const key = `mobile/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
  // Object PUT completes before publishing metadata; never publish a partial file.
  await bucket.put(key, bytes, { httpMetadata: { contentType } });
  await db.prepare(`INSERT INTO mobile_attachments
    (id, owner_kind, owner_id, file_name, content_type, byte_size, sha256, storage_key, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_kind, owner_id, sha256) WHERE deleted_at IS NULL DO NOTHING`)
    .bind(id, kind, ownerId, (file.name || "Document").slice(0, 255), contentType,
      bytes.byteLength, sha, key, now.toISOString(), createdBy).run();
  const winner = await existing();
  if (!winner) throw new Error("attachment_confirmation_failed");
  if (winner.id !== id) await bucket.delete(key);
  // Unknown DB failure leaves an orphan, not a possibly committed row without bytes.
  return winner.id;
}
export async function deleteMobileAttachment(db: CrmDatabase, bucket: PrivateObjectBucket, id: string) {
  const row = await db.prepare("SELECT * FROM mobile_attachments WHERE id = ?").bind(id).first<MobileAttachmentRow>();
  if (!row) return;
  // Verified CRM-wide work scope may also clean up attachments of deleted owners.
  await db.prepare("UPDATE mobile_attachments SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?")
    .bind(new Date().toISOString(), id).run();
  // Retry also removes bytes for a tombstone if the previous object deletion failed.
  await bucket.delete(row.storage_key);
}
export async function listMobileAttachments(db: CrmDatabase, kind: AttachmentOwner, id: string) {
  await requireAttachmentOwner(db, kind, id);
  const rows = await db.prepare(`SELECT * FROM mobile_attachments
    WHERE owner_kind = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`)
    .bind(kind, id).all<MobileAttachmentRow>();
  return rows.results.map(r => ({ id: r.id, ownerKind: r.owner_kind, ownerId: r.owner_id,
    fileName: r.file_name, byteSize: r.byte_size, createdAt: r.created_at }));
}
export async function downloadMobileAttachment(db: CrmDatabase, bucket: PrivateObjectBucket, id: string) {
  const row = await db.prepare("SELECT * FROM mobile_attachments WHERE id = ? AND deleted_at IS NULL")
    .bind(id).first<MobileAttachmentRow>();
  if (!row) throw new AttachmentError(404, "not_found");
  await requireAttachmentOwner(db, row.owner_kind, row.owner_id);
  const object = await bucket.get(row.storage_key);
  if (!object) throw new AttachmentError(503, "attachment_storage_unavailable");
  return new Response(object.body, { headers: {
    "content-type": row.content_type, "content-length": String(row.byte_size),
    "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`,
    "cache-control": "private, no-store", "x-content-type-options": "nosniff",
  } });
}
