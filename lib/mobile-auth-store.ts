import type { Operator } from "./auth";
import { parseOperatorAllowlist } from "./auth";
import type { CrmDatabase } from "./d1";
import { normalizeEmailAddress } from "./mailboxes";
import {
  generateMobileAuthorizationCode,
  generateMobileRefreshToken,
  hashMobileCredential,
  MOBILE_AUTHORIZATION_CODE_TTL_SECONDS,
  MOBILE_CLIENT_ID,
  MOBILE_SCOPE_VALUE,
  MOBILE_SESSION_TTL_SECONDS,
  mobilePkceChallenge,
  parseMobileRefreshToken,
  validMobileAuthorizationCode,
  type MobileAccessClaims,
  type MobileAuthorizationRequest,
} from "./mobile-auth";

type AuthorizationGrantRow = {
  id: string;
  operatorEmail: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scopes: string;
  deviceName: string | null;
  expiresAt: string;
  consumedAt: string | null;
};

type MobileSessionRow = {
  id: string;
  authorizationGrantId: string;
  operatorEmail: string;
  clientId: string;
  deviceName: string | null;
  scopes: string;
  refreshTokenHash: string;
  expiresAt: string;
  revokedAt: string | null;
};

type MobileRefreshTokenRow = {
  tokenHash: string;
  sessionId: string;
  rotatedAt: string | null;
};

const MOBILE_SESSION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type IssuedMobileSession = {
  sessionId: string;
  operator: Operator;
  scopes: string;
  refreshToken: string;
  sessionExpiresAt: string;
};

export type MobileSessionSummary = {
  id: string;
  deviceName: string | null;
  createdAt: string;
  lastRefreshedAt: string;
  expiresAt: string;
};

export async function listActiveMobileSessions(
  db: CrmDatabase,
  operatorEmail: string,
  now = new Date(),
): Promise<MobileSessionSummary[]> {
  const email = normalizeEmailAddress(operatorEmail);
  if (!email) return [];
  const result = await db
    .prepare(
      `SELECT id, device_name AS deviceName, created_at AS createdAt,
              last_refreshed_at AS lastRefreshedAt, expires_at AS expiresAt
       FROM mobile_sessions
       WHERE operator_email = ? AND revoked_at IS NULL AND expires_at > ?
       ORDER BY last_refreshed_at DESC, created_at DESC`,
    )
    .bind(email, now.toISOString())
    .all<MobileSessionSummary>();
  return result.results;
}

export async function revokeMobileSessionByOperator(
  db: CrmDatabase,
  input: { sessionId: unknown; operator: Operator },
  now = new Date(),
): Promise<boolean> {
  const operatorEmail = normalizeEmailAddress(input.operator.email);
  if (
    !operatorEmail ||
    typeof input.sessionId !== "string" ||
    !MOBILE_SESSION_ID.test(input.sessionId)
  ) return false;
  const revokedAt = now.toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE mobile_sessions
       SET revoked_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND operator_email = ? AND revoked_at IS NULL`,
    )
      .bind(revokedAt, input.sessionId, operatorEmail),
    db.prepare(
      `INSERT INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
       SELECT ?, ?, 'mobile.session_revoked_by_operator',
              'mobile_session', ?, ?
       FROM mobile_sessions
       WHERE id = ? AND operator_email = ? AND revoked_at = ?`,
    ).bind(
      crypto.randomUUID(),
      operatorEmail,
      input.sessionId,
      JSON.stringify({ revokedAt }),
      input.sessionId,
      operatorEmail,
      revokedAt,
    ),
  ]);
  return results.every((result) => changedRows(result) === 1);
}

export async function createMobileAuthorizationGrant(
  db: CrmDatabase,
  input: {
    operator: Operator;
    request: MobileAuthorizationRequest;
  },
  now = new Date(),
): Promise<{ code: string; expiresAt: string }> {
  const code = generateMobileAuthorizationCode();
  const codeHash = await hashMobileCredential(code);
  const grantId = crypto.randomUUID();
  const expiresAt = new Date(
    now.valueOf() + MOBILE_AUTHORIZATION_CODE_TTL_SECONDS * 1000,
  ).toISOString();
  await db.batch([
    db.prepare(
      `INSERT INTO mobile_authorization_grants
        (id, code_hash, operator_email, client_id, redirect_uri,
         code_challenge, scopes, device_name, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      grantId,
      codeHash,
      input.operator.email,
      input.request.clientId,
      input.request.redirectUri,
      input.request.codeChallenge,
      MOBILE_SCOPE_VALUE,
      input.request.deviceName,
      expiresAt,
    ),
    db.prepare(
      `INSERT INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
       VALUES (?, ?, 'mobile.authorization_grant_created',
               'mobile_authorization_grant', ?, ?)`,
    ).bind(
      crypto.randomUUID(),
      input.operator.email,
      grantId,
      JSON.stringify({
        clientId: input.request.clientId,
        redirectUri: input.request.redirectUri,
        scopes: MOBILE_SCOPE_VALUE,
        deviceName: input.request.deviceName,
        expiresAt,
      }),
    ),
  ]);
  return { code, expiresAt };
}

