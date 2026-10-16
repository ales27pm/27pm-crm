import type { CrmDatabase } from "./d1";
import { ATTACHMENT_SCAN_POLICY, MAX_ATTACHMENT_BYTES, SCAN_SIGNATURE_MAX_AGE_MS,
  SCAN_VERDICT_TTL_MS, isSha256, isUuid, isoTime, sha256Hex } from "./attachment-v2-protocol";
import type { AttachmentObjectRow, ScanVerdict } from "./attachment-v2-protocol";

export const SCAN_LEASE_SECONDS = 120;
export const SCANNER_HEARTBEAT_SECONDS = 120;
export const SCAN_MAX_ATTEMPTS = 5;
const MAX_LEASE_SECONDS = 600;
export type ScanLease = { jobId: string; scannerId: string; leaseToken: string; generation: number };
export type ScannerHeartbeat = { engineVersion: string; signatureVersion: string; signatureUpdatedAt: string };
export type ScanJob = {
  id: string; attachmentId: string; storageKey: string; objectVersion: string; sha256: string;
  byteSize: number; policy: string; generation: number; state: "pending" | "leased" | "completed" | "blocked";
  attemptCount: number; availableAt: string; scannerId: string | null; leaseTokenHash: string | null;
  leaseStartedAt: string | null; leaseExpiresAt: string | null; receiptKey: string | null;
  resultDigest: string | null; resultStatus: "clean" | "infected" | null;
  scannedAt: string | null; signatureUpdatedAt: string | null; errorCode: string | null;
  createdAt: string; updatedAt: string;
};
const COLUMNS = `id,attachment_id AS attachmentId,storage_key AS storageKey,object_version AS objectVersion,
  sha256,byte_size AS byteSize,policy,generation,state,attempt_count AS attemptCount,available_at AS availableAt,
  scanner_id AS scannerId,lease_token_hash AS leaseTokenHash,lease_started_at AS leaseStartedAt,
  lease_expires_at AS leaseExpiresAt,receipt_key AS receiptKey,result_digest AS resultDigest,
  result_status AS resultStatus,scanned_at AS scannedAt,signature_updated_at AS signatureUpdatedAt,
  error_code AS errorCode,created_at AS createdAt,updated_at AS updatedAt`;
const OWNER = `((o.owner_kind='account' AND EXISTS(SELECT 1 FROM organizations p WHERE p.id=o.owner_id AND p.deleted_at IS NULL))
  OR (o.owner_kind='deal' AND EXISTS(SELECT 1 FROM deals p WHERE p.id=o.owner_id))
  OR (o.owner_kind='conversation' AND EXISTS(SELECT 1 FROM conversations p WHERE p.id=o.owner_id)))`;
const CURRENT = `EXISTS(SELECT 1 FROM attachment_v2_objects o WHERE o.id=attachment_scan_jobs.attachment_id
  AND o.deleted_at IS NULL AND o.storage_key=attachment_scan_jobs.storage_key
  AND o.object_version=attachment_scan_jobs.object_version AND o.sha256=attachment_scan_jobs.sha256
  AND o.byte_size=attachment_scan_jobs.byte_size AND ${OWNER})`;
const ENGINE = /^[0-9]+\.[0-9]+\.[0-9]+(?:[.-][A-Za-z0-9.-]+)?$/u;
const scannerIdValid = (id: string) => typeof id === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/u.test(id);
const timeValid = (now: Date) => Number.isFinite(now.valueOf());
export function validScanLease(lease: ScanLease): boolean {
  return !!lease && isUuid(lease.jobId) && scannerIdValid(lease.scannerId)
    && /^[A-Za-z0-9_-]{43}$/u.test(lease.leaseToken) && Number.isSafeInteger(lease.generation) && lease.generation > 0;
}
export function validAttachmentObject(row: AttachmentObjectRow | null): row is AttachmentObjectRow {
  return !!row && isUuid(row.id) && row.deleted_at === null && isSha256(row.sha256)
    && row.storage_key === `attachments-v2/objects/${row.id}`
    && typeof row.object_version === "string" && row.object_version.length > 0 && row.object_version.length <= 256
    && Number.isSafeInteger(row.byte_size) && row.byte_size > 0 && row.byte_size <= MAX_ATTACHMENT_BYTES;
}
export async function activeScanAttachment(db: CrmDatabase, id: string): Promise<AttachmentObjectRow | null> {
  if (!isUuid(id)) return null;
  const row = await db.prepare(`SELECT o.* FROM attachment_v2_objects o WHERE o.id=? AND o.deleted_at IS NULL AND ${OWNER}`)
    .bind(id).first<AttachmentObjectRow>();
  return validAttachmentObject(row) ? row : null;
}
export async function getScanJob(db: CrmDatabase, jobId: string): Promise<ScanJob | null> {
  if (!isUuid(jobId)) return null;
  return db.prepare(`SELECT ${COLUMNS} FROM attachment_scan_jobs WHERE id=?`).bind(jobId).first<ScanJob>();
}
export async function attachmentScanJob(db: CrmDatabase, attachmentId: string): Promise<ScanJob | null> {
  if (!isUuid(attachmentId)) return null;
  return db.prepare(`SELECT ${COLUMNS} FROM attachment_scan_jobs WHERE attachment_id=? AND ${CURRENT}`)
    .bind(attachmentId).first<ScanJob>();
}

