import type { CrmDatabase } from "./d1";
import type { PrivateObjectBucket, PrivateObjectMetadata } from "./runtime";
import type { AttachmentObjectRow } from "./attachment-v2-protocol";
import {
  ATTACHMENT_CHUNK_BYTES, ATTACHMENT_SCAN_POLICY, MAX_ATTACHMENT_BYTES,
  AttachmentV2Error, attachmentClock, hex, isSha256, isUuid, readBoundedBytes, sha256Hex, type AttachmentClockInput,
} from "./attachment-v2-protocol";
import {
  attachmentOwnerCondition, requireAttachmentOwner, requireUpload, statusForUpload, uploadChunks, validateAttachmentManifest,
  type AttachmentV2Chunk, type AttachmentV2Identity, type AttachmentV2Manifest,
  type AttachmentV2Upload,
} from "./attachment-v2-store";

const fail = (status: number, code: string): never => { throw new AttachmentV2Error(status, code); };
function objectMatches(object: PrivateObjectMetadata | null | void, key: string, size: number, sha: string,
  version?: string): object is PrivateObjectMetadata {
  return !!object && object.key === key && object.size === size && isSha256(sha)
    && object.checksums?.sha256 instanceof ArrayBuffer && hex(object.checksums.sha256) === sha
    && typeof object.version === "string" && object.version.length > 0 && object.version.length <= 256
    && (version === undefined || object.version === version) && typeof object.etag === "string" && object.etag.length > 0;
}
function validateFirstBytes(bytes: Uint8Array, manifest: AttachmentV2Manifest) {
  const starts = (...magic: number[]) => magic.every((value, i) => bytes[i] === value);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  if (starts(0x4d, 0x5a) || starts(0x7f, 0x45, 0x4c, 0x46)
    || [[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf], [0xce, 0xfa, 0xed, 0xfe],
      [0xcf, 0xfa, 0xed, 0xfe], [0xca, 0xfe, 0xba, 0xbe], [0xbe, 0xba, 0xfe, 0xca],
      [0xca, 0xfe, 0xba, 0xbf], [0xbf, 0xba, 0xfe, 0xca]].some(magic => starts(...magic))) {
    fail(415, "attachment_media_type_rejected");
  }
  const type = manifest.contentType;
  if ((type === "image/jpeg" && !starts(255, 216, 255))
    || (type === "image/png" && !starts(137, 80, 78, 71, 13, 10, 26, 10))
    || (type === "image/heic" && (ascii(4, 4) !== "ftyp"
      || !["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(ascii(8, 4))))
    || (type === "application/pdf" && ascii(0, 5) !== "%PDF-")
    || (type === "application/zip" && !(starts(80, 75, 3, 4) || starts(80, 75, 5, 6) || starts(80, 75, 7, 8)))
    || (["application/msword", "application/vnd.ms-excel"].includes(type)
      && !starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1))) fail(415, "attachment_media_type_rejected");
}

export async function putUploadChunk(db: CrmDatabase, bucket: PrivateObjectBucket, id: string, index: number,
  body: ReadableStream<Uint8Array> | null, identity: AttachmentV2Identity,
  now: AttachmentClockInput = () => new Date(), authorize?: () => Promise<void>) {
  const clock = attachmentClock(now);
  await authorize?.();
  const row = await requireUpload(db, id, identity, clock);
  if (row.state !== "uploading") return fail(409, "attachment_upload_not_writable");
  const manifest = validateAttachmentManifest(JSON.parse(row.manifest_json));
  const part = manifest.chunks[index];
  if (!Number.isSafeInteger(index) || index < 0 || !part) return fail(400, "attachment_chunk_invalid");
  const bytes = await readBoundedBytes(body, part.byteSize);
  if (bytes.byteLength !== part.byteSize || await sha256Hex(bytes) !== part.sha256) return fail(409, "attachment_chunk_integrity_failed");
  await authorize?.();
  if ((await requireUpload(db, id, identity, clock)).state !== "uploading") return fail(409, "attachment_upload_not_writable");
  await requireAttachmentOwner(db, manifest.ownerKind, manifest.ownerId);
  if (index === 0) validateFirstBytes(bytes, manifest);
  const key = `attachments-v2/staging/${row.id}/${index}`;
  const inserted = await bucket.put(key, bytes, { sha256: part.sha256,
    onlyIf: { etagDoesNotMatch: "*" }, httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
    customMetadata: { transport: "chunked-v2", state: "staging" } });
  const object = inserted || await bucket.head(key);
  if (!objectMatches(object, key, part.byteSize, part.sha256)) return fail(503, "attachment_chunk_storage_mismatch");
  await authorize?.();
  await requireAttachmentOwner(db, manifest.ownerKind, manifest.ownerId);
  await requireUpload(db, id, identity, clock);
  const timestamp = clock().toISOString();
  const result = await db.prepare(`INSERT INTO attachment_v2_chunks
    (upload_id,part_index,byte_size,sha256,storage_key,object_version,etag,created_at)
    SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM attachment_v2_uploads
      WHERE id = ? AND creator = ? AND session_id = ? AND state = 'uploading' AND expires_at > ?)
      AND ${attachmentOwnerCondition(manifest.ownerKind)}
    ON CONFLICT(upload_id,part_index) DO NOTHING`)
    .bind(id, index, part.byteSize, part.sha256, key, object.version, object.etag, timestamp,
      id, identity.creator, identity.sessionId, timestamp, manifest.ownerId).run();
  if (!result.success) return fail(503, "attachment_storage_unavailable");
  const stored = (await uploadChunks(db, id)).find(chunk => chunk.part_index === index);
  if (!stored || stored.sha256 !== part.sha256 || stored.byte_size !== part.byteSize
    || stored.storage_key !== key || stored.object_version !== object.version) return fail(409, "attachment_upload_changed");
  return statusForUpload(db, await requireUpload(db, id, identity, clock));
}

/** One bounded chunk is materialized at a time. R2 independently validates the
 * complete SHA-256 supplied to PUT; the manifest is never a scanner verdict. */
function assembledBody(bucket: PrivateObjectBucket, row: AttachmentV2Upload, manifest: AttachmentV2Manifest,
  chunks: AttachmentV2Chunk[]): ReadableStream<Uint8Array> {
  let index = 0, length = 0, cancelled = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  const text = ["text/plain", "text/csv"].includes(manifest.contentType) ? new TextDecoder("utf-8", { fatal: true }) : null;
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (cancelled) return;
      try {
        if (index === chunks.length) {
          text?.decode();
          if (length !== row.byte_size) throw new Error("assembly_size_mismatch");
          controller.close(); return;
        }
        const chunk = chunks[index];
        const key = `attachments-v2/staging/${row.id}/${index}`;
        const expected = manifest.chunks[index];
        const object = await bucket.get(key, { onlyIf: { etagMatches: chunk.etag } });
        if (!object || !("body" in object) || !object.body
          || !objectMatches(object, key, expected.byteSize, expected.sha256, chunk.object_version)) {
          if (object && "body" in object) await object.body.cancel().catch(() => undefined);
          throw new Error("assembly_object_changed");
        }
        // The actual bytes are checked again, independent of metadata. This
        // bounds each R2 read and prevents truncated/grown staging objects.
        activeReader = object.body.getReader();
        const parts: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const item = await activeReader.read();
          if (cancelled) throw new Error("assembly_cancelled");
          if (item.done) break;
          size += item.value.byteLength;
          if (size > expected.byteSize) throw new Error("assembly_chunk_too_large");
          parts.push(item.value);
        }
        activeReader.releaseLock(); activeReader = null;
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
        if (size !== expected.byteSize || await sha256Hex(bytes) !== expected.sha256) throw new Error("assembly_chunk_hash_mismatch");
        if (text) {
          if (bytes.includes(0)) throw new Error("assembly_binary_text");
          text.decode(bytes, { stream: true });
        }
        length += size; index++;
        controller.enqueue(bytes);
      } catch (error) {
        await activeReader?.cancel().catch(() => undefined);
        activeReader?.releaseLock(); activeReader = null;
        controller.error(error);
      }
    },
    async cancel() { cancelled = true; await activeReader?.cancel().catch(() => undefined); },
  }, { highWaterMark: 0 });
  // Cloudflare R2 requires a known-length generated stream. Native Workers use
  // FixedLengthStream; the standards-only fallback is for the test seam only.
  const Fixed = (globalThis as typeof globalThis & {
    FixedLengthStream?: new (length: number) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> };
  }).FixedLengthStream;
  if (!Fixed) return source;
  const fixed = new Fixed(row.byte_size);
  void source.pipeTo(fixed.writable).catch(() => undefined);
  return fixed.readable;
}

