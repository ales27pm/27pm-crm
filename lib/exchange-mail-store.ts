import type { CrmDatabase } from "./d1";
import { isTrustedExchangeDeltaCursor, type ExchangeGraphMessage } from "./exchange-graph";

export type ExchangeMailScope = { tenantId: string; mailboxId: string };
export type ExchangeMailGuard = { owner: string; generation: number };
export type ExchangeMessageClassification = "unclassified" | "mapped" | "ambiguous" | "external_sent" | "draft";
export type ExchangeSyncCursor = {
  id: string; tenantId: string; physicalMailboxId: string; folderId: string;
  generation: number; version: number; nextLink: string | null; deltaLink: string | null; updatedAt: string;
};
export type ExchangeMessageLink = {
  id: string; tenantId: string; physicalMailboxId: string; graphMessageId: string;
  crmMessageId: string | null; logicalMailboxId: string | null; internetMessageId: string | null;
  folderId: string | null; classification: ExchangeMessageClassification; messageJson: string;
  remoteRemoved: number; createdAt: string; updatedAt: string;
};
export type ExchangeSendPhase = "prepared" | "drafted" | "send_requested" | "accepted" | "unknown" | "manual_review" | "rejected";
export type ExchangeSendState = {
  commandId: string; tenantId: string; physicalMailboxId: string; correlationId: string;
  graphMessageId: string | null; phase: ExchangeSendPhase; version: number; createdAt: string; updatedAt: string;
};
type WriteContext = { scope: ExchangeMailScope; guard: ExchangeMailGuard };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const SCOPE = "tenant_id = ? AND physical_mailbox_id = ?";
const LEASE = `EXISTS (SELECT 1 FROM exchange_connections WHERE id='alexis'
  AND tenant_id=? AND mailbox_id=? AND lease_owner=? AND generation=?
  AND status='connected' AND lease_expires_at>?)`;
const CURSOR_COLUMNS = `id, tenant_id AS tenantId, physical_mailbox_id AS physicalMailboxId,
  folder_id AS folderId, generation, version, next_link AS nextLink, delta_link AS deltaLink, updated_at AS updatedAt`;
const LINK_COLUMNS = `id, tenant_id AS tenantId, physical_mailbox_id AS physicalMailboxId,
  graph_message_id AS graphMessageId, crm_message_id AS crmMessageId, logical_mailbox_id AS logicalMailboxId,
  internet_message_id AS internetMessageId, folder_id AS folderId, classification, message_json AS messageJson,
  remote_removed AS remoteRemoved, created_at AS createdAt, updated_at AS updatedAt`;
const SEND_COLUMNS = `command_id AS commandId, tenant_id AS tenantId, physical_mailbox_id AS physicalMailboxId,
  correlation_id AS correlationId, graph_message_id AS graphMessageId, phase, version,
  created_at AS createdAt, updated_at AS updatedAt`;

export async function getExchangeSyncCursor(db: CrmDatabase, scope: ExchangeMailScope, folderId: string): Promise<ExchangeSyncCursor | null> {
  if (!validScope(scope) || !opaque(folderId)) return null;
  return db.prepare(`SELECT ${CURSOR_COLUMNS} FROM exchange_sync_cursors WHERE ${SCOPE} AND folder_id=?`)
    .bind(scope.tenantId, scope.mailboxId, folderId).first<ExchangeSyncCursor>();
}

/** Advance only after every item in the page has been durably projected. Replay is safe. */
export async function saveExchangeSyncCursor(db: CrmDatabase, input: WriteContext & {
  folderId: string; expectedVersion: number | null; nextLink: string | null; deltaLink: string | null;
}, now = new Date()): Promise<ExchangeSyncCursor | null> {
  if (!validWrite(input, now) || !opaque(input.folderId) ||
      (input.expectedVersion !== null && !counter(input.expectedVersion)) ||
      (input.nextLink === null) === (input.deltaLink === null) ||
      !validCursor(input.nextLink ?? input.deltaLink, input.scope.mailboxId, input.folderId)) return null;
  return db.prepare(`INSERT INTO exchange_sync_cursors
    (id,connection_id,tenant_id,physical_mailbox_id,folder_id,generation,version,next_link,delta_link,updated_at)
    SELECT ?,'alexis',?,?,?, ?,0,?,?,? WHERE ${LEASE}
      AND (? IS NULL OR EXISTS (SELECT 1 FROM exchange_sync_cursors WHERE ${SCOPE} AND folder_id=? AND version=?))
    ON CONFLICT(tenant_id,physical_mailbox_id,folder_id) DO UPDATE SET
      generation=excluded.generation,version=exchange_sync_cursors.version+1,
      next_link=excluded.next_link,delta_link=excluded.delta_link,updated_at=excluded.updated_at
    WHERE ? IS NOT NULL AND exchange_sync_cursors.version=? RETURNING ${CURSOR_COLUMNS}`)
    .bind(crypto.randomUUID(), input.scope.tenantId, input.scope.mailboxId, input.folderId, input.guard.generation,
      input.nextLink, input.deltaLink, now.toISOString(), ...leaseValues(input, now), input.expectedVersion,
      input.scope.tenantId, input.scope.mailboxId, input.folderId, input.expectedVersion,
      input.expectedVersion, input.expectedVersion).first<ExchangeSyncCursor>();
}

