import type { CrmDatabase } from "./d1";
import type { PrivateObjectBucket, PrivateObjectMetadata } from "./runtime";
import { ATTACHMENT_SCAN_POLICY, SCAN_RECEIPT_MAX_BYTES, hex, projectScanVerdict,
  isoTime, readBoundedBytes, sha256Hex, validScanVerdict } from "./attachment-v2-protocol";
import type { AttachmentObjectRow, ScanVerdict } from "./attachment-v2-protocol";
import { activeScanAttachment, attachmentScanJob, authorizedScanJob, commitScanResult,
  completedLeaseJob, scannerFresh, validScanLease } from "./attachment-scan-store";
import type { ScanJob, ScanLease } from "./attachment-scan-store";

type ScanReceipt = {
  policy: typeof ATTACHMENT_SCAN_POLICY; jobId: string; generation: number;
  objectKey: string; objectVersion: string; verdict: ScanVerdict;
};
type ClockInput = Date | (() => Date);
function clockFor(input: ClockInput): () => Date {
  if (typeof input === "function") return input;
  // Injected dates are an anchor, not permission to freeze lease time across a
  // stalled R2 call. Monotonic elapsed time cannot be moved backwards by NTP.
  const started = performance.now(), anchor = input.valueOf();
  return () => new Date(anchor + Math.max(0, performance.now() - started));
}
function metadataMatches(row: AttachmentObjectRow, meta: PrivateObjectMetadata | null): boolean {
  return !!meta && meta.key === row.storage_key && meta.version === row.object_version
    && meta.size === row.byte_size && meta.checksums?.sha256 instanceof ArrayBuffer
    && hex(meta.checksums.sha256) === row.sha256;
}
function jobMatches(row: AttachmentObjectRow, job: ScanJob): boolean {
  return job.attachmentId === row.id && job.storageKey === row.storage_key
    && job.objectVersion === row.object_version && job.sha256 === row.sha256
    && job.byteSize === row.byte_size && job.policy === ATTACHMENT_SCAN_POLICY;
}
function receiptKey(job: ScanJob, digest: string): string {
  return `attachments-v2/scan-receipts/${job.id}/${job.generation}/${digest}.json`;
}
function encodedReceipt(job: ScanJob, verdict: ScanVerdict): Uint8Array {
  const receipt: ScanReceipt = { policy: ATTACHMENT_SCAN_POLICY, jobId: job.id,
    generation: job.generation, objectKey: job.storageKey, objectVersion: job.objectVersion,
    verdict: projectScanVerdict(verdict) };
  return new TextEncoder().encode(JSON.stringify(receipt));
}

/** A machine may read only the object covered by its current unexpired lease. */
export async function authorizedScanObject(
  db: CrmDatabase, bucket: PrivateObjectBucket, lease: ScanLease, now: ClockInput = () => new Date(),
): Promise<{ job: ScanJob; attachment: AttachmentObjectRow } | null> {
  const clock = clockFor(now);
  const job = await authorizedScanJob(db, lease, clock());
  if (!job) return null;
  const attachment = await activeScanAttachment(db, job.attachmentId);
  if (!attachment || !jobMatches(attachment, job)
    || !metadataMatches(attachment, await bucket.head(attachment.storage_key))) return null;
  const current = await authorizedScanJob(db, lease, clock());
  if (!current || current.objectVersion !== job.objectVersion || current.sha256 !== job.sha256) return null;
  return { job, attachment };
}

/** R2 checksums plus the D1 committed digest bind a receipt to its actual bytes. */
async function receiptBytes(bucket: PrivateObjectBucket, key: string, digest: string): Promise<Uint8Array | null> {
  const object = await bucket.get(key);
  if (!object || !("body" in object)) return null;
  if (object.key !== key || !Number.isSafeInteger(object.size) || object.size <= 0
    || object.size > SCAN_RECEIPT_MAX_BYTES || !(object.checksums?.sha256 instanceof ArrayBuffer)
    || hex(object.checksums.sha256) !== digest) {
    await object.body.cancel().catch(() => undefined);
    return null;
  }
  try {
    const bytes = await readBoundedBytes(object.body, SCAN_RECEIPT_MAX_BYTES);
    return bytes.byteLength === object.size && await sha256Hex(bytes) === digest ? bytes : null;
  } catch { return null; }
}

