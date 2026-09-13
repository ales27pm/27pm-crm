import { recordAcceptedOutboundMessage } from "./accepted-outbound-message";
import type { CrmDatabase } from "./d1";
import { normalizeEmailAddress } from "./mailboxes";
import { reconcileOutboundEventsBestEffort } from "./outbound-event-reconciliation";
import { parseOutboundMessageSnapshot } from "./outbound-message-snapshot";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CAKEMAIL_PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const EXTERNAL_MESSAGE_ID =
  /^cakemail\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}@27pm\.org$/u;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_PROVIDER_EVENT_DELAY_MS = 31 * 24 * 60 * 60 * 1_000;
const STALE_DISPATCH_MS = 5 * 60 * 1_000;
const EVIDENCE_REFERENCE = /^[^\u0000-\u001f\u007f]{8,500}$/u;
const SECRET_LIKE = /ck_pat_[a-f0-9]{20,}/iu;

export type CakemailUnknownSendResolutionRequest = {
  commandId: string;
  externalMessageId: string;
  resolution: "accepted" | "rejected";
  providerMessageId: string | null;
  verifiedMessageIdHeader: string | null;
  providerObservedAt: string;
  evidenceReference: string;
  actorEmail: string;
};

export type CakemailUnknownSendResolutionResult = {
  resolved: true;
  resolution: "accepted" | "rejected";
  providerMessageId: string | null;
  externalMessageId: string;
  conversationId: string | null;
  crmRecorded: boolean;
  idempotent: boolean;
};

export type UnknownCakemailSendSummary = {
  commandId: string;
  externalMessageId: string;
  mailboxId: string;
  contactId: string;
  mailboxAddress: string | null;
  recipient: string | null;
  subject: string | null;
  contentMode: "html" | "text" | null;
  dispatchedAt: string | null;
  snapshotValid: boolean;
  createdAt: string;
  updatedAt: string;
};

type UnknownCakemailSendRow = Omit<
  UnknownCakemailSendSummary,
  "mailboxAddress" | "recipient" | "subject" | "contentMode" | "snapshotValid"
> & {
  messageSnapshotJson: string | null;
  failureCode: string | null;
  providerMessageId: string | null;
  status: string;
};

type StoredSendCommand = {
  commandId: string;
  requestHash: string;
  status: string;
  transportProvider: string;
  mailboxId: string;
  contactId: string | null;
  providerMessageId: string | null;
  externalMessageId: string | null;
  conversationId: string | null;
  messageSnapshotJson: string | null;
  dispatchedAt: string | null;
  failureCode: string | null;
};

export class CakemailUnknownSendResolutionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "CakemailUnknownSendResolutionError";
  }
}

export function parseCakemailUnknownSendResolutionRequest(
  value: unknown,
  actorEmail: string,
  now = new Date(),
): CakemailUnknownSendResolutionRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (input.confirmed !== true) return null;
  const core = parsedResolutionCore(input, actorEmail, now);
  if (!core) return null;
  const evidence = parsedProviderEvidence(input, core);
  return evidence ? { ...core, ...evidence } : null;
}

function parsedResolutionCore(
  input: Record<string, unknown>,
  actorEmail: string,
  now: Date,
): Omit<
  CakemailUnknownSendResolutionRequest,
  "providerMessageId" | "verifiedMessageIdHeader"
> | null {
  const commandId = canonicalString(input.commandId);
  const externalMessageId = canonicalString(input.externalMessageId);
  const evidenceReference = canonicalString(input.evidenceReference);
  const providerObservedAt = canonicalTimestamp(input.providerObservedAt);
  const normalizedActor = normalizeEmailAddress(actorEmail);
  const resolution = parsedResolution(input.resolution);
  if (!commandId || !externalMessageId) return null;
  if (!validResolutionIds(commandId, externalMessageId)) return null;
  if (!validEvidenceReference(evidenceReference)) return null;
  if (!providerObservedAt || timestampTooFarAhead(providerObservedAt, now)) return null;
  if (!normalizedActor || !resolution) return null;
  return {
    commandId,
    externalMessageId,
    resolution,
    providerObservedAt,
    evidenceReference,
    actorEmail: normalizedActor,
  };
}

