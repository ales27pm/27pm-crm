import { changedRows, crmDatabase } from "@/lib/d1";
import {
  MAILGUN_HANDOFF_ID,
  MAILGUN_HANDOFF_KEY_FINGERPRINT,
  verifyMailgunHandoffConsumerToken,
} from "@/lib/mailgun-handoff";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const token = bearerToken(request.headers.get("authorization"));
  if (!(await verifyMailgunHandoffConsumerToken(token))) {
    return consumeError(401, "handoff_consumer_unauthorized");
  }

  const db = crmDatabase();
  try {
    const result = await db
      .prepare(
        `UPDATE credential_handoffs
         SET ciphertext = '', consumed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND key_fingerprint = ? AND consumed_at IS NULL`,
      )
      .bind(MAILGUN_HANDOFF_ID, MAILGUN_HANDOFF_KEY_FINGERPRINT)
      .run();
    if (changedRows(result) === 0) {
      return consumeError(409, "handoff_not_available");
    }

    await db
      .prepare(
        `INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, 'credential-handoff-consumer@internal.27pm',
                 'integration.mailgun.handoff_consumed',
                 'credential_handoff', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        MAILGUN_HANDOFF_ID,
        JSON.stringify({ keyFingerprint: MAILGUN_HANDOFF_KEY_FINGERPRINT }),
      )
      .run();

    return Response.json(
      { consumed: true },
      { headers: noStoreHeaders() },
    );
  } catch {
    return consumeError(500, "handoff_consume_failed");
  }
}

function bearerToken(value: string | null): string | null {
  if (!value?.startsWith("Bearer ")) return null;
  const token = value.slice("Bearer ".length).trim();
  return token || null;
}

function consumeError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}