/** A retry never creates a new attachment or silently re-opens an infected/policy-blocked result. */
export async function enqueueScanJob(db: CrmDatabase, attachmentId: string, now = new Date()): Promise<ScanJob | null> {
  if (!timeValid(now)) return null;
  const object = await activeScanAttachment(db, attachmentId);
  if (!object) return null;
  const at = now.toISOString();
  await db.prepare(`INSERT INTO attachment_scan_jobs
    (id,attachment_id,storage_key,object_version,sha256,byte_size,policy,available_at,created_at,updated_at)
    SELECT ?,o.id,o.storage_key,o.object_version,o.sha256,o.byte_size,?,?,?,? FROM attachment_v2_objects o
    WHERE o.id=? AND o.deleted_at IS NULL AND o.object_version=? AND o.sha256=? AND ${OWNER}
    ON CONFLICT(attachment_id) DO NOTHING`)
    .bind(crypto.randomUUID(), ATTACHMENT_SCAN_POLICY, at, at, at, object.id, object.object_version, object.sha256).run();
  // Changing the actual object version invalidates every old lease and receipt.
  // A clean receipt may be rescanned when stale; infected/blocked is never reopened merely by time.
  await db.prepare(`UPDATE attachment_scan_jobs SET storage_key=?,object_version=?,sha256=?,byte_size=?,
    generation=generation+1,state='pending',attempt_count=0,available_at=?,scanner_id=NULL,
    lease_token_hash=NULL,lease_started_at=NULL,lease_expires_at=NULL,receipt_key=NULL,result_digest=NULL,
    result_status=NULL,scanned_at=NULL,signature_updated_at=NULL,error_code=NULL,updated_at=?
    WHERE attachment_id=? AND EXISTS(SELECT 1 FROM attachment_v2_objects o WHERE o.id=? AND o.deleted_at IS NULL
      AND o.object_version=? AND o.sha256=? AND o.byte_size=? AND ${OWNER})
    AND (object_version!=? OR sha256!=? OR storage_key!=? OR byte_size!=?
      OR (state='completed' AND result_status='clean' AND (scanned_at<? OR signature_updated_at<?)))`)
    .bind(object.storage_key, object.object_version, object.sha256, object.byte_size, at, at,
      object.id, object.id, object.object_version, object.sha256, object.byte_size,
      object.object_version, object.sha256, object.storage_key, object.byte_size,
      new Date(now.valueOf() - SCAN_VERDICT_TTL_MS).toISOString(),
      new Date(now.valueOf() - SCAN_SIGNATURE_MAX_AGE_MS).toISOString()).run();
  return attachmentScanJob(db, attachmentId);
}