function parsedProviderEvidence(
  input: Record<string, unknown>,
  core: Pick<CakemailUnknownSendResolutionRequest, "resolution" | "externalMessageId">,
): Pick<
  CakemailUnknownSendResolutionRequest,
  "providerMessageId" | "verifiedMessageIdHeader"
> | null {
  const providerMessageId = normalizedProviderMessageId(input.providerMessageId);
  const verifiedMessageIdHeader = canonicalString(input.verifiedMessageIdHeader);
  if (core.resolution === "accepted") {
    return providerMessageId && verifiedMessageIdHeader === `<${core.externalMessageId}>`
      ? { providerMessageId, verifiedMessageIdHeader }
      : null;
  }
  if (input.providerMessageId != null || input.verifiedMessageIdHeader != null) {
    return null;
  }
  return { providerMessageId, verifiedMessageIdHeader };
}

function validResolutionIds(
  commandId: string,
  externalMessageId: string,
): boolean {
  return UUID.test(commandId) && EXTERNAL_MESSAGE_ID.test(externalMessageId);
}

function validEvidenceReference(value: string | null): value is string {
  return Boolean(
    value && EVIDENCE_REFERENCE.test(value) && !SECRET_LIKE.test(value),
  );
}

function timestampTooFarAhead(value: string, now: Date): boolean {
  return Date.parse(value) > now.valueOf() + MAX_FUTURE_SKEW_MS;
}

function parsedResolution(value: unknown): "accepted" | "rejected" | null {
  return value === "accepted" || value === "rejected" ? value : null;
}

export async function listUnknownCakemailSends(
  db: CrmDatabase,
  now = new Date(),
): Promise<UnknownCakemailSendSummary[]> {
  const response = await db
    .prepare(
      `SELECT id AS commandId, status,
              provider_message_id AS providerMessageId,
              external_message_id AS externalMessageId,
              mailbox_id AS mailboxId, contact_id AS contactId,
              dispatched_at AS dispatchedAt,
              message_snapshot_json AS messageSnapshotJson,
              failure_code AS failureCode,
              created_at AS createdAt, updated_at AS updatedAt
       FROM send_commands
       WHERE transport_provider = 'cakemail' AND status = 'dispatching'
         AND (failure_code = 'transport_outcome_unknown' OR failure_code IS NULL)
         AND provider_message_id IS NULL AND external_message_id IS NOT NULL
         AND contact_id IS NOT NULL AND message_snapshot_json IS NOT NULL
       ORDER BY updated_at ASC, id ASC
       LIMIT 100`,
    )
    .all<UnknownCakemailSendRow>();
  return response.results
    .filter((row) => resolvableUnknownState(row, now))
    .slice(0, 50)
    .map(unknownSendSummary);
}

export async function resolveUnknownCakemailSend(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
  now = new Date(),
): Promise<CakemailUnknownSendResolutionResult> {
  const prepared = await prepareUnknownResolution(db, input);
  let { command } = prepared;
  const { snapshot } = prepared;
  const persisted = await persistUnknownResolution(db, input, command, now);
  command = persisted.command;
  if (input.resolution === "rejected") {
    return rejectedResolutionResult(input, command, persisted.idempotent);
  }
  return acceptedResolutionResult(
    db,
    input,
    command,
    snapshot,
    persisted.idempotent,
  );
}

async function prepareUnknownResolution(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
) {
  const command = await loadCommand(db, input.commandId);
  validateTarget(command, input);
  const snapshot = validatedSnapshot(command, input);
  validateEvidenceWindow(command.dispatchedAt, input.providerObservedAt);
  if (input.resolution === "accepted") {
    await assertProviderIdentityAvailable(db, input);
  }
  return { command, snapshot };
}