export async function exchangeMobileAuthorizationCode(
  db: CrmDatabase,
  input: {
    code: unknown;
    codeVerifier: unknown;
    clientId: unknown;
    redirectUri: unknown;
    operatorAllowlist: string | null | undefined;
  },
  now = new Date(),
): Promise<IssuedMobileSession | null> {
  if (
    !validMobileAuthorizationCode(input.code) ||
    typeof input.codeVerifier !== "string" ||
    input.clientId !== MOBILE_CLIENT_ID ||
    typeof input.redirectUri !== "string"
  ) return null;
  const challenge = await mobilePkceChallenge(input.codeVerifier);
  if (!challenge) return null;
  const codeHash = await hashMobileCredential(input.code);
  const grant = await db
    .prepare(
      `SELECT id, operator_email AS operatorEmail, client_id AS clientId,
              redirect_uri AS redirectUri, code_challenge AS codeChallenge,
              scopes, device_name AS deviceName, expires_at AS expiresAt,
              consumed_at AS consumedAt
       FROM mobile_authorization_grants
       WHERE code_hash = ? LIMIT 1`,
    )
    .bind(codeHash)
    .first<AuthorizationGrantRow>();
  const nowIso = now.toISOString();
  const operatorEmail = grant?.operatorEmail.toLowerCase();
  if (
    !grant ||
    grant.consumedAt ||
    grant.expiresAt <= nowIso ||
    grant.clientId !== input.clientId ||
    grant.redirectUri !== input.redirectUri ||
    grant.codeChallenge !== challenge ||
    grant.scopes !== MOBILE_SCOPE_VALUE ||
    !operatorEmail ||
    !parseOperatorAllowlist(input.operatorAllowlist).has(operatorEmail)
  ) return null;

  const sessionId = crypto.randomUUID();
  const refreshToken = generateMobileRefreshToken(sessionId);
  const refreshTokenHash = await hashMobileCredential(refreshToken);
  const sessionExpiresAt = new Date(
    now.valueOf() + MOBILE_SESSION_TTL_SECONDS * 1000,
  ).toISOString();
  const results = await db.batch([
    db.prepare(
      `UPDATE mobile_authorization_grants
       SET consumed_at = ?, consumed_session_id = ?
       WHERE id = ? AND code_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
    )
      .bind(nowIso, sessionId, grant.id, codeHash, nowIso),
    db.prepare(
      `INSERT INTO mobile_sessions
        (id, authorization_grant_id, operator_email, client_id, device_name,
         scopes, refresh_token_hash, expires_at, last_refreshed_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
       FROM mobile_authorization_grants
       WHERE id = ? AND code_hash = ? AND consumed_at = ?
         AND consumed_session_id = ?`,
    ).bind(
      sessionId,
      grant.id,
      operatorEmail,
      grant.clientId,
      grant.deviceName,
      grant.scopes,
      refreshTokenHash,
      sessionExpiresAt,
      nowIso,
      grant.id,
      codeHash,
      nowIso,
      sessionId,
    ),
    db.prepare(
      `INSERT INTO mobile_refresh_tokens
        (token_hash, session_id, issued_at)
       SELECT ?, ?, ?
       FROM mobile_sessions
       WHERE id = ? AND refresh_token_hash = ?`,
    ).bind(
      refreshTokenHash,
      sessionId,
      nowIso,
      sessionId,
      refreshTokenHash,
    ),
    db.prepare(
      `INSERT INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
       SELECT ?, ?, 'mobile.session_created', 'mobile_session', ?, ?
       FROM mobile_sessions
       WHERE id = ? AND authorization_grant_id = ?`,
    ).bind(
      crypto.randomUUID(),
      operatorEmail,
      sessionId,
      JSON.stringify({
        authorizationGrantId: grant.id,
        clientId: grant.clientId,
        deviceName: grant.deviceName,
        scopes: grant.scopes,
        expiresAt: sessionExpiresAt,
      }),
      sessionId,
      grant.id,
    ),
  ]);
  if (results.some((result) => changedRows(result) !== 1)) return null;
  return {
    sessionId,
    operator: { email: operatorEmail },
    scopes: grant.scopes,
    refreshToken,
    sessionExpiresAt,
  };
}

export async function rotateMobileRefreshToken(
  db: CrmDatabase,
  input: {
    refreshToken: unknown;
    clientId: unknown;
    operatorAllowlist: string | null | undefined;
  },
  now = new Date(),
): Promise<IssuedMobileSession | null> {
  const parsed = parseMobileRefreshToken(input.refreshToken);
  if (!parsed || input.clientId !== MOBILE_CLIENT_ID) return null;
  const currentHash = await hashMobileCredential(parsed.token);
  const session = await mobileSession(db, parsed.sessionId);
  const refreshTokenRecord = await mobileRefreshToken(
    db,
    parsed.sessionId,
    currentHash,
  );
  const nowIso = now.toISOString();
  const operatorEmail = session?.operatorEmail.toLowerCase();
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= nowIso ||
    session.clientId !== input.clientId ||
    session.scopes !== MOBILE_SCOPE_VALUE ||
    !refreshTokenRecord ||
    !operatorEmail ||
    !parseOperatorAllowlist(input.operatorAllowlist).has(operatorEmail)
  ) return null;
  const refreshToken = generateMobileRefreshToken(session.id);
  const refreshTokenHash = await hashMobileCredential(refreshToken);
  const results = await db.batch([
    db.prepare(
      `INSERT INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
       SELECT ?, ?, 'mobile.refresh_token_reuse_detected',
              'mobile_session', ?, ?
       FROM mobile_sessions
       WHERE id = ? AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM mobile_refresh_tokens
           WHERE session_id = ? AND token_hash = ?
         )
         AND (
           refresh_token_hash <> ?
           OR EXISTS (
             SELECT 1 FROM mobile_refresh_tokens
             WHERE session_id = ? AND token_hash = ? AND rotated_at IS NOT NULL
           )
         )`,
    ).bind(
      crypto.randomUUID(),
      operatorEmail,
      session.id,
      JSON.stringify({ revokedAt: nowIso }),
      session.id,
      session.id,
      currentHash,
      currentHash,
      session.id,
      currentHash,
    ),
    db.prepare(
      `UPDATE mobile_sessions
       SET revoked_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM mobile_refresh_tokens
           WHERE session_id = ? AND token_hash = ?
         )
         AND (
           refresh_token_hash <> ?
           OR EXISTS (
             SELECT 1 FROM mobile_refresh_tokens
             WHERE session_id = ? AND token_hash = ? AND rotated_at IS NOT NULL
           )
         )`,
    ).bind(
      nowIso,
      session.id,
      session.id,
      currentHash,
      currentHash,
      session.id,
      currentHash,
    ),
    db.prepare(
      `UPDATE mobile_sessions
       SET refresh_token_hash = ?, last_refreshed_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL
         AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM mobile_refresh_tokens
           WHERE session_id = ? AND token_hash = ? AND rotated_at IS NULL
         )`,
    )
      .bind(
        refreshTokenHash,
        nowIso,
        session.id,
        currentHash,
        nowIso,
        session.id,
        currentHash,
      ),
    db.prepare(
      `UPDATE mobile_refresh_tokens
       SET rotated_at = ?
       WHERE token_hash = ? AND session_id = ? AND rotated_at IS NULL
         AND EXISTS (
           SELECT 1 FROM mobile_sessions
           WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL
         )`,
    ).bind(nowIso, currentHash, session.id, session.id, refreshTokenHash),
    db.prepare(
      `INSERT INTO mobile_refresh_tokens
        (token_hash, session_id, issued_at)
       SELECT ?, ?, ?
       FROM mobile_sessions
       WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
    ).bind(refreshTokenHash, session.id, nowIso, session.id, refreshTokenHash),
    db.prepare(
      `INSERT INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
       SELECT ?, ?, 'mobile.refresh_token_rotated', 'mobile_session', ?, ?
       FROM mobile_sessions
       WHERE id = ? AND refresh_token_hash = ? AND revoked_at IS NULL`,
    ).bind(
      crypto.randomUUID(),
      operatorEmail,
      session.id,
      JSON.stringify({ rotatedAt: nowIso }),
      session.id,
      refreshTokenHash,
    ),
  ]);
  const changes = results.map(changedRows);
  const rotatedSuccessfully =
    changes[0] === 0 &&
    changes[1] === 0 &&
    changes.slice(2).every((change) => change === 1);
  if (!rotatedSuccessfully) {
    return null;
  }
  return {
    sessionId: session.id,
    operator: { email: operatorEmail },
    scopes: session.scopes,
    refreshToken,
    sessionExpiresAt: session.expiresAt,
  };
}

