import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import {
  MAILGUN_HANDOFF_EXPIRES_AT,
  MAILGUN_HANDOFF_ID,
  MAILGUN_HANDOFF_KEY_FINGERPRINT,
  MAILGUN_HANDOFF_PURPOSE,
  validateMailgunHandoffPayload,
} from "@/lib/mailgun-handoff";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  if (!isSameOriginBrowserRequest(request)) {
    return handoffError(403, "cross_origin_request_forbidden");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return handoffError(400, "handoff_payload_invalid");
  }

  const validation = validateMailgunHandoffPayload(payload);
  if (!validation.ok) {
    return handoffError(
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
      return handoffError(409, "handoff_already_consumed");
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
      { status: 202, headers: noStoreHeaders() },
    );
  } catch {
    return handoffError(500, "handoff_persistence_failed");
  }
}

function isSameOriginBrowserRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function handoffError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}