/** A provider delta reset discards only a cursor, never imported CRM history. */
export async function resetExchangeSyncCursor(db: CrmDatabase, input: WriteContext & {
  folderId: string; expectedVersion: number;
}, now = new Date()): Promise<boolean> {
  if (!validWrite(input, now) || !opaque(input.folderId) || !counter(input.expectedVersion)) return false;
  const row = await db.prepare(`DELETE FROM exchange_sync_cursors WHERE ${SCOPE} AND folder_id=? AND version=?
    AND ${LEASE} RETURNING id`).bind(input.scope.tenantId, input.scope.mailboxId, input.folderId,
      input.expectedVersion, ...leaseValues(input, now)).first();
  return row !== null;
}

export async function getExchangeMessageLink(db: CrmDatabase, scope: ExchangeMailScope, graphMessageId: string): Promise<ExchangeMessageLink | null> {
  if (!validScope(scope) || !opaque(graphMessageId)) return null;
  return db.prepare(`SELECT ${LINK_COLUMNS} FROM exchange_message_links WHERE ${SCOPE} AND graph_message_id=?`)
    .bind(scope.tenantId, scope.mailboxId, graphMessageId).first<ExchangeMessageLink>();
}

/** Partial delta properties merge without nulling absent fields. RFC IDs never deduplicate. */
export async function upsertExchangeMessageLink(db: CrmDatabase, input: WriteContext & {
  message: ExchangeGraphMessage;
  projection?: { mailboxId: string | null; crmMessageId: string | null; classification: ExchangeMessageClassification };
}, now = new Date()): Promise<ExchangeMessageLink | null> {
  const serialized = serializeMessage(input.message);
  if (!validWrite(input, now) || !serialized || !validProjection(input.projection)) return null;
  const projection = input.projection;
  // A present recipient object replaces that property; recursively merging it
  // could retain the previous sender's display name after its address changed.
  const replacedObjects = ["from", "sender"].filter(key => Object.hasOwn(input.message, key));
  const previousJson = replacedObjects.length
    ? `json_remove(exchange_message_links.message_json,${replacedObjects.map(key => `'$.${key}'`).join(",")})`
    : "exchange_message_links.message_json";
  return db.prepare(`INSERT INTO exchange_message_links
    (id,connection_id,tenant_id,physical_mailbox_id,graph_message_id,crm_message_id,logical_mailbox_id,
     internet_message_id,folder_id,classification,message_json,remote_removed,created_at,updated_at)
    SELECT ?,'alexis',?,?,?,?,?,?,?,?,?,0,?,? WHERE ${LEASE}
    ON CONFLICT(tenant_id,physical_mailbox_id,graph_message_id) DO UPDATE SET
      message_json=json_patch(${previousJson},excluded.message_json),
      internet_message_id=COALESCE(excluded.internet_message_id,exchange_message_links.internet_message_id),
      folder_id=COALESCE(excluded.folder_id,exchange_message_links.folder_id),
      crm_message_id=CASE WHEN ? THEN excluded.crm_message_id ELSE exchange_message_links.crm_message_id END,
      logical_mailbox_id=CASE WHEN ? THEN excluded.logical_mailbox_id ELSE exchange_message_links.logical_mailbox_id END,
      classification=CASE WHEN ? THEN excluded.classification ELSE exchange_message_links.classification END,
      remote_removed=0,updated_at=excluded.updated_at
    WHERE exchange_message_links.crm_message_id IS NULL OR ?=0 OR
      (exchange_message_links.crm_message_id=excluded.crm_message_id AND
       exchange_message_links.logical_mailbox_id IS excluded.logical_mailbox_id)
    RETURNING ${LINK_COLUMNS}`)
    .bind(crypto.randomUUID(), input.scope.tenantId, input.scope.mailboxId, input.message.id,
      projection?.crmMessageId ?? null, projection?.mailboxId ?? null,
      input.message.internetMessageId ?? null, input.message.parentFolderId ?? null,
      projection?.classification ?? "unclassified", serialized, now.toISOString(), now.toISOString(),
      ...leaseValues(input, now), Number(Boolean(projection)), Number(Boolean(projection)),
      Number(Boolean(projection)), Number(Boolean(projection))).first<ExchangeMessageLink>();
}

