import { requireOperatorRequest } from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import { jsonError, optionalTrimmedString, readJsonObject, validIsoTimestamp } from "@/lib/http";

const REQUEST_TYPES = ["access", "rectification", "withdrawal", "destruction", "structured_export"] as const;

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  try {
    const rows = await crmDatabase().prepare(`SELECT id, contact_id AS contactId, request_type AS requestType,
      status, requester_reference AS requesterReference, requested_at AS requestedAt,
      due_at AS dueAt, handled_by AS handledBy, resolution_note AS resolutionNote,
      completed_at AS completedAt FROM privacy_requests ORDER BY requested_at DESC LIMIT 200`).all();
    return Response.json({ requests: rows.results }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return jsonError(500, "privacy_requests_unavailable");
  }
}

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const contactId = payload.contactId == null || payload.contactId === "" ? null : typeof payload.contactId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(payload.contactId) ? payload.contactId : undefined;
  const requestType = typeof payload.requestType === "string" && REQUEST_TYPES.includes(payload.requestType as (typeof REQUEST_TYPES)[number]) ? payload.requestType : null;
  const requesterReference = optionalTrimmedString(payload.requesterReference, 2_000);
  const requestedAt = payload.requestedAt == null || payload.requestedAt === "" ? new Date().toISOString() : validIsoTimestamp(payload.requestedAt);
  const dueAt = payload.dueAt == null || payload.dueAt === "" ? null : validIsoTimestamp(payload.dueAt);
  if (contactId === undefined || !requestType || !requesterReference || requestedAt === undefined || dueAt === undefined) return jsonError(400, "privacy_request_invalid");
  try {
    const db = crmDatabase();
    if (contactId && !await db.prepare("SELECT 1 AS present FROM contacts WHERE id=? LIMIT 1").bind(contactId).first()) return jsonError(404, "contact_not_found");
    const id = crypto.randomUUID();
    await db.batch([
      db.prepare(`INSERT INTO privacy_requests (id, contact_id, request_type, status, requester_reference, requested_at, due_at)
        VALUES (?, ?, ?, 'received', ?, ?, ?)`).bind(id, contactId, requestType, requesterReference, requestedAt, dueAt),
      db.prepare(`INSERT INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json)
        VALUES (?, ?, 'privacy_request.created', 'privacy_request', ?, ?)`).bind(crypto.randomUUID(), auth.operator.email, id, JSON.stringify({ contactId, requestType })),
    ]);
    return Response.json({ request: { id, contactId, requestType, status: "received", requesterReference, requestedAt, dueAt } }, { status: 201 });
  } catch {
    return jsonError(500, "privacy_request_create_failed");
  }
}
