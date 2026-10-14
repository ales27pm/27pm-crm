import type { CrmDatabase } from "./d1";
import {
  acquireConnectionLease, claimCallback, claimFinalize, commitConnection,
  commitConnectionFlow, createFlow, disconnectConnection, ensureConnection,
  failFlow, finishCallback, getConnection, releaseConnectionLease, renewConnectionLease,
  completeCredentialCleanup, countCredentialCleanup, listCredentialCleanup, queueCredentialCleanup,
  type ExchangeConnection,
} from "./exchange-connection-store";
import {
  createExchangeAuthorization, exchangeAuthorizationCode, refreshExchangeCredentials,
  type ExchangeOAuthConfig,
} from "./exchange-oauth";
import {
  readExchangeCredential, tombstoneExchangeCredential, writeExchangeCredential,
  type ExchangeCredentialBucket, type ExchangeVaultConfig, type ExchangeVaultPayload,
} from "./exchange-token-vault";

export type ExchangeServiceContext = {
  db: CrmDatabase;
  bucket: ExchangeCredentialBucket;
  oauth: ExchangeOAuthConfig;
  vault: ExchangeVaultConfig;
  now?: () => Date;
  fetcher?: typeof fetch;
};

/** Short-lived Graph access which never leaves the active connection lease. */
export type ExchangeAccess = {
  accessToken: string;
  mailboxId: string;
  assertCurrent: () => Promise<void>;
  fetcher?: typeof fetch;
  /** Internal-only D1 fencing values for sync/send state transitions. */
  scope: { tenantId: string; mailboxId: string };
  guard: { owner: string; generation: number };
  /** Internal clock shared by lease assertions and fenced D1 writes. */
  now: () => Date;
};

export class ExchangeConnectionError extends Error {
  constructor(readonly code: string, readonly status = 409) {
    super(code);
    this.name = "ExchangeConnectionError";
  }
}

const OPAQUE = /^[A-Za-z0-9_-]{43}$/u;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
const now = (ctx: ExchangeServiceContext) => ctx.now?.() ?? new Date();
const flowPurpose = (id: string) => `flow:${id}`;
const tokenPurpose = (id: string) => `credential:${id}`;

export async function exchangeConnectionStatus(ctx: ExchangeServiceContext) {
  const row = await getConnection(ctx.db);
  if (row) assertIdentity(ctx, row);
  return { ...publicStatus(row), cleanupPending: await countCredentialCleanup(ctx.db) > 0 };
}

export async function startExchangeConnection(ctx: ExchangeServiceContext, operatorEmail: string, binder: unknown) {
  if (typeof binder !== "string" || !OPAQUE.test(binder)) invalid();
  const connection = await ensureConnection(ctx.db, ctx.oauth, now(ctx));
  if (!connection) throw new ExchangeConnectionError("exchange_configuration_mismatch", 503);
  if (connection.status === "connected") throw new ExchangeConnectionError("exchange_already_connected");
  const authorization = await createExchangeAuthorization(ctx.oauth, now(ctx));
  const id = crypto.randomUUID();
  const flow = await createFlow(ctx.db, {
    id, operatorEmail, generation: connection.generation,
    stateHash: await hash(authorization.state), binderHash: await hash(binder as string),
    expiresAt: authorization.expiresAt,
  }, now(ctx));
  if (!flow) throw new ExchangeConnectionError("exchange_flow_busy");
  try {
    await writeImmutable(ctx, flowPurpose(id), {
      codeVerifier: authorization.codeVerifier, nonce: authorization.nonce,
      expiresAt: authorization.expiresAt,
    });
    // A concurrent disconnect may have fenced this flow while R2 was writing.
    const current = await getConnection(ctx.db);
    if (!current || current.generation !== flow.generation) invalid();
    return { flowId: id, authorizationUrl: authorization.authorizationUrl, expiresAt: authorization.expiresAt };
  } catch {
    await failFlow(ctx.db, { id }, now(ctx));
    await cleanCredential(ctx, flowPurpose(id));
    throw new ExchangeConnectionError("exchange_connection_unavailable", 503);
  }
}

