import { requireSameOriginOperatorJsonRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import {
  privateJsonError,
  privateNoStoreHeaders,
} from "@/lib/http";
import {
  MAILGUN_HANDOFF_EXPIRES_AT,
  MAILGUN_HANDOFF_ID,
  MAILGUN_HANDOFF_KEY_FINGERPRINT,
  MAILGUN_HANDOFF_PURPOSE,
  validateMailgunHandoffPayload,
} from "@/lib/mailgun-handoff";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireSameOriginOperatorJsonRequest(
    request,
    "handoff_payload_invalid",
  );
  if (auth.response) return auth.response;
  const { payload } = auth;

  const validation = validateMailgunHandoffPayload(payload);
  if (!validation.ok) {
    return privateJsonError(
      validation.reason === "expired" ? 410 : 400,
      `handoff_${validation.reason}`,
    );
  }

  const db = crmDatabase();
  try {
    const result = await db
      .prepare(
        `INSERT INTO credential_handoffs
          (id, purpose, key_fingerprint, ciphertext, submitted_by, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           key_fingerprint = excluded.key_fingerprint,
           ciphertext = excluded.ciphertext,
           submitted_by = excluded.submitted_by,
           expires_at = excluded.expires_at,
           updated_at = CURRENT_TIMESTAMP
         WHERE credential_handoffs.consumed_at IS NULL`,
      )
      .bind(
        MAILGUN_HANDOFF_ID,
        MAILGUN_HANDOFF_PURPOSE,
        MAILGUN_HANDOFF_KEY_FINGERPRINT,
        validation.ciphertext,
        auth.operator.email,
        MAILGUN_HANDOFF_EXPIRES_AT,
      )
      .run();

    if (changedRows(result) === 0) {
      return privateJsonError(409, "handoff_already_consumed");
    }

    await db
      .prepare(
        `INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'integration.mailgun.handoff_submitted',
                 'credential_handoff', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        auth.operator.email,
        MAILGUN_HANDOFF_ID,
        JSON.stringify({ keyFingerprint: MAILGUN_HANDOFF_KEY_FINGERPRINT }),
      )
      .run();

    return Response.json(
      { accepted: true, expiresAt: MAILGUN_HANDOFF_EXPIRES_AT },
      { status: 202, headers: privateNoStoreHeaders() },
    );
  } catch {
    return privateJsonError(500, "handoff_persistence_failed");
  }
}
