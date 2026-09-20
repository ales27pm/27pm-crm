import type { CrmDatabase } from "./d1";

/** Immutable, atomic reservation: an identical approved test may be attempted once. */
export async function reserveDeliverabilityCanary(
  db: CrmDatabase,
  input: {
    approvalDigest: string;
    canaryId: string;
    operator: string;
    recipient: string;
    subject: string;
    sentAt: string;
  },
): Promise<boolean> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO audit_entries
       (id, actor_email, action, entity_type, entity_id, details_json)
     VALUES (?, ?, 'mailgun_canary_reserved', 'deliverability_canary', ?, ?)`,
  ).bind(
    `mailgun-canary:${input.approvalDigest}`,
    input.operator,
    input.approvalDigest,
    JSON.stringify({
      canaryId: input.canaryId,
      recipient: input.recipient,
      subject: input.subject,
      sentAt: input.sentAt,
    }),
  ).run();
  if (!result.success) throw new Error("canary_reservation_failed");
  return result.meta.changes === 1;
}

/** Result recording is append-only; a failure must never release the reservation. */
export async function recordDeliverabilityCanaryResult(
  db: CrmDatabase,
  input: {
    approvalDigest: string;
    canaryId: string;
    operator: string;
    result: "accepted" | "failed" | "unconfirmed";
    providerMessageId?: string;
  },
): Promise<void> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO audit_entries
       (id, actor_email, action, entity_type, entity_id, details_json)
     VALUES (?, ?, ?, 'deliverability_canary', ?, ?)`,
  ).bind(
    `mailgun-canary-result:${input.approvalDigest}`,
    input.operator,
    `mailgun_canary_${input.result}`,
    input.approvalDigest,
    JSON.stringify({
      canaryId: input.canaryId,
      providerMessageId: input.providerMessageId ?? null,
    }),
  ).run();
  if (!result.success || result.meta.changes !== 1) {
    throw new Error("canary_result_record_failed");
  }
}