/** Public Microsoft POST only stages an encrypted code; it cannot connect a mailbox. */
export async function stageExchangeCallback(ctx: ExchangeServiceContext, input: { state: string; code?: string; denied?: boolean }) {
  if (!OPAQUE.test(input.state)) invalid();
  const flow = await claimCallback(ctx.db, { stateHash: await hash(input.state) }, now(ctx));
  if (!flow) invalid();
  try {
    if (input.denied || !input.code || input.code.length > 12_000 || /[\u0000-\u0020\u007f]/u.test(input.code)) invalid();
    const stored = await readExchangeCredential(ctx.bucket, ctx.vault, flowPurpose(flow!.id));
    if (!stored?.payload || typeof stored.payload.codeVerifier !== "string" || typeof stored.payload.nonce !== "string") invalid();
    // Only encrypted R2 receives the code. In particular no URL, log, cookie or D1 field does.
    await writeExchangeCredential(ctx.bucket, ctx.vault, flowPurpose(flow!.id), {
      ...stored!.payload!, code: input.code!, callbackAt: now(ctx).toISOString(),
    }, { expectedEtag: stored!.etag });
    if (!await finishCallback(ctx.db, { id: flow!.id, generation: flow!.generation }, now(ctx))) invalid();
  } catch {
    await failFlow(ctx.db, { id: flow!.id }, now(ctx));
    await cleanCredential(ctx, flowPurpose(flow!.id));
    throw new ExchangeConnectionError("exchange_authorization_invalid", 400);
  }
}

/** The original authenticated browser proves possession of its one-use binder. */
export async function finalizeExchangeConnection(ctx: ExchangeServiceContext, operatorEmail: string, flowId: unknown, binder: unknown) {
  if (typeof flowId !== "string" || !UUID.test(flowId) || typeof binder !== "string" || !OPAQUE.test(binder)) invalid();
  const flow = await claimFinalize(ctx.db, { id: flowId as string, operatorEmail, binderHash: await hash(binder as string) }, now(ctx));
  if (!flow) invalid();
  const owner = crypto.randomUUID();
  let newVersion: string | null = null;
  let committed = false;
  let commitUnknown = false;
  let cleanupPending = false;
  try {
    const connection = await acquireConnectionLease(ctx.db, { owner, generation: flow!.generation }, now(ctx));
    if (!connection) throw new ExchangeConnectionError("exchange_connection_busy");
    assertIdentity(ctx, connection);
    if (connection.status === "connected") throw new ExchangeConnectionError("exchange_already_connected");
    const stored = await readExchangeCredential(ctx.bucket, ctx.vault, flowPurpose(flow!.id));
    const data = stored?.payload;
    if (!data || typeof data.code !== "string" || typeof data.codeVerifier !== "string" || typeof data.nonce !== "string" ||
      typeof data.callbackAt !== "string" || !Number.isFinite(Date.parse(data.callbackAt)) ||
      now(ctx).valueOf() - Date.parse(data.callbackAt) > 55_000 || Date.parse(data.callbackAt) > now(ctx).valueOf()) invalid();
    const result = await exchangeAuthorizationCode(ctx.oauth, {
      code: data!.code as string, codeVerifier: data!.codeVerifier as string, nonce: data!.nonce as string,
    }, { fetcher: ctx.fetcher, now: now(ctx) });
    if (!result.ok) throw new ExchangeConnectionError(result.error, 400);
    newVersion = crypto.randomUUID();
    await writeImmutable(ctx, tokenPurpose(newVersion), { refreshToken: result.value.refreshToken });
    let updated: ExchangeConnection | null;
    try {
      updated = await commitConnectionFlow(ctx.db, {
        owner, generation: connection.generation, version: connection.version,
        credentialVersion: newVersion, flowId: flow!.id,
      }, now(ctx));
    } catch {
      // A D1 acknowledgement can be lost after commit. Never delete a possibly active token.
      commitUnknown = true;
      const observed = await getConnection(ctx.db);
      commitUnknown = false;
      updated = observed?.credentialVersion === newVersion && observed.status === "connected" ? observed : null;
    }
    if (!updated) throw new ExchangeConnectionError("exchange_connection_changed");
    committed = true;
    cleanupPending = await drainCredentialCleanup(ctx, owner);
    return { ok: true, ...publicStatus(updated), cleanupPending };
  } finally {
    // Failure/expiry consumes the flow. No replay of Microsoft's code is ever attempted.
    try {
      if (!committed) await failFlow(ctx.db, { id: flow!.id }, now(ctx));
      if (newVersion && !committed && !commitUnknown) {
        await queueCredentialCleanup(ctx.db, newVersion, now(ctx));
        await drainCredentialCleanup(ctx, owner);
      }
      await cleanCredential(ctx, flowPurpose(flow!.id));
    } finally { await releaseConnectionLease(ctx.db, { owner }); }
  }
}