export async function finishUpload(db: CrmDatabase, bucket: PrivateObjectBucket, id: string,
  identity: AttachmentV2Identity, now: AttachmentClockInput = () => new Date(), authorize?: () => Promise<void>) {
  const clock = attachmentClock(now);
  await authorize?.();
  let row = await requireUpload(db, id, identity, clock);
  if (row.state === "committed") return statusForUpload(db, row);
  const manifest = validateAttachmentManifest(JSON.parse(row.manifest_json));
  await requireAttachmentOwner(db, manifest.ownerKind, manifest.ownerId);
  const chunks = await uploadChunks(db, id);
  if (chunks.length !== manifest.chunks.length || chunks.some((part, i) => part.part_index !== i
    || part.byte_size !== manifest.chunks[i].byteSize || part.sha256 !== manifest.chunks[i].sha256
    || part.storage_key !== `attachments-v2/staging/${id}/${i}`)) return fail(409, "attachment_chunks_incomplete");
  const lease = crypto.randomUUID(), current = clock(), timestamp = current.toISOString();
  const claimed = await db.prepare(`UPDATE attachment_v2_uploads SET state = 'finalizing',lease_owner = ?,lease_expires_at = ?
    WHERE id = ? AND creator = ? AND session_id = ? AND expires_at > ?
      AND (state = 'uploading' OR (state = 'finalizing' AND lease_expires_at <= ?))`)
    .bind(lease, new Date(current.getTime() + 120000).toISOString(), id, identity.creator, identity.sessionId, timestamp, timestamp).run();
  if (!claimed.success) return fail(503, "attachment_storage_unavailable");
  if (claimed.meta.changes !== 1) return statusForUpload(db, await requireUpload(db, id, identity, clock));
  const key = `attachments-v2/objects/${id}`;
  try {
    let object = await bucket.head(key);
    if (!object) {
      const body = assembledBody(bucket, row, manifest, chunks);
      try {
        object = await bucket.put(key, body, {
          sha256: manifest.sha256, onlyIf: { etagDoesNotMatch: "*" },
          httpMetadata: { contentType: manifest.contentType, cacheControl: "private, no-store" },
          customMetadata: { scanStatus: "unscanned", scanPolicy: ATTACHMENT_SCAN_POLICY },
        }) || await bucket.head(key);
      } finally {
        // A conditional PUT can refuse before reading its source. Cancel that
        // unused stream so its FixedLengthStream producer cannot remain blocked.
        await body.cancel().catch(() => undefined);
      }
    }
    if (!objectMatches(object, key, manifest.byteSize, manifest.sha256)) return fail(503, "attachment_object_integrity_failed");
    await authorize?.();
    await requireAttachmentOwner(db, manifest.ownerKind, manifest.ownerId);
    let live = await requireUpload(db, id, identity, clock);
    if (live.state !== "finalizing" || live.lease_owner !== lease || !live.lease_expires_at
      || live.lease_expires_at <= clock().toISOString()) return fail(409, "attachment_finalization_expired");
    const previous = await db.prepare("SELECT * FROM attachment_v2_objects WHERE owner_kind = ? AND owner_id = ? AND sha256 = ? AND deleted_at IS NULL")
      .bind(manifest.ownerKind, manifest.ownerId, manifest.sha256).first<AttachmentObjectRow>();
    if (previous && !objectMatches(await bucket.head(previous.storage_key), previous.storage_key, previous.byte_size, previous.sha256, previous.object_version)) {
      return fail(503, "attachment_object_integrity_failed");
    }
    await authorize?.();
    await requireAttachmentOwner(db, manifest.ownerKind, manifest.ownerId);
    live = await requireUpload(db, id, identity, clock);
    const commitTime = clock().toISOString(), winnerId = previous?.id ?? id;
    if (live.state !== "finalizing" || live.lease_owner !== lease || !live.lease_expires_at
      || live.lease_expires_at <= commitTime) return fail(409, "attachment_finalization_expired");
    const inserted = db.prepare(`INSERT INTO attachment_v2_objects
      (id,owner_kind,owner_id,file_name,content_type,byte_size,sha256,storage_key,object_version,created_by,created_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM attachment_v2_uploads
        WHERE id = ? AND state = 'finalizing' AND lease_owner = ? AND expires_at > ? AND lease_expires_at > ?)
        AND ${attachmentOwnerCondition(manifest.ownerKind)}
      ON CONFLICT(owner_kind,owner_id,sha256) WHERE deleted_at IS NULL DO NOTHING`)
      .bind(id, manifest.ownerKind, manifest.ownerId, manifest.fileName, manifest.contentType, manifest.byteSize,
        manifest.sha256, key, object.version, identity.creator, commitTime, id, lease, commitTime, commitTime, manifest.ownerId);
    const committed = db.prepare(`UPDATE attachment_v2_uploads SET state = 'committed',attachment_id = ?,lease_owner = NULL,lease_expires_at = NULL
      WHERE id = ? AND state = 'finalizing' AND lease_owner = ? AND expires_at > ? AND lease_expires_at > ?
        AND ${attachmentOwnerCondition(manifest.ownerKind)}
        AND EXISTS (SELECT 1 FROM attachment_v2_objects WHERE id = ? AND owner_kind = ? AND owner_id = ? AND sha256 = ?
          AND storage_key = ? AND object_version = ? AND deleted_at IS NULL)`)
      .bind(winnerId, id, lease, commitTime, commitTime, manifest.ownerId, winnerId,
        manifest.ownerKind, manifest.ownerId, manifest.sha256, previous?.storage_key ?? key, previous?.object_version ?? object.version);
    // D1 batch is transactional: metadata publication and durable upload ack
    // share the same lease/expiry/owner predicate without an intervening R2 wait.
    const results = await db.batch([inserted, committed]);
    if (results.some(result => !result.success)) return fail(503, "attachment_storage_unavailable");
    if (results[1]?.meta.changes !== 1) return fail(409, "attachment_upload_changed");
    row = await requireUpload(db, id, identity, clock);
    return statusForUpload(db, row);
  } catch (error) {
    // Do not delete possibly committed bytes after an uncertain DB/transport
    // result. A retry reconciles the deterministic immutable object key.
    await db.prepare(`UPDATE attachment_v2_uploads SET state = 'uploading',lease_owner = NULL,lease_expires_at = NULL
      WHERE id = ? AND state = 'finalizing' AND lease_owner = ?`).bind(id, lease).run().catch(() => undefined);
    throw error;
  }
}

