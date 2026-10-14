import "server-only";

import { recordAcceptedOutboundMessage } from "./accepted-outbound-message";
import {
  withExchangeAccess,
  type ExchangeAccess,
  type ExchangeServiceContext,
} from "./exchange-connection-service";
import {
  findExchangeDraftsByCommand,
  findExchangeSentItemsByCommand,
} from "./exchange-graph";
import {
  getExchangeSendState,
  transitionExchangeSendState,
  type ExchangeSendState,
} from "./exchange-mail-store";
import type { CrmDatabase } from "./d1";
import {
  outboundMessageSnapshotJson,
  parseOutboundMessageSnapshot,
  type OutboundMessageSnapshot,
} from "./outbound-message-snapshot";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MANUAL_FAILURE = "exchange_reconciliation_manual_review";

type StoredExchangeCommand = {
  commandId: string;
  requestHash: string;
  status: string;
  transportProvider: string;
  mailboxId: string;
  contactId: string | null;
  conversationId: string | null;
  providerMessageId: string | null;
  messageSnapshotJson: string | null;
  operatorConfirmedAt: string | null;
  complianceSnapshotJson: string | null;
  failureCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExchangeReconciliationManualReason =
  | "incomplete_results"
  | "no_sent_item"
  | "ambiguous_matches"
  | "provider_identity_conflict"
  | "sent_item_incomplete";

export type ExchangeSendReconciliationResult =
  | {
    resolved: true;
    outcome: "accepted";
    commandId: string;
    providerMessageId: string;
    conversationId: string | null;
    crmRecorded: boolean;
    idempotent: boolean;
  }
  | {
    resolved: false;
    outcome: "manual_review";
    commandId: string;
    reason: ExchangeReconciliationManualReason;
    draftMatches: number;
    sentMatches: number;
    complete: boolean;
    idempotent: boolean;
  };

export type UnresolvedExchangeSendSummary = {
  commandId: string;
  phase: string;
  mailboxId: string;
  contactId: string;
  mailboxAddress: string | null;
  recipient: string | null;
  subject: string | null;
  snapshotValid: boolean;
  createdAt: string;
  updatedAt: string;
};

export class ExchangeSendReconciliationError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(code);
    this.name = "ExchangeSendReconciliationError";
  }
}

export function parseExchangeSendReconciliationRequest(value: unknown): { commandId: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== "commandId" && key !== "confirmed") ||
      input.confirmed !== true || typeof input.commandId !== "string" || !UUID.test(input.commandId)) return null;
  return { commandId: input.commandId };
}