async function persistUnknownResolution(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
  initialCommand: StoredSendCommand,
  now: Date,
): Promise<{ command: StoredSendCommand; idempotent: boolean }> {
  let command = initialCommand;
  let alreadyResolved = matchingResolution(command, input);
  if (alreadyResolved) {
    await resolutionAuditStatement(db, input).run();
    return { command, idempotent: true };
  }
  assertUnknownState(command, now);
  const update = resolutionUpdateStatement(db, input, command);
  try {
    const results = await db.batch([
      update,
      resolutionAuditStatement(db, input),
    ]);
    const updateApplied = (results[0]?.meta?.changes ?? 0) === 1;
    command = await loadVerifiedResolution(db, input);
    alreadyResolved = !updateApplied;
  } catch (error) {
    if (uniqueConstraintError(error)) {
      throw resolutionError(409, "cakemail_provider_message_conflict");
    }
    throw error;
  }
  return { command, idempotent: alreadyResolved };
}

async function loadVerifiedResolution(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
): Promise<StoredSendCommand> {
  const command = await loadCommand(db, input.commandId);
  validateTarget(command, input);
  if (!matchingResolution(command, input)) {
    throw resolutionError(409, "cakemail_resolution_state_changed");
  }
  return command;
}

function rejectedResolutionResult(
  input: CakemailUnknownSendResolutionRequest,
  command: StoredSendCommand,
  idempotent: boolean,
): CakemailUnknownSendResolutionResult {
  return {
    resolved: true,
    resolution: "rejected",
    providerMessageId: null,
    externalMessageId: input.externalMessageId,
    conversationId: command.conversationId,
    crmRecorded: false,
    idempotent,
  };
}

async function acceptedResolutionResult(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
  command: StoredSendCommand,
  snapshot: NonNullable<ReturnType<typeof parseOutboundMessageSnapshot>>,
  idempotent: boolean,
): Promise<CakemailUnknownSendResolutionResult> {
  let conversationId = command.conversationId;
  let crmRecorded = false;
  try {
    conversationId = await recordAcceptedOutboundMessage(db, {
      commandId: command.commandId,
      contactId: snapshot.contactId,
      provider: "cakemail",
      providerMessageId: input.providerMessageId as string,
      externalMessageId: input.externalMessageId,
      mailbox: snapshot.mailbox,
      recipient: snapshot.recipient,
      subject: snapshot.subject,
      text: snapshot.text,
      html: snapshot.html,
      actorEmail: snapshot.actorEmail,
      conversationId: command.conversationId ?? snapshot.conversationId,
      occurredAt: snapshot.occurredAt,
    });
    crmRecorded = true;
  } catch {
    // The manual provider finding remains authoritative. A repeat of the same
    // resolution safely retries only the local CRM repair.
  }
  await reconcileOutboundEventsBestEffort(
    db,
    "cakemail",
    input.providerMessageId,
    input.externalMessageId,
  );
  return {
    resolved: true,
    resolution: "accepted",
    providerMessageId: input.providerMessageId,
    externalMessageId: input.externalMessageId,
    conversationId,
    crmRecorded,
    idempotent,
  };
}

function resolutionUpdateStatement(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
  command: StoredSendCommand,
) {
  return input.resolution === "accepted"
    ? acceptedResolutionStatement(db, input, command)
    : rejectedResolutionStatement(db, input, command);
}

function acceptedResolutionStatement(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
  command: StoredSendCommand,
) {
  const condition = unresolvedStateCondition(command);
  return db.prepare(
      `UPDATE send_commands
       SET status = 'sent', provider_message_id = ?, response_status = NULL,
           failure_code = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND transport_provider = 'cakemail'
         AND external_message_id = ? AND status = 'dispatching'
         AND ${condition.sql}
         AND provider_message_id IS NULL`,
    )
    .bind(
      input.providerMessageId,
      input.commandId,
      input.externalMessageId,
      ...condition.bindings,
    );
}

function rejectedResolutionStatement(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
  command: StoredSendCommand,
) {
  const condition = unresolvedStateCondition(command);
  return db.prepare(
      `UPDATE send_commands
       SET status = 'failed', response_status = NULL,
           failure_code = 'transport_rejected_verified',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND transport_provider = 'cakemail'
         AND external_message_id = ? AND status = 'dispatching'
         AND ${condition.sql}
         AND provider_message_id IS NULL`,
    )
    .bind(input.commandId, input.externalMessageId, ...condition.bindings);
}