export async function activeMobileSession(
  db: CrmDatabase,
  claims: MobileAccessClaims,
  operatorAllowlist: string | null | undefined,
  now = new Date(),
): Promise<Operator | null> {
  const session = await mobileSession(db, claims.sessionId);
  const email = claims.subject.toLowerCase();
  if (
    !session ||
    session.revokedAt ||
    session.expiresAt <= now.toISOString() ||
    session.operatorEmail.toLowerCase() !== email ||
    session.clientId !== MOBILE_CLIENT_ID ||
    session.scopes !== claims.scopes ||
    !parseOperatorAllowlist(operatorAllowlist).has(email)
  ) return null;
  return { email, mobileSessionId: claims.sessionId };
}

export async function revokeMobileSession(
  db: CrmDatabase,
  input: { refreshToken: unknown },
  now = new Date(),
): Promise<void> {
  const parsed = parseMobileRefreshToken(input.refreshToken);
  if (!parsed) return;
  const hash = await hashMobileCredential(parsed.token);
  const session = await mobileSession(db, parsed.sessionId);
  if (!session || session.revokedAt) return;
  await revokeKnownMobileSession(db, {
    session,
    tokenHash: hash,
    revokedAt: now.toISOString(),
  });
}

async function revokeKnownMobileSession(
  db: CrmDatabase,
  input: {
    session: MobileSessionRow;
    tokenHash: string;
    revokedAt: string;
  },
): Promise<boolean> {
  const results = await db.batch([
    db.prepare(
      `INSERT INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
       SELECT ?, ?, 'mobile.session_revoked', 'mobile_session', ?, ?
       FROM mobile_sessions
       WHERE id = ? AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM mobile_refresh_tokens
           WHERE session_id = ? AND token_hash = ?
         )`,
    ).bind(
      crypto.randomUUID(),
      input.session.operatorEmail,
      input.session.id,
      JSON.stringify({
        clientId: input.session.clientId,
        revokedAt: input.revokedAt,
      }),
      input.session.id,
      input.session.id,
      input.tokenHash,
    ),
    db.prepare(
      `UPDATE mobile_sessions
       SET revoked_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM mobile_refresh_tokens
           WHERE session_id = ? AND token_hash = ?
         )`,
    )
      .bind(
        input.revokedAt,
        input.session.id,
        input.session.id,
        input.tokenHash,
      ),
  ]);
  return results.every((result) => changedRows(result) === 1);
}

async function mobileSession(
  db: CrmDatabase,
  sessionId: string,
): Promise<MobileSessionRow | null> {
  return db
    .prepare(
      `SELECT id, authorization_grant_id AS authorizationGrantId,
              operator_email AS operatorEmail, client_id AS clientId,
              device_name AS deviceName, scopes,
              refresh_token_hash AS refreshTokenHash,
              expires_at AS expiresAt, revoked_at AS revokedAt
       FROM mobile_sessions WHERE id = ? LIMIT 1`,
    )
    .bind(sessionId)
    .first<MobileSessionRow>();
}

async function mobileRefreshToken(
  db: CrmDatabase,
  sessionId: string,
  tokenHash: string,
): Promise<MobileRefreshTokenRow | null> {
  return db
    .prepare(
      `SELECT token_hash AS tokenHash, session_id AS sessionId,
              rotated_at AS rotatedAt
       FROM mobile_refresh_tokens
       WHERE session_id = ? AND token_hash = ? LIMIT 1`,
    )
    .bind(sessionId, tokenHash)
    .first<MobileRefreshTokenRow>();
}

function changedRows(result: { meta?: { changes?: number } }): number {
  return result.meta?.changes ?? 0;
}