/** Manual only: refresh under a lease; persist the replacement before using its access token. */
export async function checkExchangeConnection(ctx: ExchangeServiceContext) {
  const initial = await getConnection(ctx.db);
  if (initial) assertIdentity(ctx, initial);
  if (!initial) return { ok: true, ...publicStatus(initial), cleanupPending: await countCredentialCleanup(ctx.db) > 0 };
  const owner = crypto.randomUUID();
  const connection = await acquireConnectionLease(ctx.db, { owner }, now(ctx));
  if (!connection) throw new ExchangeConnectionError("exchange_connection_busy");
  let newVersion: string | null = null;
  let committed = false;
  let commitUnknown = false;
  try {
    assertIdentity(ctx, connection);
    if (connection.status !== "connected") return { ok: true, ...publicStatus(connection), cleanupPending: await drainCredentialCleanup(ctx, owner) };
    if (!connection.credentialVersion) throw new ExchangeConnectionError("exchange_reauthentication_required");
    const stored = await readExchangeCredential(ctx.bucket, ctx.vault, tokenPurpose(connection.credentialVersion));
    if (typeof stored?.payload?.refreshToken !== "string") throw new ExchangeConnectionError("exchange_reauthentication_required");
    const result = await refreshExchangeCredentials(ctx.oauth, stored.payload.refreshToken, { fetcher: ctx.fetcher, now: now(ctx) });
    if (!result.ok) {
      if (result.error === "exchange_reauthentication_required") {
        await commitConnection(ctx.db, { owner, generation: connection.generation, version: connection.version,
          status: "reauth_required", credentialVersion: connection.credentialVersion }, now(ctx));
      }
      throw new ExchangeConnectionError(result.error, 503);
    }
    newVersion = crypto.randomUUID();
    await writeImmutable(ctx, tokenPurpose(newVersion), { refreshToken: result.value.refreshToken });
    let updated: ExchangeConnection | null;
    try {
      updated = await commitConnection(ctx.db, { owner, generation: connection.generation, version: connection.version,
        status: "connected", credentialVersion: newVersion }, now(ctx));
    } catch {
      commitUnknown = true;
      const observed = await getConnection(ctx.db);
      commitUnknown = false;
      updated = observed?.credentialVersion === newVersion && observed.status === "connected" ? observed : null;
    }
    if (!updated) throw new ExchangeConnectionError("exchange_connection_changed");
    committed = true;
    const cleanupPending = await drainCredentialCleanup(ctx, owner);
    // Connection proof only. No Graph message endpoint, send or delete is called here.
    return { ok: true, ...publicStatus(updated), cleanupPending };
  } finally {
    try {
      if (newVersion && !committed && !commitUnknown) {
        await queueCredentialCleanup(ctx.db, newVersion, now(ctx));
        await drainCredentialCleanup(ctx, owner);
      }
    } finally { await releaseConnectionLease(ctx.db, { owner }); }
  }
}

/**
 * Refresh and rotate the Microsoft credential once, then run one bounded Graph
 * operation while the connection lease is still current. The access token is
 * confined to the callback and is never returned by an HTTP route or stored.
 */