export function attachmentDownloadManifest(row: AttachmentObjectRow) {
  if (!isUuid(row.id) || row.storage_key !== `attachments-v2/objects/${row.id}` || !isSha256(row.sha256)
    || row.deleted_at !== null || !Number.isSafeInteger(row.byte_size) || row.byte_size < 1 || row.byte_size > MAX_ATTACHMENT_BYTES
    || !row.object_version || row.object_version.length > 256) return fail(423, "attachment_integrity_unverified");
  return { id: row.id, byteSize: row.byte_size, sha256: row.sha256, objectVersion: row.object_version,
    chunkBytes: ATTACHMENT_CHUNK_BYTES, chunkCount: Math.ceil(row.byte_size / ATTACHMENT_CHUNK_BYTES), contentType: row.content_type };
}
/** Caller first obtains this row through the trusted clean-receipt validator.
 * Conditional GET and returned version pin every range to that same object. */
export async function readAttachmentChunk(bucket: PrivateObjectBucket, row: AttachmentObjectRow, index: number,
  expectedVersion: string, authorizeAfterRead?: () => Promise<void>) {
  const manifest = attachmentDownloadManifest(row);
  if (expectedVersion !== row.object_version) return fail(409, "attachment_object_changed");
  if (!Number.isSafeInteger(index) || index < 0 || index >= manifest.chunkCount) return fail(400, "attachment_chunk_invalid");
  const offset = index * ATTACHMENT_CHUNK_BYTES, length = Math.min(ATTACHMENT_CHUNK_BYTES, row.byte_size - offset);
  const head = await bucket.head(row.storage_key);
  if (!objectMatches(head, row.storage_key, row.byte_size, row.sha256, row.object_version)) return fail(409, "attachment_object_changed");
  const object = await bucket.get(row.storage_key, { onlyIf: { etagMatches: head.etag }, range: { offset, length } });
  if (!object || !("body" in object) || !object.body
    || !objectMatches(object, row.storage_key, row.byte_size, row.sha256, row.object_version)) {
    if (object && "body" in object) await object.body.cancel().catch(() => undefined);
    return fail(409, "attachment_object_changed");
  }
  // Buffer only this small range before release, so a malformed/truncated range
  // cannot be returned as a successful chunk or exceed the Vercel body budget.
  const bytes = await readBoundedBytes(object.body, length);
  if (bytes.byteLength !== length) return fail(503, "attachment_chunk_integrity_failed");
  await authorizeAfterRead?.();
  return { body: bytes, byteSize: length, objectVersion: row.object_version, contentType: "application/octet-stream" };
}