/**
 * Store immutable evidence first, then publish only with the current D1 lease CAS.
 * A stale worker may leave an orphan receipt; it can never replace a pointer.
 */
export async function completeScanJob(
  db: CrmDatabase, bucket: PrivateObjectBucket, lease: ScanLease, value: unknown, now: ClockInput = () => new Date(),
): Promise<"completed" | "duplicate" | "rejected"> {
  const clock = clockFor(now);
  if (!validScanLease(lease) || !Number.isFinite(clock().valueOf())) return "rejected";
  let authorized = await authorizedScanObject(db, bucket, lease, clock);
  const completed = authorized ? null : await completedLeaseJob(db, lease);
  const job = authorized?.job ?? completed;
  if (!job || !validScanVerdict(value, job.sha256, job.byteSize, clock().valueOf())) return "rejected";
  const verdict = projectScanVerdict(value);
  const encoded = encodedReceipt(job, verdict);
  if (encoded.byteLength > SCAN_RECEIPT_MAX_BYTES) return "rejected";
  const digest = await sha256Hex(encoded), key = receiptKey(job, digest);
  if (completed) {
    const attachment = await activeScanAttachment(db, job.attachmentId);
    // Retry success never re-publishes or replaces an existing result.
    return completed.resultDigest === digest && completed.receiptKey === key
      && !!attachment && jobMatches(attachment, completed)
      && metadataMatches(attachment, await bucket.head(attachment.storage_key))
      && !!(await receiptBytes(bucket, key, digest)) ? "duplicate" : "rejected";
  }
  if (!(await scannerFresh(db, clock(), lease.scannerId, verdict))) return "rejected";
  // The key includes the content digest and the lease generation. Never overwrite
  // any existing receipt, including one left by a previously interrupted report.
  await bucket.put(key, encoded, { onlyIf: { etagDoesNotMatch: "*" },
    sha256: await crypto.subtle.digest("SHA-256", new Uint8Array(encoded)),
    httpMetadata: { contentType: "application/json", cacheControl: "private, no-store" } });
  if (!(await receiptBytes(bucket, key, digest))) return "rejected";
  authorized = await authorizedScanObject(db, bucket, lease, clock);
  if (!authorized || !jobMatches(authorized.attachment, job)
    || !validScanVerdict(verdict, job.sha256, job.byteSize, clock().valueOf())) return "rejected";
  if (await commitScanResult(db, lease, { receiptKey: key, resultDigest: digest, verdict }, clock())) return "completed";
  // Two identical concurrent completions can race at CAS; reconcile only the
  // exact committed lease/digest, never a different or newer verdict.
  const winner = await completedLeaseJob(db, lease);
  return winner?.receiptKey === key && winner.resultDigest === digest ? "duplicate" : "rejected";
}

/**
 * No clean metadata flag is trusted. Return a row only if the currently committed
 * receipt and current immutable R2 object agree. Caller must still condition its
 * actual range read on this same version and re-run this check for every chunk.
 */
export async function scannedAttachment(
  db: CrmDatabase, bucket: PrivateObjectBucket, attachmentId: string, now: ClockInput = () => new Date(),
): Promise<AttachmentObjectRow | null> {
  const clock = clockFor(now);
  if (!Number.isFinite(clock().valueOf())) return null;
  const row = await activeScanAttachment(db, attachmentId);
  const job = row ? await attachmentScanJob(db, attachmentId) : null;
  if (!row || !job || !jobMatches(row, job) || job.state !== "completed" || job.resultStatus !== "clean"
    || !job.receiptKey || !job.resultDigest || job.receiptKey !== receiptKey(job, job.resultDigest)
    || !metadataMatches(row, await bucket.head(row.storage_key))) return null;
  const bytes = await receiptBytes(bucket, job.receiptKey, job.resultDigest);
  if (!bytes) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const receipt = value as Partial<ScanReceipt>;
  if (receipt.policy !== ATTACHMENT_SCAN_POLICY || receipt.jobId !== job.id || receipt.generation !== job.generation
    || receipt.objectKey !== row.storage_key || receipt.objectVersion !== row.object_version
    || !validScanVerdict(receipt.verdict, row.sha256, row.byte_size, clock().valueOf())
    || receipt.verdict.status !== "clean" || receipt.verdict.scannedAt !== job.scannedAt
    || receipt.verdict.signatureUpdatedAt !== job.signatureUpdatedAt) return null;
  // A generation/pointer change during the R2 read revokes this observation.
  const current = await attachmentScanJob(db, attachmentId);
  if (!current || current.state !== "completed" || current.resultStatus !== "clean"
    || current.generation !== job.generation || current.receiptKey !== job.receiptKey || current.resultDigest !== job.resultDigest
    || !metadataMatches(row, await bucket.head(row.storage_key))
    || !validScanVerdict(receipt.verdict, row.sha256, row.byte_size, clock().valueOf())) return null;
  return row;
}