export async function withExchangeAccess<T>(
  ctx: ExchangeServiceContext,
  operation: (access: ExchangeAccess) => Promise<T>,
): Promise<T> {
  const initial = await getConnection(ctx.db);
  if (initial) assertIdentity(ctx, initial);
  if (!initial || initial.status !== "connected" || !initial.credentialVersion) {
    throw new ExchangeConnectionError("exchange_reauthentication_required", 503);
  }

  const owner = crypto.randomUUID();
  const connection = await acquireConnectionLease(ctx.db, { owner }, now(ctx));
  if (!connection) throw new ExchangeConnectionError("exchange_connection_busy");
  let newVersion: string | null = null;
  let committed = false;
  let commitUnknown = false;
  try {
    assertIdentity(ctx, connection);
    if (connection.status !== "connected" || !connection.credentialVersion) {
      throw new ExchangeConnectionError("exchange_reauthentication_required", 503);
    }
    const stored = await readExchangeCredential(ctx.bucket, ctx.vault, tokenPurpose(connection.credentialVersion));
    if (typeof stored?.payload?.refreshToken !== "string") {
      throw new ExchangeConnectionError("exchange_reauthentication_required", 503);
    }
    const result = await refreshExchangeCredentials(ctx.oauth, stored.payload.refreshToken, {
      fetcher: ctx.fetcher,
      now: now(ctx),
    });
    if (!result.ok) {
      if (result.error === "exchange_reauthentication_required") {
        await commitConnection(ctx.db, {
          owner,
          generation: connection.generation,
          version: connection.version,
          status: "reauth_required",
          credentialVersion: connection.credentialVersion,
        }, now(ctx));
      }
      throw new ExchangeConnectionError(result.error, 503);
    }

    newVersion = crypto.randomUUID();
    await writeImmutable(ctx, tokenPurpose(newVersion), { refreshToken: result.value.refreshToken });
    let updated: ExchangeConnection | null;
    try {
      updated = await commitConnection(ctx.db, {
        owner,
        generation: connection.generation,
        version: connection.version,
        status: "connected",
        credentialVersion: newVersion,
      }, now(ctx));
    } catch {
      // A lost D1 acknowledgement is reconciled by observing the exact fenced
      // lease and credential pointer. Never repeat the Microsoft refresh.
      commitUnknown = true;
      const observed = await getConnection(ctx.db);
      commitUnknown = false;
      updated = observed?.credentialVersion === newVersion &&
        observed.status === "connected" &&
        observed.generation === connection.generation &&
        observed.version === connection.version + 1 &&
        observed.leaseOwner === owner
        ? observed
        : null;
    }
    if (!updated) throw new ExchangeConnectionError("exchange_connection_changed");
    committed = true;

    // Token refresh, immutable-vault persistence and the D1 CAS all happen
    // before the bounded Graph operation. Renew exactly once here so that the
    // operation receives a full lease window; an expired or replaced owner can
    // never be revived by this renewal.
    const expected = await renewConnectionLease(ctx.db, {
      owner,
      generation: updated.generation,
      version: updated.version,
    }, now(ctx));
    if (!expected) throw new ExchangeConnectionError("exchange_connection_changed");
    const assertCurrent = async () => {
      const current = await getConnection(ctx.db);
      const currentTime = now(ctx).valueOf();
      if (!current || current.status !== "connected" ||
        current.generation !== expected.generation || current.version !== expected.version ||
        current.credentialVersion !== expected.credentialVersion || current.leaseOwner !== owner ||
        !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= currentTime) {
        throw new ExchangeConnectionError("exchange_connection_changed");
      }
    };
    await assertCurrent();
    return await operation({
      accessToken: result.value.accessToken,
      mailboxId: expected.mailboxId,
      assertCurrent,
      fetcher: ctx.fetcher,
      scope: { tenantId: expected.tenantId, mailboxId: expected.mailboxId },
      guard: { owner, generation: expected.generation },
      now: () => now(ctx),
    });
  } finally {
    try {
      if (newVersion && !committed && !commitUnknown) {
        await queueCredentialCleanup(ctx.db, newVersion, now(ctx));
      }
      // Cleanup is best effort after the caller's one bounded Graph action;
      // it must never cause that action to be retried.
      if (committed) await drainCredentialCleanup(ctx, owner);
      else if (newVersion && !commitUnknown) await drainCredentialCleanup(ctx, owner);
    } finally {
      await releaseConnectionLease(ctx.db, { owner });
    }
  }
}