async function loadCommand(
  db: CrmDatabase,
  commandId: string,
): Promise<StoredSendCommand> {
  const command = await db
    .prepare(
      `SELECT id AS commandId, request_hash AS requestHash, status,
              transport_provider AS transportProvider,
              mailbox_id AS mailboxId,
              contact_id AS contactId,
              provider_message_id AS providerMessageId,
              external_message_id AS externalMessageId,
              conversation_id AS conversationId,
              message_snapshot_json AS messageSnapshotJson,
              dispatched_at AS dispatchedAt,
              failure_code AS failureCode
       FROM send_commands WHERE id = ? LIMIT 1`,
    )
    .bind(commandId)
    .first<StoredSendCommand>();
  if (!command) throw resolutionError(404, "cakemail_resolution_not_found");
  return command;
}

function validateTarget(
  command: StoredSendCommand,
  input: CakemailUnknownSendResolutionRequest,
): void {
  if (command.transportProvider !== "cakemail") {
    throw resolutionError(409, "cakemail_resolution_provider_mismatch");
  }
  if (command.externalMessageId !== input.externalMessageId) {
    throw resolutionError(409, "cakemail_resolution_target_mismatch");
  }
}

function validatedSnapshot(
  command: StoredSendCommand,
  input: CakemailUnknownSendResolutionRequest,
) {
  const snapshot = parseOutboundMessageSnapshot(command.messageSnapshotJson);
  if (
    !snapshot ||
    snapshot.provider !== "cakemail" ||
    !command.contactId ||
    snapshot.requestHash !== command.requestHash ||
    snapshot.mailbox.id !== command.mailboxId ||
    snapshot.contactId !== command.contactId ||
    snapshot.recipient !== normalizeEmailAddress(snapshot.recipient) ||
    input.externalMessageId !== command.externalMessageId ||
    (command.conversationId !== null &&
      snapshot.conversationId !== null &&
      command.conversationId !== snapshot.conversationId)
  ) {
    throw resolutionError(409, "cakemail_resolution_snapshot_invalid");
  }
  return snapshot;
}

function matchingResolution(
  command: StoredSendCommand,
  input: CakemailUnknownSendResolutionRequest,
): boolean {
  if (input.resolution === "accepted") {
    return (
      command.status === "sent" &&
      command.providerMessageId === input.providerMessageId
    );
  }
  return (
    command.status === "failed" &&
    command.failureCode === "transport_rejected_verified" &&
    command.providerMessageId === null
  );
}

function assertUnknownState(command: StoredSendCommand, now: Date): void {
  if (!resolvableUnknownState(command, now)) {
    throw resolutionError(409, "cakemail_resolution_state_changed");
  }
}

function resolvableUnknownState(
  command: Pick<
    StoredSendCommand,
    "status" | "failureCode" | "providerMessageId" | "dispatchedAt"
  >,
  now: Date,
): boolean {
  if (command.status !== "dispatching" || command.providerMessageId !== null) {
    return false;
  }
  if (command.failureCode === "transport_outcome_unknown") return true;
  if (command.failureCode !== null) return false;
  const dispatchedAt = canonicalTimestamp(command.dispatchedAt);
  return Boolean(
    dispatchedAt &&
      now.valueOf() - Date.parse(dispatchedAt) >= STALE_DISPATCH_MS,
  );
}

function unresolvedStateCondition(command: StoredSendCommand): {
  sql: string;
  bindings: string[];
} {
  return command.failureCode === null
    ? { sql: "failure_code IS NULL AND dispatched_at = ?", bindings: [command.dispatchedAt as string] }
    : { sql: "failure_code = 'transport_outcome_unknown'", bindings: [] };
}