export async function listUnresolvedExchangeSends(db: CrmDatabase): Promise<UnresolvedExchangeSendSummary[]> {
  const rows = await db.prepare(
    `SELECT c.id AS commandId, s.phase, c.mailbox_id AS mailboxId,
            c.contact_id AS contactId, c.request_hash AS requestHash,
            c.message_snapshot_json AS messageSnapshotJson,
            c.created_at AS createdAt, c.updated_at AS updatedAt
     FROM send_commands c
     JOIN exchange_send_state s ON s.command_id=c.id
     WHERE c.transport_provider='exchange' AND c.status='dispatching'
       AND c.operator_confirmed_at IS NOT NULL
       AND c.compliance_snapshot_json IS NOT NULL
       AND c.message_snapshot_json IS NOT NULL
       AND c.contact_id IS NOT NULL
       AND c.provider_message_id IS NULL
       AND s.phase IN ('prepared','drafted','send_requested','unknown','manual_review')
     ORDER BY c.updated_at ASC,c.id ASC LIMIT 50`,
  ).all<{
    commandId: string; phase: string; mailboxId: string; contactId: string;
    requestHash: string; messageSnapshotJson: string; createdAt: string; updatedAt: string;
  }>();
  return rows.results.map(row => {
    const snapshot = parseOutboundMessageSnapshot(row.messageSnapshotJson);
    const snapshotValid = validSnapshot(row, snapshot);
    return {
      commandId: row.commandId, phase: row.phase, mailboxId: row.mailboxId,
      contactId: row.contactId, mailboxAddress: snapshotValid ? snapshot!.mailbox.address : null,
      recipient: snapshotValid ? snapshot!.recipient : null,
      subject: snapshotValid ? snapshot!.subject : null,
      snapshotValid, createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  });
}

export async function reconcileExchangeUnknownSend(
  context: ExchangeServiceContext,
  commandId: string,
): Promise<ExchangeSendReconciliationResult> {
  if (!UUID.test(commandId)) invalid(400, "exchange_reconciliation_invalid");
  return withExchangeAccess(context, access => adjudicateExchangeUnknownSend(context.db, access, commandId));
}

/**
 * Read-only upstream adjudication. This function may repair local state, but it
 * never creates, submits, resends, moves or deletes a Microsoft message.
 */
export async function adjudicateExchangeUnknownSend(
  db: CrmDatabase,
  access: ExchangeAccess,
  commandId: string,
): Promise<ExchangeSendReconciliationResult> {
  if (!UUID.test(commandId)) invalid(400, "exchange_reconciliation_invalid");
  const command = await loadCommand(db, commandId);
  const state = await getExchangeSendState(db, access.scope, commandId);
  if (!state) invalid(404, "exchange_reconciliation_not_found");
  const snapshot = validatedSnapshot(command);
  if (state.correlationId !== commandId) invalid(409, "exchange_reconciliation_state_invalid");
  if (state.phase === "rejected") invalid(409, "exchange_reconciliation_terminal");

  if (alreadyAccepted(command, state, snapshot)) {
    return acceptedResult(db, command, snapshot, command.providerMessageId!, true);
  }

  const drafts = await findExchangeDraftsByCommand(access, commandId);
  const sent = await findExchangeSentItemsByCommand(access, commandId);
  const complete = drafts.complete && sent.complete;
  const draftItem = drafts.messages.length === 1 ? drafts.messages[0] : null;
  const sentItem = sent.messages.length === 1 ? sent.messages[0] : null;
  const identityConflict = Boolean(
    draftItem && state.graphMessageId && state.graphMessageId !== draftItem.id ||
    sentItem && state.graphMessageId && state.graphMessageId !== sentItem.id ||
    sentItem && command.providerMessageId && command.providerMessageId !== sentItem.id ||
    sentItem?.conversationId && snapshot.providerConversationId &&
      snapshot.providerConversationId !== sentItem.conversationId,
  );

  if (complete && drafts.messages.length === 0 && sentItem && sentItem.conversationId && !identityConflict) {
    return persistAccepted(db, access, command, state, snapshot, sentItem.id, sentItem.conversationId);
  }

  const reason: ExchangeReconciliationManualReason = !complete
    ? "incomplete_results"
    : identityConflict
      ? "provider_identity_conflict"
      : sent.messages.length > 1 || drafts.messages.length > 1 ||
          sent.messages.length === 1 && drafts.messages.length !== 0
        ? "ambiguous_matches"
        : sentItem && !sentItem.conversationId
          ? "sent_item_incomplete"
          : "no_sent_item";
  return persistManualReview(db, access, command, state, reason, drafts.messages.length, sent.messages.length, complete,
    complete && sent.messages.length === 0 && drafts.messages.length === 1 ? drafts.messages[0].id : undefined);
}

async function persistAccepted(
  db: CrmDatabase,
  access: ExchangeAccess,
  initialCommand: StoredExchangeCommand,
  initialState: ExchangeSendState,
  snapshot: OutboundMessageSnapshot,
  providerMessageId: string,
  providerConversationId: string,
): Promise<ExchangeSendReconciliationResult> {
  await assertProviderIdentityAvailable(db, initialCommand.commandId, providerMessageId);
  let state = initialState;
  const idempotent = false;
  if (state.phase !== "accepted") {
    let transitioned: ExchangeSendState | null = null;
    try {
      transitioned = await transitionExchangeSendState(db, {
        scope: access.scope, guard: access.guard, commandId: state.commandId,
        expectedVersion: state.version, from: state.phase, to: "accepted", graphMessageId: providerMessageId,
      }, access.now());
    } catch {
      // D1 may have committed despite a missing acknowledgement. Observe the
      // exact terminal state; never repeat any provider mutation (there is none).
    }
    if (!transitioned) {
      const observed = await getExchangeSendState(db, access.scope, state.commandId);
      if (!observed || observed.phase !== "accepted" || observed.graphMessageId !== providerMessageId) {
        invalid(409, "exchange_reconciliation_state_changed");
      }
      state = observed;
    } else state = transitioned;
  }
  if (state.graphMessageId !== providerMessageId) invalid(409, "exchange_reconciliation_state_changed");

  const updatedSnapshot = outboundMessageSnapshotJson({ ...snapshot, providerConversationId });
  let command: StoredExchangeCommand;
  try {
    const updated = await db.prepare(
      `UPDATE send_commands SET status='sent',provider_message_id=?,response_status=202,
              failure_code=NULL,message_snapshot_json=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND transport_provider='exchange' AND request_hash=?
         AND mailbox_id=? AND contact_id=? AND operator_confirmed_at IS NOT NULL
         AND compliance_snapshot_json IS NOT NULL
         AND ((status='dispatching' AND provider_message_id IS NULL)
           OR (status='sent' AND provider_message_id=?))
       RETURNING id AS commandId,request_hash AS requestHash,status,
         transport_provider AS transportProvider,mailbox_id AS mailboxId,
         contact_id AS contactId,conversation_id AS conversationId,
         provider_message_id AS providerMessageId,message_snapshot_json AS messageSnapshotJson,
         operator_confirmed_at AS operatorConfirmedAt,
         compliance_snapshot_json AS complianceSnapshotJson,failure_code AS failureCode,
         created_at AS createdAt,updated_at AS updatedAt`,
    ).bind(providerMessageId, updatedSnapshot, initialCommand.commandId, initialCommand.requestHash,
      initialCommand.mailboxId, initialCommand.contactId, providerMessageId).first<StoredExchangeCommand>();
    command = updated ?? await loadCommand(db, initialCommand.commandId);
  } catch {
    // As above, observe before categorizing an ambiguous D1 acknowledgement.
    command = await loadCommand(db, initialCommand.commandId);
  }
  if (command.status !== "sent" || command.providerMessageId !== providerMessageId ||
      parseOutboundMessageSnapshot(command.messageSnapshotJson)?.providerConversationId !== providerConversationId) {
    invalid(409, "exchange_reconciliation_state_changed");
  }
  return acceptedResult(db, command, parseOutboundMessageSnapshot(command.messageSnapshotJson)!, providerMessageId, idempotent);
}

async function persistManualReview(
  db: CrmDatabase,
  access: ExchangeAccess,
  command: StoredExchangeCommand,
  initialState: ExchangeSendState,
  reason: ExchangeReconciliationManualReason,
  draftMatches: number,
  sentMatches: number,
  complete: boolean,
  discoveredDraftId?: string,
): Promise<ExchangeSendReconciliationResult> {
  let idempotent = initialState.phase === "manual_review" ||
    initialState.phase === "accepted" && command.failureCode === MANUAL_FAILURE;
  if (initialState.phase !== "manual_review" && initialState.phase !== "accepted") {
    const graphMessageId = !initialState.graphMessageId || initialState.graphMessageId === discoveredDraftId
      ? discoveredDraftId : undefined;
    let transitioned: ExchangeSendState | null = null;
    try {
      transitioned = await transitionExchangeSendState(db, {
        scope: access.scope, guard: access.guard, commandId: command.commandId,
        expectedVersion: initialState.version, from: initialState.phase, to: "manual_review", graphMessageId,
      }, access.now());
    } catch {
      // Read after a possibly committed CAS; a repeat remains provider-read-only.
    }
    if (!transitioned) {
      const observed = await getExchangeSendState(db, access.scope, command.commandId);
      if (!observed || observed.phase !== "manual_review") invalid(409, "exchange_reconciliation_state_changed");
      idempotent = true;
    }
  }
  try {
    await db.prepare(
      `UPDATE send_commands SET failure_code=?,updated_at=CURRENT_TIMESTAMP
       WHERE id=? AND transport_provider='exchange' AND status='dispatching'
         AND provider_message_id IS NULL AND operator_confirmed_at IS NOT NULL`,
    ).bind(MANUAL_FAILURE, command.commandId).run();
  } catch {
    // Verify the fixed marker below before treating the acknowledgement as lost.
  }
  const observed = await loadCommand(db, command.commandId);
  if (observed.status !== "dispatching" || observed.providerMessageId !== null || observed.failureCode !== MANUAL_FAILURE) {
    invalid(409, "exchange_reconciliation_state_changed");
  }
  return { resolved: false, outcome: "manual_review", commandId: command.commandId,
    reason, draftMatches, sentMatches, complete, idempotent };
}

async function acceptedResult(
  db: CrmDatabase,
  command: StoredExchangeCommand,
  snapshot: OutboundMessageSnapshot,
  providerMessageId: string,
  idempotent: boolean,
): Promise<ExchangeSendReconciliationResult> {
  let conversationId = command.conversationId;
  let crmRecorded = false;
  try {
    conversationId = await recordAcceptedOutboundMessage(db, {
      commandId: command.commandId, contactId: snapshot.contactId, provider: "exchange",
      providerMessageId, externalMessageId: null, providerConversationId: snapshot.providerConversationId,
      mailbox: snapshot.mailbox, recipient: snapshot.recipient, subject: snapshot.subject,
      text: snapshot.text, html: snapshot.html, actorEmail: snapshot.actorEmail,
      conversationId: command.conversationId ?? snapshot.conversationId, occurredAt: snapshot.occurredAt,
    });
    crmRecorded = true;
  } catch {
    // Microsoft evidence remains authoritative. Repeating this adjudication
    // retries only the local idempotent CRM projection, never provider send.
  }
  return { resolved: true, outcome: "accepted", commandId: command.commandId,
    providerMessageId, conversationId, crmRecorded, idempotent };
}

async function assertProviderIdentityAvailable(db: CrmDatabase, commandId: string, providerMessageId: string) {
  const owner = await db.prepare(
    `SELECT id FROM send_commands WHERE transport_provider='exchange' AND provider_message_id=? LIMIT 1`,
  ).bind(providerMessageId).first<{ id: string }>();
  if (owner && owner.id !== commandId) invalid(409, "exchange_reconciliation_provider_conflict");
}

async function loadCommand(db: CrmDatabase, commandId: string): Promise<StoredExchangeCommand> {
  const command = await db.prepare(
    `SELECT id AS commandId,request_hash AS requestHash,status,
            transport_provider AS transportProvider,mailbox_id AS mailboxId,
            contact_id AS contactId,conversation_id AS conversationId,
            provider_message_id AS providerMessageId,message_snapshot_json AS messageSnapshotJson,
            operator_confirmed_at AS operatorConfirmedAt,
            compliance_snapshot_json AS complianceSnapshotJson,failure_code AS failureCode,
            created_at AS createdAt,updated_at AS updatedAt
     FROM send_commands WHERE id=? LIMIT 1`,
  ).bind(commandId).first<StoredExchangeCommand>();
  if (!command) invalid(404, "exchange_reconciliation_not_found");
  return command;
}

function validatedSnapshot(command: StoredExchangeCommand): OutboundMessageSnapshot {
  const snapshot = parseOutboundMessageSnapshot(command.messageSnapshotJson);
  if (command.transportProvider !== "exchange") invalid(409, "exchange_reconciliation_provider_mismatch");
  if (!command.operatorConfirmedAt || !command.complianceSnapshotJson || !command.contactId ||
      !validSnapshot({ requestHash: command.requestHash, mailboxId: command.mailboxId, contactId: command.contactId }, snapshot) ||
      command.status !== "dispatching" && command.status !== "sent") {
    invalid(409, "exchange_reconciliation_snapshot_invalid");
  }
  return snapshot!;
}

function validSnapshot(
  command: { requestHash: string; mailboxId: string; contactId: string },
  snapshot: OutboundMessageSnapshot | null,
): snapshot is OutboundMessageSnapshot {
  return Boolean(snapshot && snapshot.provider === "exchange" && snapshot.requestHash === command.requestHash &&
    snapshot.mailbox.id === command.mailboxId && snapshot.contactId === command.contactId);
}

function alreadyAccepted(command: StoredExchangeCommand, state: ExchangeSendState, snapshot: OutboundMessageSnapshot) {
  return state.phase === "accepted" && command.status === "sent" && Boolean(command.providerMessageId) &&
    state.graphMessageId === command.providerMessageId && Boolean(snapshot.providerConversationId);
}

function invalid(status: number, code: string): never {
  throw new ExchangeSendReconciliationError(status, code);
}
