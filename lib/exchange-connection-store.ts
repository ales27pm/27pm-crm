import type { CrmDatabase } from "./d1";

export const EXCHANGE_CONNECTION_ID = "alexis";
export const EXCHANGE_FLOW_TTL_SECONDS = 300;
export const EXCHANGE_LEASE_TTL_SECONDS = 60;

export type ExchangeConnectionConfig = {
  tenantId: string;
  mailboxId: string;
  clientId: string;
};

export type ExchangeConnection = ExchangeConnectionConfig & {
  id: "alexis";
  generation: number;
  version: number;
  status: "connected" | "disconnected" | "reauth_required";
  credentialVersion: string | null;
  leaseOwner: string | null;
  leaseExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type ExchangeOauthFlow = {
  id: string;
  connectionId: "alexis";
  generation: number;
  stateHash: string;
  binderHash: string;
  operatorEmail: string;
  status: "pending" | "staging" | "ready" | "consuming" | "completed" | "failed";
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
};

type LeaseGuard = { owner: string; generation: number; version: number };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const HASH = /^[0-9a-f]{64}$/u;
const CONNECTION_COLUMNS = `id, tenant_id AS tenantId, mailbox_id AS mailboxId,
  client_id AS clientId, generation, version, status,
  credential_version AS credentialVersion, lease_owner AS leaseOwner,
  lease_expires_at AS leaseExpiresAt, created_at AS createdAt, updated_at AS updatedAt`;
const FLOW_COLUMNS = `id, connection_id AS connectionId, generation,
  state_hash AS stateHash, binder_hash AS binderHash, operator_email AS operatorEmail,
  status, expires_at AS expiresAt, created_at AS createdAt, updated_at AS updatedAt`;
const ACTIVE_FLOW = "status IN ('pending', 'staging', 'ready', 'consuming')";
const FLOW_GENERATION_GUARD = `generation = (
  SELECT generation FROM exchange_connections WHERE id = 'alexis'
)`;

/** A GET never creates connection state. */
export async function getConnection(db: CrmDatabase): Promise<ExchangeConnection | null> {
  return db.prepare(`SELECT ${CONNECTION_COLUMNS} FROM exchange_connections WHERE id = 'alexis'`).first<ExchangeConnection>();
}

/** The singleton's configured tenant, app and mailbox cannot silently change. */
export async function ensureConnection(
  db: CrmDatabase,
  input: ExchangeConnectionConfig,
  now = new Date(),
): Promise<ExchangeConnection | null> {
  if (![input.tenantId, input.mailboxId, input.clientId].every(validGuid) || !validDate(now)) return null;
  const config = { tenantId: input.tenantId.toLowerCase(), mailboxId: input.mailboxId.toLowerCase(), clientId: input.clientId.toLowerCase() };
  await db.prepare(`INSERT INTO exchange_connections
    (id, tenant_id, mailbox_id, client_id, created_at, updated_at)
    VALUES ('alexis', ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`)
    .bind(config.tenantId, config.mailboxId, config.clientId, now.toISOString(), now.toISOString()).run();
  const row = await getConnection(db);
  return row && row.tenantId === config.tenantId && row.mailboxId === config.mailboxId && row.clientId === config.clientId ? row : null;
}

/** One lease serializes connect, refresh and disconnect; acquiring never extends an existing lease. */
export async function acquireConnectionLease(
  db: CrmDatabase,
  input: { owner: string; generation?: number; version?: number },
  now = new Date(),
): Promise<ExchangeConnection | null> {
  if (!validGuid(input.owner) || !validDate(now) || (input.generation !== undefined && !validCounter(input.generation)) || (input.version !== undefined && !validCounter(input.version))) return null;
  return db.prepare(`UPDATE exchange_connections
    SET lease_owner = ?, lease_expires_at = ?
    WHERE id = 'alexis' AND (lease_owner IS NULL OR lease_expires_at <= ?)
      AND (? IS NULL OR generation = ?) AND (? IS NULL OR version = ?)
    RETURNING ${CONNECTION_COLUMNS}`)
    .bind(input.owner, new Date(now.valueOf() + EXCHANGE_LEASE_TTL_SECONDS * 1000).toISOString(), now.toISOString(), input.generation ?? null, input.generation ?? null, input.version ?? null, input.version ?? null)
    .first<ExchangeConnection>();
}

/**
 * Give a still-current owner a fresh operation window after credential
 * rotation. This never revives an expired lease and never changes ownership,
 * generation, version, identity, or connection status.
 */
export async function renewConnectionLease(
  db: CrmDatabase,
  input: { owner: string; generation: number; version: number },
  now = new Date(),
): Promise<ExchangeConnection | null> {
  if (!validGuard(input) || !validDate(now)) return null;
  return db.prepare(`UPDATE exchange_connections
    SET lease_expires_at = ?
    WHERE id = 'alexis' AND status = 'connected'
      AND lease_owner = ? AND lease_expires_at > ?
      AND generation = ? AND version = ?
    RETURNING ${CONNECTION_COLUMNS}`)
    .bind(
      new Date(now.valueOf() + EXCHANGE_LEASE_TTL_SECONDS * 1000).toISOString(),
      input.owner,
      now.toISOString(),
      input.generation,
      input.version,
    )
    .first<ExchangeConnection>();
}

export async function releaseConnectionLease(db: CrmDatabase, input: { owner: string }): Promise<boolean> {
  if (!validGuid(input.owner)) return false;
  const result = await db.prepare(`UPDATE exchange_connections SET lease_owner = NULL, lease_expires_at = NULL
    WHERE id = 'alexis' AND lease_owner = ?`).bind(input.owner).run();
  return didChange(result);
}

/** Credentials must already exist at an immutable encrypted object version before CAS. */
export async function commitConnection(
  db: CrmDatabase,
  input: LeaseGuard & { status: "connected" | "reauth_required"; credentialVersion: string | null },
  now = new Date(),
): Promise<ExchangeConnection | null> {
  if (!validGuard(input) || !validDate(now) || !["connected", "reauth_required"].includes(input.status) ||
      (input.status === "connected" && !validGuid(input.credentialVersion)) ||
      (input.credentialVersion !== null && !validGuid(input.credentialVersion))) return null;
  return db.prepare(`UPDATE exchange_connections
    SET status = ?, credential_version = ?, version = version + 1, updated_at = ?
    WHERE id = 'alexis' AND lease_owner = ? AND lease_expires_at > ?
      AND generation = ? AND version = ?
    RETURNING ${CONNECTION_COLUMNS}`)
    .bind(input.status, input.credentialVersion, now.toISOString(), input.owner, now.toISOString(), input.generation, input.version)
    .first<ExchangeConnection>();
}

/** Finalize OAuth atomically with its credential pointer, rechecking the flow after provider I/O. */
export async function commitConnectionFlow(
  db: CrmDatabase,
  input: LeaseGuard & { credentialVersion: string; flowId: string },
  now = new Date(),
): Promise<ExchangeConnection | null> {
  if (!validGuard(input) || !validGuid(input.credentialVersion) || !validGuid(input.flowId) || !validDate(now)) return null;
  const results = await db.batch<ExchangeConnection | { id: string }>([
    db.prepare(`UPDATE exchange_connections
      SET status = 'connected', credential_version = ?, version = version + 1, updated_at = ?
      WHERE id = 'alexis' AND lease_owner = ? AND lease_expires_at > ?
        AND generation = ? AND version = ?
        AND EXISTS (SELECT 1 FROM exchange_oauth_flows WHERE id = ?
          AND connection_id = 'alexis' AND generation = ?
          AND status = 'consuming' AND expires_at > ?)
      RETURNING ${CONNECTION_COLUMNS}`)
      .bind(input.credentialVersion, now.toISOString(), input.owner, now.toISOString(), input.generation, input.version, input.flowId, input.generation, now.toISOString()),
    db.prepare(`UPDATE exchange_oauth_flows SET status = 'completed', updated_at = ?
      WHERE id = ? AND generation = ? AND status = 'consuming' AND expires_at > ?
        AND changes() = 1
        AND EXISTS (SELECT 1 FROM exchange_connections WHERE id = 'alexis'
          AND status = 'connected' AND credential_version = ? AND generation = ?
          AND version = ? AND lease_owner = ? AND lease_expires_at > ?)
      RETURNING id`)
      .bind(now.toISOString(), input.flowId, input.generation, now.toISOString(), input.credentialVersion, input.generation, input.version + 1, input.owner, now.toISOString()),
  ]);
  const connection = singleReturnedRow(results[0]);
  return results.length === 2 && connection && "status" in connection &&
    singleReturnedRow(results[1])?.id === input.flowId ? connection : null;
}

/** Fence old writers in D1 before tombstoning the old object; retain the caller's lease. */
export async function disconnectConnection(
  db: CrmDatabase,
  input: LeaseGuard,
  now = new Date(),
): Promise<ExchangeConnection | null> {
  if (!validGuard(input) || !validDate(now)) return null;
  const results = await db.batch<ExchangeConnection>([
    db.prepare(`UPDATE exchange_connections
      SET status = 'disconnected', credential_version = NULL, generation = generation + 1,
          version = version + 1, updated_at = ?
      WHERE id = 'alexis' AND lease_owner = ? AND lease_expires_at > ?
        AND generation = ? AND version = ? RETURNING ${CONNECTION_COLUMNS}`)
      .bind(now.toISOString(), input.owner, now.toISOString(), input.generation, input.version),
    db.prepare(`UPDATE exchange_oauth_flows SET status = 'failed', updated_at = ?
      WHERE connection_id = 'alexis' AND generation <= ? AND ${ACTIVE_FLOW}
        AND EXISTS (SELECT 1 FROM exchange_connections WHERE id = 'alexis'
          AND status = 'disconnected' AND generation = ? AND version = ?
          AND lease_owner = ? AND lease_expires_at > ?)`)
      .bind(now.toISOString(), input.generation, input.generation + 1, input.version + 1, input.owner, now.toISOString()),
  ]);
  return results.length === 2 && results.every((result) => result.success) ? singleReturnedRow(results[0]) : null;
}

export async function createFlow(
  db: CrmDatabase,
  input: { id: string; stateHash: string; binderHash: string; operatorEmail: string; generation: number; expiresAt: string },
  now = new Date(),
): Promise<ExchangeOauthFlow | null> {
  const email = normalizeOperator(input.operatorEmail);
  const expiry = new Date(input.expiresAt);
  if (!validGuid(input.id) || !HASH.test(input.stateHash) || !HASH.test(input.binderHash) || !email ||
      !validCounter(input.generation) || !validDate(now) || !validDate(expiry) ||
      expiry.valueOf() <= now.valueOf() || expiry.valueOf() > now.valueOf() + EXCHANGE_FLOW_TTL_SECONDS * 1000) return null;
  const results = await db.batch<ExchangeOauthFlow>([
    db.prepare(`UPDATE exchange_oauth_flows SET status = 'failed', updated_at = ? WHERE ${ACTIVE_FLOW} AND expires_at <= ?`)
      .bind(now.toISOString(), now.toISOString()),
    db.prepare(`INSERT INTO exchange_oauth_flows
      (id, connection_id, generation, state_hash, binder_hash, operator_email, expires_at, created_at, updated_at)
      SELECT ?, 'alexis', generation, ?, ?, ?, ?, ?, ? FROM exchange_connections
      WHERE id = 'alexis' AND generation = ?
      ON CONFLICT DO NOTHING RETURNING ${FLOW_COLUMNS}`)
      .bind(input.id, input.stateHash, input.binderHash, email, expiry.toISOString(), now.toISOString(), now.toISOString(), input.generation),
  ]);
  return results.length === 2 && results.every((result) => result.success) ? singleReturnedRow(results[1]) : null;
}

export async function claimCallback(
  db: CrmDatabase,
  input: { stateHash: string },
  now = new Date(),
): Promise<ExchangeOauthFlow | null> {
  if (!HASH.test(input.stateHash) || !validDate(now)) return null;
  return db.prepare(`UPDATE exchange_oauth_flows SET status = 'staging', updated_at = ?
    WHERE state_hash = ? AND status = 'pending' AND expires_at > ? AND ${FLOW_GENERATION_GUARD}
    RETURNING ${FLOW_COLUMNS}`).bind(now.toISOString(), input.stateHash, now.toISOString()).first<ExchangeOauthFlow>();
}

export async function finishCallback(
  db: CrmDatabase,
  input: { id: string; generation: number },
  now = new Date(),
): Promise<boolean> {
  if (!validGuid(input.id) || !validCounter(input.generation) || !validDate(now)) return false;
  const result = await db.prepare(`UPDATE exchange_oauth_flows SET status = 'ready', updated_at = ?
    WHERE id = ? AND generation = ? AND status = 'staging' AND expires_at > ? AND ${FLOW_GENERATION_GUARD}`)
    .bind(now.toISOString(), input.id, input.generation, now.toISOString()).run();
  return didChange(result);
}

export async function claimFinalize(
  db: CrmDatabase,
  input: { id: string; binderHash: string; operatorEmail: string },
  now = new Date(),
): Promise<ExchangeOauthFlow | null> {
  const email = normalizeOperator(input.operatorEmail);
  if (!validGuid(input.id) || !HASH.test(input.binderHash) || !email || !validDate(now)) return null;
  return db.prepare(`UPDATE exchange_oauth_flows SET status = 'consuming', updated_at = ?
    WHERE id = ? AND binder_hash = ? AND operator_email = ?
      AND status = 'ready' AND expires_at > ? AND ${FLOW_GENERATION_GUARD}
    RETURNING ${FLOW_COLUMNS}`)
    .bind(now.toISOString(), input.id, input.binderHash, email, now.toISOString()).first<ExchangeOauthFlow>();
}

export async function completeFlow(
  db: CrmDatabase,
  input: { id: string; generation: number; owner: string },
  now = new Date(),
): Promise<boolean> {
  if (!validGuid(input.id) || !validGuid(input.owner) || !validCounter(input.generation) || !validDate(now)) return false;
  const result = await db.prepare(`UPDATE exchange_oauth_flows SET status = 'completed', updated_at = ?
    WHERE id = ? AND generation = ? AND status = 'consuming' AND expires_at > ?
      AND EXISTS (SELECT 1 FROM exchange_connections WHERE id = 'alexis'
        AND status = 'connected' AND generation = ? AND lease_owner = ? AND lease_expires_at > ?)`)
    .bind(now.toISOString(), input.id, input.generation, now.toISOString(), input.generation, input.owner, now.toISOString()).run();
  return didChange(result);
}

export async function failFlow(db: CrmDatabase, input: { id: string }, now = new Date()): Promise<boolean> {
  if (!validGuid(input.id) || !validDate(now)) return false;
  return didChange(await db.prepare(`UPDATE exchange_oauth_flows SET status = 'failed', updated_at = ? WHERE id = ? AND ${ACTIVE_FLOW}`)
    .bind(now.toISOString(), input.id).run());
}

export type ExchangeCredentialCleanup = { credentialVersion: string; createdAt: string };

/** Track failed/unreferenced object writes; replacing a live pointer is queued by a DB trigger. */
export async function queueCredentialCleanup(db: CrmDatabase, credentialVersion: string, now = new Date()): Promise<boolean> {
  if (!validGuid(credentialVersion) || !validDate(now)) return false;
  const result = await db.prepare(`INSERT INTO exchange_credential_cleanup (credential_version, created_at)
    SELECT ?, ? WHERE NOT EXISTS (
      SELECT 1 FROM exchange_connections WHERE credential_version = ?
    ) ON CONFLICT(credential_version) DO NOTHING`)
    .bind(credentialVersion, now.toISOString(), credentialVersion).run();
  return didChange(result);
}

/** Callers drain only under the connection lease; never return the active object. */
export async function listCredentialCleanup(db: CrmDatabase, limit = 20): Promise<ExchangeCredentialCleanup[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) return [];
  const result = await db.prepare(`SELECT credential_version AS credentialVersion, created_at AS createdAt
    FROM exchange_credential_cleanup AS cleanup
    WHERE NOT EXISTS (SELECT 1 FROM exchange_connections AS connection
      WHERE connection.credential_version = cleanup.credential_version)
    ORDER BY created_at, credential_version LIMIT ?`).bind(Math.min(limit, 20)).all<ExchangeCredentialCleanup>();
  return result.success ? result.results : [];
}