/**
 * Only definitive negative evidence for the current object is terminal. This is
 * never download permission: unknown, replaced or inconsistent evidence stays in
 * quarantine, and the caller must still recheck its session after this R2 I/O.
 */
export async function blockedAttachment(
  db: CrmDatabase, bucket: PrivateObjectBucket, attachmentId: string, now: ClockInput = () => new Date(),
): Promise<boolean> {
  const clock = clockFor(now);
  if (!Number.isFinite(clock().valueOf())) return false;
  const row = await activeScanAttachment(db, attachmentId);
  const job = row ? await attachmentScanJob(db, attachmentId) : null;
  if (!row || !job || !jobMatches(row, job)) return false;
  const policyBlocked = job.state === "blocked" && job.errorCode === "archive_policy_blocked"
    && job.resultStatus === null && job.receiptKey === null && job.resultDigest === null;
  const infected = job.state === "completed" && job.resultStatus === "infected"
    && !!job.receiptKey && !!job.resultDigest && job.receiptKey === receiptKey(job, job.resultDigest);
  if ((!policyBlocked && !infected) || !metadataMatches(row, await bucket.head(row.storage_key))) return false;
  if (infected) {
    const bytes = await receiptBytes(bucket, job.receiptKey!, job.resultDigest!);
    if (!bytes) return false;
    let value: unknown;
    try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { return false; }
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const receipt = value as Partial<ScanReceipt>;
    // Infection does not expire into a retryable state when a clean-result TTL
    // passes. Validate the original verdict at its scan time, but reject future
    // timestamps and require the immutable receipt's committed bindings.
    const scanned = isoTime(job.scannedAt), at = clock().valueOf();
    if (receipt.policy !== ATTACHMENT_SCAN_POLICY || receipt.jobId !== job.id || receipt.generation !== job.generation
      || receipt.objectKey !== row.storage_key || receipt.objectVersion !== row.object_version
      || !validScanVerdict(receipt.verdict, row.sha256, row.byte_size, scanned)
      || receipt.verdict.status !== "infected" || receipt.verdict.scannedAt !== job.scannedAt
      || receipt.verdict.signatureUpdatedAt !== job.signatureUpdatedAt || !Number.isFinite(at)
      || scanned > at + 30_000 || isoTime(job.signatureUpdatedAt) > at + 30_000) return false;
  }
  // R2 reads can span owner deletion, object replacement or job supersession.
  // Re-read the active row and current job after the final metadata await.
  if (!metadataMatches(row, await bucket.head(row.storage_key))) return false;
  const currentRow = await activeScanAttachment(db, attachmentId);
  const current = await attachmentScanJob(db, attachmentId);
  return Number.isFinite(clock().valueOf()) && !!currentRow && !!current && jobMatches(currentRow, job) && jobMatches(currentRow, current)
    && currentRow.owner_kind === row.owner_kind && currentRow.owner_id === row.owner_id
    && current.id === job.id && current.generation === job.generation && current.state === job.state
    && current.errorCode === job.errorCode && current.resultStatus === job.resultStatus
    && current.receiptKey === job.receiptKey && current.resultDigest === job.resultDigest
    && current.scannedAt === job.scannedAt && current.signatureUpdatedAt === job.signatureUpdatedAt;
}
