import type { InternalApiAssertionClaims } from "./internal-api-auth";

type D1RunResult = {
  success: boolean;
  meta?: { changes?: number };
};

type D1PreparedStatement = {
  bind(...values: unknown[]): D1PreparedStatement;
  run(): Promise<D1RunResult>;
};

export type InternalApiNonceDatabase = {
  prepare(query: string): D1PreparedStatement;
};

/**
 * Atomically records a verified assertion nonce. A false result means the
 * assertion was already consumed or the database did not confirm the write.
 */
export async function consumeInternalApiNonce(
  database: InternalApiNonceDatabase,
  claims: Pick<InternalApiAssertionClaims, "nonce" | "expiresAt">,
): Promise<boolean> {
  const expiresAt = new Date(claims.expiresAt * 1000);
  if (
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.expiresAt < 0 ||
    Number.isNaN(expiresAt.valueOf())
  ) return false;

  const result = await database
    .prepare(
      `INSERT INTO internal_api_nonces (nonce, expires_at)
       VALUES (?, ?)
       ON CONFLICT(nonce) DO NOTHING`,
    )
    .bind(claims.nonce, expiresAt.toISOString())
    .run();

  return result.success && result.meta?.changes === 1;
}

export async function pruneExpiredInternalApiNonces(
  database: InternalApiNonceDatabase,
  now = new Date(),
): Promise<void> {
  if (Number.isNaN(now.valueOf())) return;
  await database
    .prepare("DELETE FROM internal_api_nonces WHERE expires_at <= ?")
    .bind(now.toISOString())
    .run();
}