export async function recordScannerHeartbeat(
  db: CrmDatabase, scannerId: string, heartbeat: ScannerHeartbeat, now = new Date(),
): Promise<boolean> {
  if (!scannerIdValid(scannerId) || !timeValid(now) || !heartbeat || !ENGINE.test(heartbeat.engineVersion)
    || !/^[0-9]{1,12}$/u.test(heartbeat.signatureVersion)) return false;
  const updated = isoTime(heartbeat.signatureUpdatedAt);
  if (!Number.isFinite(updated) || updated > now.valueOf() + 30_000 || updated < now.valueOf() - SCAN_SIGNATURE_MAX_AGE_MS) return false;
  return (await db.prepare(`INSERT INTO attachment_scanner_heartbeats
    (scanner_id,engine_version,signature_version,signature_updated_at,heartbeat_at) VALUES (?,?,?,?,?)
    ON CONFLICT(scanner_id) DO UPDATE SET engine_version=excluded.engine_version,
      signature_version=excluded.signature_version,signature_updated_at=excluded.signature_updated_at,
      heartbeat_at=excluded.heartbeat_at WHERE excluded.heartbeat_at>=attachment_scanner_heartbeats.heartbeat_at`)
    .bind(scannerId, heartbeat.engineVersion, heartbeat.signatureVersion, heartbeat.signatureUpdatedAt, now.toISOString()).run()).success;
}
export async function scannerFresh(
  db: CrmDatabase, now = new Date(), scannerId?: string, verdict?: ScanVerdict,
): Promise<boolean> {
  if (!timeValid(now) || (scannerId !== undefined && !scannerIdValid(scannerId))) return false;
  const row = await db.prepare(`SELECT scanner_id FROM attachment_scanner_heartbeats WHERE heartbeat_at>? AND heartbeat_at<=?
    AND signature_updated_at>=? AND signature_updated_at<=?
    AND (? IS NULL OR scanner_id=?) AND (? IS NULL OR (engine_version=? AND signature_version=? AND signature_updated_at=?)) LIMIT 1`)
    .bind(new Date(now.valueOf() - SCANNER_HEARTBEAT_SECONDS * 1000).toISOString(), now.toISOString(),
      new Date(now.valueOf() - SCAN_SIGNATURE_MAX_AGE_MS).toISOString(), new Date(now.valueOf() + 30_000).toISOString(),
      scannerId ?? null, scannerId ?? null, verdict?.engineVersion ?? null, verdict?.engineVersion ?? null,
      verdict?.signatureVersion ?? null, verdict?.signatureUpdatedAt ?? null).first();
  return !!row;
}