/** Read-only status must not create a connection or consume cleanup jobs. */
export async function countCredentialCleanup(db: CrmDatabase): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS count FROM exchange_credential_cleanup").first<{ count: number }>();
  return row?.count ?? 0;
}

/** Remove a job only after the caller has confirmed its encrypted tombstone. */
export async function completeCredentialCleanup(db: CrmDatabase, credentialVersion: string): Promise<boolean> {
  if (!validGuid(credentialVersion)) return false;
  const result = await db.prepare(`DELETE FROM exchange_credential_cleanup
    WHERE credential_version = ? AND NOT EXISTS (
      SELECT 1 FROM exchange_connections WHERE credential_version = ?
    )`).bind(credentialVersion, credentialVersion).run();
  return didChange(result);
}

function validGuid(value: unknown): value is string { return typeof value === "string" && GUID.test(value); }
function validCounter(value: number): boolean { return Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER; }
function validDate(value: Date): boolean { return Number.isFinite(value.valueOf()); }
function validGuard(value: LeaseGuard): boolean { return validGuid(value.owner) && validCounter(value.generation) && validCounter(value.version); }
function normalizeOperator(value: string): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) ? email : null;
}
function didChange(result: { success: boolean; meta?: { changes?: number } }): boolean { return result.success && result.meta?.changes === 1; }

/** D1 meta.changes includes trigger writes; RETURNING proves the guarded row itself changed. */
function singleReturnedRow<T>(result: { success: boolean; results?: T[] } | undefined): T | null {
  return result?.success && result.results?.length === 1 ? result.results[0] : null;
}