export async function disconnectExchangeConnection(ctx: ExchangeServiceContext) {
  const owner = crypto.randomUUID();
  const connection = await acquireConnectionLease(ctx.db, { owner }, now(ctx));
  if (!connection) {
    if (!await getConnection(ctx.db)) return { ok: true, ...publicStatus(null), cleanupPending: false };
    throw new ExchangeConnectionError("exchange_connection_busy");
  }
  try {
    assertIdentity(ctx, connection);
    let updated: ExchangeConnection | null;
    try {
      updated = await disconnectConnection(ctx.db, {
        owner, generation: connection.generation, version: connection.version,
      }, now(ctx));
    } catch {
      const observed = await getConnection(ctx.db);
      updated = observed?.status === "disconnected" && observed.generation > connection.generation ? observed : null;
    }
    if (!updated) throw new ExchangeConnectionError("exchange_connection_changed");
    const cleanupPending = await drainCredentialCleanup(ctx, owner);
    return { ok: true, ...publicStatus(updated), cleanupPending };
  } finally {
    await releaseConnectionLease(ctx.db, { owner });
  }
}

function assertIdentity(ctx: ExchangeServiceContext, row: ExchangeConnection) {
  if (row.tenantId !== ctx.oauth.tenantId || row.mailboxId !== ctx.oauth.mailboxId || row.clientId !== ctx.oauth.clientId) {
    throw new ExchangeConnectionError("exchange_configuration_mismatch", 503);
  }
}

function publicStatus(row: ExchangeConnection | null) {
  return { configured: true, status: row?.status ?? "disconnected", updatedAt: row?.updatedAt ?? null, mailFlowEnabled: false as const };
}

async function writeImmutable(ctx: ExchangeServiceContext, purpose: string, payload: ExchangeVaultPayload) {
  try {
    return await writeExchangeCredential(ctx.bucket, ctx.vault, purpose, payload, { expectedEtag: null });
  } catch {
    // Read after an ambiguous write; never retry the provider or blindly overwrite R2.
    const stored = await readExchangeCredential(ctx.bucket, ctx.vault, purpose);
    if (stored?.payload && JSON.stringify(stored.payload) === JSON.stringify(payload)) return { etag: stored.etag };
    throw new ExchangeConnectionError("exchange_storage_unavailable", 503);
  }
}

async function cleanCredential(ctx: ExchangeServiceContext, purpose: string): Promise<boolean> {
  try {
    const stored = await readExchangeCredential(ctx.bucket, ctx.vault, purpose);
    if (!stored?.payload) return true;
    try {
      await tombstoneExchangeCredential(ctx.bucket, ctx.vault, purpose, { expectedEtag: stored.etag });
      return true;
    } catch {
      const observed = await readExchangeCredential(ctx.bucket, ctx.vault, purpose);
      return observed !== null && observed.payload === null;
    }
  } catch { return false; }
}

/** Bounded, explicit-action cleanup; failed jobs survive crashes and future reconnects. */
async function drainCredentialCleanup(ctx: ExchangeServiceContext, owner: string): Promise<boolean> {
  const current = await getConnection(ctx.db);
  if (current?.leaseOwner !== owner || !current.leaseExpiresAt || Date.parse(current.leaseExpiresAt) <= now(ctx).valueOf()) {
    return await countCredentialCleanup(ctx.db) > 0;
  }
  for (const job of await listCredentialCleanup(ctx.db, 20)) {
    if (await cleanCredential(ctx, tokenPurpose(job.credentialVersion))) {
      await completeCredentialCleanup(ctx.db, job.credentialVersion);
    }
  }
  return await countCredentialCleanup(ctx.db) > 0;
}

async function hash(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), b => b.toString(16).padStart(2, "0")).join("");
}

function invalid(): never { throw new ExchangeConnectionError("exchange_authorization_invalid", 400); }