/** A folder tombstone is not proof of deletion; never delete or mutate a CRM message. */
export async function markExchangeMessagesRemoved(db: CrmDatabase, input: WriteContext & {
  folderId: string; graphMessageIds: string[];
}, now = new Date()): Promise<number> {
  if (!validWrite(input, now) || !opaque(input.folderId) || !Array.isArray(input.graphMessageIds) ||
      input.graphMessageIds.length > 25 || !input.graphMessageIds.every(opaque)) return 0;
  const ids = [...new Set(input.graphMessageIds)];
  if (!ids.length) return 0;
  const result = await db.prepare(`UPDATE exchange_message_links SET remote_removed=1,updated_at=?
    WHERE ${SCOPE} AND folder_id=? AND graph_message_id IN (${ids.map(() => "?").join(",")})
      AND remote_removed=0 AND ${LEASE} RETURNING id`)
    .bind(now.toISOString(), input.scope.tenantId, input.scope.mailboxId, input.folderId, ...ids, ...leaseValues(input, now)).all();
  return result.success ? result.results.length : 0;
}

export async function getExchangeSendState(db: CrmDatabase, scope: ExchangeMailScope, commandId: string): Promise<ExchangeSendState | null> {
  if (!validScope(scope) || !GUID.test(commandId)) return null;
  return db.prepare(`SELECT ${SEND_COLUMNS} FROM exchange_send_state WHERE ${SCOPE} AND command_id=?`)
    .bind(scope.tenantId, scope.mailboxId, commandId).first<ExchangeSendState>();
}

/** Creation is allowed only for an already authorized durable Exchange send command. */
export async function createExchangeSendState(db: CrmDatabase, input: WriteContext & {
  commandId: string; correlationId: string;
}, now = new Date()): Promise<ExchangeSendState | null> {
  if (!validWrite(input, now) || !GUID.test(input.commandId) || !GUID.test(input.correlationId)) return null;
  return db.prepare(`INSERT INTO exchange_send_state
    (command_id,connection_id,tenant_id,physical_mailbox_id,correlation_id,phase,version,created_at,updated_at)
    SELECT ?,'alexis',?,?,?,'prepared',0,?,? WHERE ${LEASE}
      AND EXISTS (SELECT 1 FROM send_commands WHERE id=? AND transport_provider='exchange'
        AND status='dispatching' AND operator_confirmed_at IS NOT NULL
        AND compliance_snapshot_json IS NOT NULL AND message_snapshot_json IS NOT NULL)
    ON CONFLICT DO NOTHING RETURNING ${SEND_COLUMNS}`)
    .bind(input.commandId, input.scope.tenantId, input.scope.mailboxId, input.correlationId,
      now.toISOString(), now.toISOString(), ...leaseValues(input, now), input.commandId).first<ExchangeSendState>();
}

/** No transition can resend an uncertain or accepted command. Reconciliation is read-only upstream. */
export async function transitionExchangeSendState(db: CrmDatabase, input: WriteContext & {
  commandId: string; expectedVersion: number; from: ExchangeSendPhase; to: ExchangeSendPhase; graphMessageId?: string;
}, now = new Date()): Promise<ExchangeSendState | null> {
  if (!validWrite(input, now) || !GUID.test(input.commandId) || !counter(input.expectedVersion) ||
      !transitions[input.from]?.includes(input.to) ||
      (input.graphMessageId !== undefined && !opaque(input.graphMessageId))) return null;
  return db.prepare(`UPDATE exchange_send_state SET phase=?,version=version+1,
    graph_message_id=COALESCE(graph_message_id,?),updated_at=?
    WHERE ${SCOPE} AND command_id=? AND phase=? AND version=? AND ${LEASE}
      AND (? IS NULL OR graph_message_id IS NULL OR graph_message_id=?)
      AND (? NOT IN ('drafted','send_requested','accepted') OR COALESCE(graph_message_id,?) IS NOT NULL)
      AND EXISTS (SELECT 1 FROM send_commands WHERE id=exchange_send_state.command_id
        AND transport_provider='exchange' AND status IN ('dispatching','sent'))
    RETURNING ${SEND_COLUMNS}`)
    .bind(input.to, input.graphMessageId ?? null, now.toISOString(), input.scope.tenantId, input.scope.mailboxId,
      input.commandId, input.from, input.expectedVersion, ...leaseValues(input, now),
      input.graphMessageId ?? null, input.graphMessageId ?? null, input.to, input.graphMessageId ?? null).first<ExchangeSendState>();
}

