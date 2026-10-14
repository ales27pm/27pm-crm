import type { CrmDatabase } from "./d1";

export type ExchangeCanaryReservation = {
  approvalDigest: string;
  canaryId: string;
  commandId: string;
  operator: string;
  recipient: string;
  subject: string;
  text: string;
  sentAt: string;
};

export type ExchangeCanaryResult =
  | {
      outcome: "accepted";
      providerMessageId: string;
      providerConversationId: string;
    }
  | {
      outcome: "failed" | "unconfirmed";
    };

const MAILBOX_ID = "mailbox_alexis";

/**
 * Reserve the exact reviewed canary and its Exchange send command in one D1
 * transaction. The immutable audit row is provider-specific so an earlier
 * Mailgun canary cannot authorize or block an Exchange attempt.
 */
export async function reserveExchangeDeliverabilityCanary(
  db: CrmDatabase,
  input: ExchangeCanaryReservation,
): Promise<boolean> {
  const auditId = `exchange-canary:${input.approvalDigest}`;
  const idempotencyKey = auditId;
  const details = JSON.stringify({
    canaryId: input.canaryId,
    commandId: input.commandId,
    recipient: input.recipient,
    subject: input.subject,
    sentAt: input.sentAt,
  });
  const complianceSnapshot = JSON.stringify({
    decision: {
      allowed: true,
      kind: "controlled_deliverability_canary",
      evaluatedAt: input.sentAt,
    },
    approvalDigest: input.approvalDigest,
    operator: { email: input.operator },
  });
  const messageSnapshot = JSON.stringify({
    version: 1,
    kind: "controlled_deliverability_canary",
    requestHash: input.approvalDigest,
    provider: "exchange",
    mailbox: {
      id: MAILBOX_ID,
      address: "alexis@27pm.org",
      purpose: "sales",
    },
    recipient: input.recipient,
    subject: input.subject,
    text: input.text,
    actorEmail: input.operator,
    occurredAt: input.sentAt,
  });

  const [audit, command] = await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO audit_entries
         (id, actor_email, action, entity_type, entity_id, details_json)
       VALUES (?, ?, 'exchange_canary_reserved', 'deliverability_canary', ?, ?)`,
    ).bind(auditId, input.operator, input.approvalDigest, details),
    db.prepare(
      `INSERT OR IGNORE INTO send_commands
         (id, transport_provider, idempotency_key, request_hash, mailbox_id,
          status, authorized_at, dispatched_at, operator_confirmed_at,
          compliance_snapshot_json, message_snapshot_json)
       SELECT ?, 'exchange', ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?
       WHERE EXISTS (
         SELECT 1 FROM audit_entries WHERE id=? AND details_json=?
       )`,
    ).bind(
      input.commandId,
      idempotencyKey,
      input.approvalDigest,
      MAILBOX_ID,
      input.sentAt,
      input.sentAt,
      input.sentAt,
      complianceSnapshot,
      messageSnapshot,
      auditId,
      details,
    ),
  ]);

  if (!audit.success || !command.success) {
    throw new Error("exchange_canary_reservation_failed");
  }
  return audit.meta.changes === 1 && command.meta.changes === 1;
}

/**
 * Record a terminal or uncertain provider outcome without ever releasing the
 * reservation. An uncertain result remains dispatching and can only be
 * resolved by a future read-only reconciliation.
 */
export async function recordExchangeDeliverabilityCanaryResult(
  db: CrmDatabase,
  input: ExchangeCanaryReservation & { result: ExchangeCanaryResult },
): Promise<void> {
  const accepted = input.result.outcome === "accepted";
  const unconfirmed = input.result.outcome === "unconfirmed";
  const resultId = `exchange-canary-result:${input.approvalDigest}`;
  const action = `exchange_canary_${input.result.outcome}`;
  const providerMessageId = input.result.outcome === "accepted"
    ? input.result.providerMessageId
    : null;
  const providerConversationId = input.result.outcome === "accepted"
    ? input.result.providerConversationId
    : null;
  const details = JSON.stringify({
    canaryId: input.canaryId,
    commandId: input.commandId,
    providerMessageId,
    providerConversationId,
  });
  const status = accepted ? "sent" : unconfirmed ? "dispatching" : "failed";
  const failureCode = accepted
    ? null
    : unconfirmed
      ? "transport_outcome_unknown"
      : "transport_failure";

  const [command, audit] = await db.batch([
    db.prepare(
      `UPDATE send_commands
       SET status=?, provider_message_id=?, response_status=?, failure_code=?,
           updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND transport_provider='exchange' AND status='dispatching'
         AND idempotency_key=? AND request_hash=?`,
    ).bind(
      status,
      providerMessageId,
      accepted ? 202 : null,
      failureCode,
      input.commandId,
      `exchange-canary:${input.approvalDigest}`,
      input.approvalDigest,
    ),
    db.prepare(
      `INSERT OR IGNORE INTO audit_entries
         (id, actor_email, action, entity_type, entity_id, details_json)
       VALUES (?, ?, ?, 'deliverability_canary', ?, ?)`,
    ).bind(
      resultId,
      input.operator,
      action,
      input.approvalDigest,
      details,
    ),
  ]);

  if (!command.success || command.meta.changes !== 1 ||
      !audit.success || audit.meta.changes !== 1) {
    throw new Error("exchange_canary_result_record_failed");
  }
}