function resolutionAuditStatement(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
) {
  const resolvedCondition = input.resolution === "accepted"
    ? `status = 'sent' AND provider_message_id = ?`
    : `status = 'failed' AND failure_code = 'transport_rejected_verified'
       AND provider_message_id IS NULL`;
  const statement = db.prepare(
      `INSERT OR IGNORE INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
       SELECT ?, ?, 'integration.cakemail.outcome_resolved',
              'send_command', ?, ?
       WHERE EXISTS (
         SELECT 1 FROM send_commands
         WHERE id = ? AND transport_provider = 'cakemail'
           AND external_message_id = ? AND ${resolvedCondition}
       )`,
    );
  const bindings = [
    `cakemail-resolution:${input.commandId}:${input.resolution}`,
    input.actorEmail,
    input.commandId,
    JSON.stringify({
      resolution: input.resolution,
      externalMessageId: input.externalMessageId,
      providerMessageId: input.providerMessageId,
      verifiedMessageIdHeader: input.verifiedMessageIdHeader,
      providerObservedAt: input.providerObservedAt,
      evidenceReference: input.evidenceReference,
    }),
    input.commandId,
    input.externalMessageId,
  ];
  return input.resolution === "accepted"
    ? statement.bind(...bindings, input.providerMessageId)
    : statement.bind(...bindings);
}

async function assertProviderIdentityAvailable(
  db: CrmDatabase,
  input: CakemailUnknownSendResolutionRequest,
): Promise<void> {
  const stored = await db
    .prepare(
      `SELECT external_message_id AS externalMessageId
       FROM messages
       WHERE transport_provider = 'cakemail' AND provider_message_id = ?
       LIMIT 1`,
    )
    .bind(input.providerMessageId)
    .first<{ externalMessageId: string | null }>();
  if (stored && stored.externalMessageId !== input.externalMessageId) {
    throw resolutionError(409, "cakemail_provider_message_conflict");
  }
}

function validateEvidenceWindow(
  dispatchedAt: string | null,
  providerObservedAt: string,
): void {
  const canonicalDispatch = canonicalTimestamp(dispatchedAt);
  if (!canonicalDispatch) {
    throw resolutionError(409, "cakemail_resolution_dispatch_time_invalid");
  }
  const dispatchMs = Date.parse(canonicalDispatch);
  const observedMs = Date.parse(providerObservedAt);
  if (
    observedMs < dispatchMs ||
    observedMs > dispatchMs + MAX_PROVIDER_EVENT_DELAY_MS
  ) {
    throw resolutionError(409, "cakemail_resolution_evidence_time_invalid");
  }
}

function unknownSendSummary(
  row: UnknownCakemailSendRow,
): UnknownCakemailSendSummary {
  const snapshot = parseOutboundMessageSnapshot(row.messageSnapshotJson);
  const snapshotValid = Boolean(
    snapshot &&
      snapshot.provider === "cakemail" &&
      snapshot.contactId === row.contactId &&
      snapshot.mailbox.id === row.mailboxId,
  );
  return {
    commandId: row.commandId,
    externalMessageId: row.externalMessageId,
    mailboxId: row.mailboxId,
    contactId: row.contactId,
    mailboxAddress: snapshotValid && snapshot ? snapshot.mailbox.address : null,
    recipient: snapshotValid && snapshot ? snapshot.recipient : null,
    subject: snapshotValid && snapshot ? snapshot.subject : null,
    contentMode:
      snapshotValid && snapshot && snapshot.contentMode !== "multipart"
        ? snapshot.contentMode
        : null,
    dispatchedAt: row.dispatchedAt,
    snapshotValid,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function normalizedProviderMessageId(value: unknown): string | null {
  if (typeof value !== "string" || !CAKEMAIL_PROVIDER_UUID.test(value)) {
    return null;
  }
  return value.toLowerCase();
}

function canonicalString(value: unknown): string | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  return value || null;
}

function canonicalTimestamp(value: unknown): string | null {
  const candidate = canonicalString(value);
  if (!candidate) return null;
  const timestamp = new Date(candidate);
  return !Number.isNaN(timestamp.valueOf()) && timestamp.toISOString() === candidate
    ? candidate
    : null;
}

function resolutionError(
  status: number,
  code: string,
): CakemailUnknownSendResolutionError {
  return new CakemailUnknownSendResolutionError(status, code);
}

function uniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed|constraint failed/iu.test(message);
}
