import type { CrmDatabase } from "./d1";
import type { PrivateObjectBucket, PrivateObjectMetadata } from "./runtime";

export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MOBILE_ATTACHMENT_SCAN_POLICY = "sha256-bound-r2-v1";
const MAX_MULTIPART_BYTES = MAX_ATTACHMENT_BYTES + 1024 * 1024;
const TYPES = new Set([
  "image/jpeg", "image/png", "image/heic", "application/pdf", "text/plain",
  "text/csv", "application/msword", "application/vnd.ms-excel",
  "application/zip", "application/octet-stream",
]);
const TABLES = { account: "organizations", deal: "deals", conversation: "conversations" } as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EXECUTABLE_NAME = /\.(?:exe|dll|com|scr|msi|bat|cmd|ps1|sh|js|mjs|cjs|vbs|jar|class|dmg|app|apk)$/iu;

export type AttachmentOwner = keyof typeof TABLES;
export type MobileAttachmentRow = {
  id: string; owner_kind: AttachmentOwner; owner_id: string; file_name: string;
  content_type: string; byte_size: number; sha256: string; storage_key: string;
  created_at: string; created_by: string; deleted_at: string | null;
};
export class AttachmentError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
function hasControlCharacter(value: string): boolean {
  return Array.from(value).some(character => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}
export function validAttachmentOwner(kind: string, id: string): kind is AttachmentOwner {
  return Object.hasOwn(TABLES, kind) && id.trim().length > 0 && id.length <= 256
    && !hasControlCharacter(id);
}
export function attachmentsConfigured(
  enabled: string | null, runtime: string | null, vercel: string | null,
  scanPolicy: string | null = null,
) {
  // Configuration is an operator attestation, not proof of transport/scanner health.
  // The Vercel BFF independently masks capabilities and rejects attachment traffic.
  return enabled === "1" && runtime === "cloudflare-r2" && !vercel
    && scanPolicy === MOBILE_ATTACHMENT_SCAN_POLICY;
}

/** Read-only structural probe, never an application of migrations. */
export async function mobileAttachmentSchemaReady(db: CrmDatabase): Promise<boolean> {
  try {
    for (const sql of [
      "SELECT nonce, expires_at, created_at FROM internal_api_nonces WHERE 0",
      "SELECT address, city FROM organizations WHERE 0",
      "SELECT phone FROM contacts WHERE 0",
      `SELECT id, owner_kind, owner_id, file_name, content_type, byte_size,
        sha256, storage_key, created_at, created_by, deleted_at FROM mobile_attachments WHERE 0`,
    ]) {
      if (!(await db.prepare(sql).all()).success) return false;
    }
    // A table alone does not guarantee race-safe deduplication. Pin the generated
    // partial unique index, including its predicate, without reading customer rows.
    const index = await db.prepare(`SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'mobile_attachments_active_dedup_unique'
        AND tbl_name = 'mobile_attachments'`).first<{ sql: string }>();
    const normalized = index?.sql?.replace(/\s+/gu, "").replaceAll('"', "")
      .replaceAll("`", "").replaceAll("[", "").replaceAll("]", "").replaceAll(";", "").toLowerCase();
    return normalized === "createuniqueindexmobile_attachments_active_dedup_uniqueonmobile_attachments(owner_kind,owner_id,sha256)wheremobile_attachments.deleted_atisnull"
      || normalized === "createuniqueindexmobile_attachments_active_dedup_uniqueonmobile_attachments(owner_kind,owner_id,sha256)wheredeleted_atisnull";
  } catch { return false; }
}

// Bound the full multipart envelope before formData materializes files/fields.
export async function readAttachmentForm(request: Request): Promise<FormData> {
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/u.test(length)) throw new AttachmentError(400, "validation_failed");
  if (length !== null && Number(length) > MAX_MULTIPART_BYTES) throw new AttachmentError(413, "file_too_large");
  if (request.headers.has("content-encoding")
    || !/^multipart\/form-data\s*;/iu.test(request.headers.get("content-type") ?? "")) {
    throw new AttachmentError(400, "validation_failed");
  }
  let received = 0;
  let tooLarge = false;
  const bounded = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > MAX_MULTIPART_BYTES) {
        tooLarge = true;
        throw new AttachmentError(413, "file_too_large");
      }
      controller.enqueue(chunk);
    },
  }));
  try {
    const form = await new Response(bounded ?? null, { headers: {
      "content-type": request.headers.get("content-type") ?? "",
    } }).formData();
    if (length !== null && received !== Number(length)) throw new Error("length_mismatch");
    return form;
  } catch {
    throw new AttachmentError(tooLarge ? 413 : 400, tooLarge ? "file_too_large" : "validation_failed");
  }
}
export function attachmentFormParts(form: FormData) {
  const kind = form.get("ownerKind"), ownerId = form.get("ownerId"), file = form.get("file");
  if ([...form.keys()].some(key => !["ownerKind", "ownerId", "file"].includes(key))
    || typeof kind !== "string" || typeof ownerId !== "string" || !validAttachmentOwner(kind, ownerId)
    || !(file instanceof File) || form.getAll("file").length !== 1
    || form.getAll("ownerKind").length !== 1 || form.getAll("ownerId").length !== 1) {
    throw new AttachmentError(400, "validation_failed");
  }
  return { kind, ownerId, file };
}
export async function requireAttachmentOwner(db: CrmDatabase, kind: AttachmentOwner, id: string) {
  if (!validAttachmentOwner(kind, id)) throw new AttachmentError(400, "validation_failed");
  const active = kind === "account" ? " AND deleted_at IS NULL" : "";
  const row = await db.prepare(`SELECT id FROM ${TABLES[kind]} WHERE id = ?${active}`).bind(id).first();
  if (!row) throw new AttachmentError(404, "owner_not_found");
}
function hex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), byte => byte.toString(16).padStart(2, "0")).join("");
}
function assertStorageKey(row: MobileAttachmentRow) {
  if (!UUID.test(row.id) || !new RegExp(`^mobile/[0-9]{4}/(?:0[1-9]|1[0-2])/${row.id}$`, "u").test(row.storage_key)) {
    throw new AttachmentError(503, "attachment_storage_unavailable");
  }
}
function objectMatches(row: MobileAttachmentRow, object: PrivateObjectMetadata): boolean {
  return SHA256.test(row.sha256) && object.key === row.storage_key
    && Number.isInteger(row.byte_size) && row.byte_size > 0 && row.byte_size <= MAX_ATTACHMENT_BYTES
    && object.size === row.byte_size && object.checksums?.sha256 instanceof ArrayBuffer
    && hex(object.checksums.sha256) === row.sha256;
}
async function confirmStoredAttachment(bucket: PrivateObjectBucket, row: MobileAttachmentRow) {
  assertStorageKey(row);
  const object = await bucket.head(row.storage_key);
  if (!object || !objectMatches(row, object)) throw new AttachmentError(503, "attachment_storage_unavailable");
  return row.id;
}
function validateFileContent(file: File, bytes: ArrayBuffer, contentType: string) {
  const data = new Uint8Array(bytes);
  const starts = (...magic: number[]) => magic.every((value, index) => data[index] === value);
  const name = file.name.normalize("NFKC").replace(/[.\s]+$/u, "");
  // This is only an executable/signature prefilter. It never marks a file clean.
  if (EXECUTABLE_NAME.test(name) || starts(0x4d, 0x5a) || starts(0x7f, 0x45, 0x4c, 0x46)
    || [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe],
      [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca],
      [0xca, 0xfe, 0xba, 0xbf], [0xbf, 0xba, 0xfe, 0xca]].some(magic => starts(...magic))) {
    throw new AttachmentError(415, "unsupported_media_type");
  }
  const ascii = (offset: number, count: number) => String.fromCharCode(...data.slice(offset, offset + count));
  if ((contentType === "image/jpeg" && !starts(0xff, 0xd8, 0xff))
    || (contentType === "image/png" && !starts(137, 80, 78, 71, 13, 10, 26, 10))
    || (contentType === "image/heic" && (ascii(4, 4) !== "ftyp"
      || !["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(ascii(8, 4))))
    || (contentType === "application/pdf" && ascii(0, 5) !== "%PDF-")
    || (contentType === "application/zip" && !(starts(80, 75, 3, 4) || starts(80, 75, 5, 6) || starts(80, 75, 7, 8)))
    || (["application/msword", "application/vnd.ms-excel"].includes(contentType)
      && !starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))) {
    throw new AttachmentError(415, "unsupported_media_type");
  }
  if (contentType === "text/plain" || contentType === "text/csv") {
    try {
      if (data.includes(0)) throw new Error("binary_text");
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch { throw new AttachmentError(415, "unsupported_media_type"); }
  }
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
  if (bytes.byteLength !== file.size) throw new AttachmentError(400, "validation_failed");
  validateFileContent(file, bytes, contentType);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha = hex(digest);
  const existing = () => db.prepare(`SELECT * FROM mobile_attachments
    WHERE owner_kind = ? AND owner_id = ? AND sha256 = ? AND deleted_at IS NULL`)
    .bind(kind, ownerId, sha).first<MobileAttachmentRow>();
  const previous = await existing();
  if (previous) return confirmStoredAttachment(bucket, previous);
  const id = crypto.randomUUID();
  const now = new Date();
  const key = `mobile/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}`;
  // R2 validates SHA-256 before the object becomes visible. Quarantine is default.
  // Clients cannot supply metadata or a scanner verdict through this API.
  await bucket.put(key, bytes, {
    httpMetadata: { contentType }, sha256: digest,
    customMetadata: { scanStatus: "unscanned", scanPolicy: MOBILE_ATTACHMENT_SCAN_POLICY },
  });
  const result = await db.prepare(`INSERT INTO mobile_attachments
    (id, owner_kind, owner_id, file_name, content_type, byte_size, sha256, storage_key, created_at, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(owner_kind, owner_id, sha256) WHERE deleted_at IS NULL DO NOTHING`)
    .bind(id, kind, ownerId, Array.from(file.name || "Document").filter(character => !hasControlCharacter(character)).join("").slice(0, 255), contentType,
      bytes.byteLength, sha, key, now.toISOString(), createdBy).run();
  if (!result.success) throw new Error("attachment_confirmation_failed");
  const winner = await existing();
  if (!winner) throw new Error("attachment_confirmation_failed");
  if (winner.id !== id) {
    // This key belongs only to the loser. A cleanup failure must not turn a
    // confirmed winner into a failed upload; leave that orphan for reconciliation.
    await bucket.delete(key).catch(() => undefined);
  }
  // Unknown DB failure leaves an orphan, not a possibly committed row without bytes.
  return confirmStoredAttachment(bucket, winner);
}
export async function deleteMobileAttachment(db: CrmDatabase, bucket: PrivateObjectBucket, id: string) {
  const row = await db.prepare("SELECT * FROM mobile_attachments WHERE id = ?").bind(id).first<MobileAttachmentRow>();
  if (!row) return;
  assertStorageKey(row);
  // Verified CRM-wide work scope may also clean up attachments of deleted owners.
  const result = await db.prepare("UPDATE mobile_attachments SET deleted_at = COALESCE(deleted_at, ?) WHERE id = ?")
    .bind(new Date().toISOString(), id).run();
  if (!result.success) throw new Error("attachment_delete_unconfirmed");
  // Retry also removes bytes for a tombstone if the previous object deletion failed.
  await bucket.delete(row.storage_key);
}
export async function listMobileAttachments(db: CrmDatabase, kind: AttachmentOwner, id: string) {
  await requireAttachmentOwner(db, kind, id);
  const rows = await db.prepare(`SELECT * FROM mobile_attachments
    WHERE owner_kind = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, id DESC`)
    .bind(kind, id).all<MobileAttachmentRow>();
  if (!rows.success) throw new Error("attachment_list_unavailable");
  if (rows.results.some(row => !SHA256.test(row.sha256))) {
    throw new Error("attachment_list_unavailable");
  }
  return rows.results.map(r => ({ id: r.id, ownerKind: r.owner_kind, ownerId: r.owner_id,
    fileName: r.file_name, byteSize: r.byte_size, sha256: r.sha256, createdAt: r.created_at }));
}
export async function downloadMobileAttachment(db: CrmDatabase, bucket: PrivateObjectBucket, id: string) {
  const row = await db.prepare("SELECT * FROM mobile_attachments WHERE id = ? AND deleted_at IS NULL")
    .bind(id).first<MobileAttachmentRow>();
  if (!row) throw new AttachmentError(404, "not_found");
  assertStorageKey(row);
  await requireAttachmentOwner(db, row.owner_kind, row.owner_id);
  const object = await bucket.get(row.storage_key);
  if (!object || !("body" in object)) throw new AttachmentError(503, "attachment_storage_unavailable");
  // Metadata and bytes are from this single GET, not a race-prone HEAD then GET.
  try {
    if (!objectMatches(row, object) || !TYPES.has(row.content_type)) {
      throw new AttachmentError(503, "attachment_storage_unavailable");
    }
    if (object.customMetadata?.scanStatus !== "clean"
      || object.customMetadata.scanPolicy !== MOBILE_ATTACHMENT_SCAN_POLICY
      || object.customMetadata.scanSha256 !== row.sha256) {
      throw new AttachmentError(423, "attachment_quarantined");
    }
    return new Response(object.body, { headers: {
      "content-type": row.content_type, "content-length": String(row.byte_size),
      "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`,
      "cache-control": "private, no-store", "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    } });
  } catch (error) {
    await object.body.cancel().catch(() => undefined);
    throw error;
  }
}