const transitions: Record<ExchangeSendPhase, ExchangeSendPhase[]> = {
  prepared: ["drafted", "accepted", "unknown", "manual_review", "rejected"],
  drafted: ["send_requested", "accepted", "manual_review", "rejected"],
  send_requested: ["accepted", "unknown", "manual_review", "rejected"],
  unknown: ["accepted", "manual_review", "rejected"],
  manual_review: ["accepted"],
  accepted: [], rejected: [],
};
function validScope(scope: ExchangeMailScope): boolean { return Boolean(scope) && GUID.test(scope.tenantId) && GUID.test(scope.mailboxId); }
function counter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER; }
function opaque(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 2048 && !CONTROL.test(value); }
function validWrite(input: WriteContext, now: Date): boolean {
  return validScope(input.scope) && Boolean(input.guard) && GUID.test(input.guard.owner) && counter(input.guard.generation) && Number.isFinite(now.valueOf());
}
function leaseValues(input: WriteContext, now: Date) { return [input.scope.tenantId, input.scope.mailboxId, input.guard.owner, input.guard.generation, now.toISOString()]; }
function validCursor(value: string | null, mailboxId: string, folderId: string): boolean {
  return isTrustedExchangeDeltaCursor(value, mailboxId, folderId);
}
function validProjection(value: { mailboxId: string | null; crmMessageId: string | null; classification: ExchangeMessageClassification } | undefined): boolean {
  if (value === undefined) return true;
  if (!value || !["unclassified", "mapped", "ambiguous", "external_sent", "draft"].includes(value.classification)) return false;
  if (value.mailboxId !== null && !["mailbox_alexis", "mailbox_bonjour", "mailbox_admin"].includes(value.mailboxId)) return false;
  if (value.crmMessageId !== null && !opaque(value.crmMessageId)) return false;
  return (!value.crmMessageId || Boolean(value.mailboxId)) && (value.classification !== "mapped" || Boolean(value.mailboxId));
}
const MESSAGE_KEYS = new Set(["id", "parentFolderId", "changeKey", "internetMessageId", "conversationId", "subject", "text", "from", "sender", "toRecipients", "ccRecipients", "replyTo", "receivedDateTime", "sentDateTime", "lastModifiedDateTime", "isDraft", "isRead", "hasAttachments", "inferenceClassification", "headers", "commandId"]);
function serializeMessage(value: ExchangeGraphMessage): string | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || !opaque(value.id) ||
        Object.keys(value).some(key => !MESSAGE_KEYS.has(key)) || Object.values(value).some(item => item === null || item === undefined)) return null;
    for (const [key, item] of Object.entries(value)) {
      if (["from", "sender"].includes(key)) { if (!recipient(item)) return null; }
      else if (["toRecipients", "ccRecipients", "replyTo"].includes(key)) {
        if (!Array.isArray(item) || item.length > 100 || !item.every(recipient)) return null;
      } else if (["isDraft", "isRead", "hasAttachments"].includes(key)) { if (typeof item !== "boolean") return null; }
      else if (key === "headers") {
        if (!Array.isArray(item) || item.length > 100 || !item.every(header)) return null;
      } else if (key === "inferenceClassification") { if (item !== "focused" && item !== "other") return null; }
      else if (key === "commandId") { if (typeof item !== "string" || !GUID.test(item)) return null; }
      else if (typeof item !== "string" || item.length > (key === "text" ? 256 * 1024 : 8192)) return null;
    }
    const serialized = JSON.stringify(value);
    return new TextEncoder().encode(serialized).byteLength <= 384 * 1024 ? serialized : null;
  } catch { return null; }
}
function recipient(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => key === "address" || key === "name") &&
    typeof item.address === "string" && item.address.length <= 320 && /^[^\s@<>]+@[^\s@<>]+$/u.test(item.address) &&
    !CONTROL.test(item.address) && (item.name === undefined || typeof item.name === "string" && item.name.length <= 512 && !CONTROL.test(item.name));
}
const SAFE_HEADERS = new Set(["message-id", "in-reply-to", "references", "from", "sender", "to", "cc", "reply-to", "date",
  "authentication-results", "arc-authentication-results", "received-spf", "dkim-signature", "received", "return-path",
  "x-ms-exchange-organization-scl", "x-microsoft-antispam", "x-27pm-command-id"]);
function header(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every(key => key === "name" || key === "value") && typeof item.name === "string" &&
    SAFE_HEADERS.has(item.name.toLowerCase()) && typeof item.value === "string" && item.value.length <= 8192;
}