export async function claimScanJob(db: CrmDatabase, scannerId: string, now = new Date()): Promise<{ job: ScanJob; lease: ScanLease } | null> {
  if (!scannerIdValid(scannerId) || !timeValid(now) || !(await scannerFresh(db, now, scannerId))) return null;
  const at = now.toISOString();
  await db.prepare(`UPDATE attachment_scan_jobs SET state='blocked',error_code='attempts_exhausted',
    generation=generation+1,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=?
    WHERE state='leased' AND lease_expires_at<=? AND attempt_count>=?`).bind(at, at, SCAN_MAX_ATTEMPTS).run();
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenHash = await sha256Hex(token);
  const job = await db.prepare(`UPDATE attachment_scan_jobs SET state='leased',generation=generation+1,
    attempt_count=attempt_count+1,scanner_id=?,lease_token_hash=?,lease_started_at=?,lease_expires_at=?,updated_at=?,error_code=NULL
    WHERE id=(SELECT id FROM attachment_scan_jobs WHERE ((state='pending' AND available_at<=?)
      OR (state='leased' AND lease_expires_at<=?)) AND attempt_count<? AND ${CURRENT}
      ORDER BY available_at,id LIMIT 1)
    AND EXISTS(SELECT 1 FROM attachment_scanner_heartbeats WHERE scanner_id=? AND heartbeat_at>? AND heartbeat_at<=?)
    RETURNING ${COLUMNS}`)
    .bind(scannerId, tokenHash, at, new Date(now.valueOf() + SCAN_LEASE_SECONDS * 1000).toISOString(), at,
      at, at, SCAN_MAX_ATTEMPTS, scannerId,
      new Date(now.valueOf() - SCANNER_HEARTBEAT_SECONDS * 1000).toISOString(), at).first<ScanJob>();
  return job ? { job, lease: { jobId: job.id, scannerId, leaseToken: token, generation: job.generation } } : null;
}
export async function authorizedScanJob(db: CrmDatabase, lease: ScanLease, now = new Date()): Promise<ScanJob | null> {
  if (!validScanLease(lease) || !timeValid(now) || !(await scannerFresh(db, now, lease.scannerId))) return null;
  return db.prepare(`SELECT ${COLUMNS} FROM attachment_scan_jobs WHERE id=? AND state='leased' AND generation=?
    AND scanner_id=? AND lease_token_hash=? AND lease_expires_at>? AND ${CURRENT}`)
    .bind(lease.jobId, lease.generation, lease.scannerId, await sha256Hex(lease.leaseToken), now.toISOString()).first<ScanJob>();
}
export async function renewScanJob(db: CrmDatabase, lease: ScanLease, now = new Date()): Promise<ScanJob | null> {
  if (!validScanLease(lease) || !timeValid(now) || !(await scannerFresh(db, now, lease.scannerId))) return null;
  const job = await authorizedScanJob(db, lease, now);
  if (!job || !job.leaseStartedAt) return null;
  const end = Math.min(now.valueOf() + SCAN_LEASE_SECONDS * 1000, Date.parse(job.leaseStartedAt) + MAX_LEASE_SECONDS * 1000);
  if (end <= now.valueOf()) return null;
  return db.prepare(`UPDATE attachment_scan_jobs SET lease_expires_at=?,updated_at=? WHERE id=? AND state='leased'
    AND generation=? AND scanner_id=? AND lease_token_hash=? AND lease_expires_at>? AND ${CURRENT} RETURNING ${COLUMNS}`)
    .bind(new Date(end).toISOString(), now.toISOString(), lease.jobId, lease.generation, lease.scannerId,
      await sha256Hex(lease.leaseToken), now.toISOString()).first<ScanJob>();
}
export async function failScanJob(db: CrmDatabase, lease: ScanLease, code: string, now = new Date()): Promise<boolean> {
  if (!validScanLease(lease) || !timeValid(now)) return false;
  const terminal = code === "archive_policy_blocked";
  if (!terminal && !["unavailable", "integrity_mismatch", "scan_timeout"].includes(code)) return false;
  const result = await db.prepare(`UPDATE attachment_scan_jobs SET state=CASE WHEN ?=1 OR attempt_count>=? THEN 'blocked' ELSE 'pending' END,
    available_at=?,error_code=?,lease_token_hash=NULL,lease_expires_at=NULL,updated_at=?
    WHERE id=? AND state='leased' AND generation=? AND scanner_id=? AND lease_token_hash=? AND lease_expires_at>? AND ${CURRENT}
    RETURNING id`)
    .bind(terminal ? 1 : 0, SCAN_MAX_ATTEMPTS, new Date(now.valueOf() + 30_000).toISOString(), code, now.toISOString(),
      lease.jobId, lease.generation, lease.scannerId, await sha256Hex(lease.leaseToken), now.toISOString()).first();
  return !!result;
}
export const recordScanFailure = failScanJob;

/** Only the service writes a validated immutable receipt before this pointer CAS. */
export async function commitScanResult(
  db: CrmDatabase, lease: ScanLease,
  result: { receiptKey: string; resultDigest: string; verdict: ScanVerdict }, now = new Date(),
): Promise<boolean> {
  if (!validScanLease(lease) || !timeValid(now) || !isSha256(result.resultDigest)
    || result.receiptKey !== `attachments-v2/scan-receipts/${lease.jobId}/${lease.generation}/${result.resultDigest}.json`
    || !(await scannerFresh(db, now, lease.scannerId, result.verdict))) return false;
  const row = await db.prepare(`UPDATE attachment_scan_jobs SET state='completed',receipt_key=?,result_digest=?,result_status=?,
    scanned_at=?,signature_updated_at=?,updated_at=? WHERE id=? AND state='leased' AND generation=?
    AND scanner_id=? AND lease_token_hash=? AND lease_expires_at>? AND ${CURRENT} RETURNING id`)
    .bind(result.receiptKey, result.resultDigest, result.verdict.status, result.verdict.scannedAt,
      result.verdict.signatureUpdatedAt, now.toISOString(), lease.jobId, lease.generation, lease.scannerId,
      await sha256Hex(lease.leaseToken), now.toISOString()).first();
  return !!row;
}
export async function completedLeaseJob(db: CrmDatabase, lease: ScanLease): Promise<ScanJob | null> {
  if (!validScanLease(lease)) return null;
  return db.prepare(`SELECT ${COLUMNS} FROM attachment_scan_jobs WHERE id=? AND state='completed' AND generation=?
    AND scanner_id=? AND lease_token_hash=? AND ${CURRENT}`)
    .bind(lease.jobId, lease.generation, lease.scannerId, await sha256Hex(lease.leaseToken)).first<ScanJob>();
}
