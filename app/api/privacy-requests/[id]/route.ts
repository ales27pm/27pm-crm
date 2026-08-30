import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import { jsonError, optionalTrimmedString, readJsonObject } from "@/lib/http";

const STATUSES = ["received", "identity_pending", "in_progress", "completed", "refused"] as const;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(id)) return jsonError(400, "privacy_request_id_invalid");
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const status = typeof payload.status === "string" && STATUSES.includes(payload.status as (typeof STATUSES)[number]) ? payload.status : null;
  const resolutionNote = optionalTrimmedString(payload.resolutionNote, 10_000);
  if (!status || resolutionNote === undefined || (["completed", "refused"].includes(status) && !resolutionNote)) return jsonError(400, "privacy_request_update_invalid");
  try {
    const db = crmDatabase();
    const result = await db.prepare(`UPDATE privacy_requests SET status=?, resolution_note=?, handled_by=?,
      completed_at=CASE WHEN ? IN ('completed','refused') THEN CURRENT_TIMESTAMP ELSE NULL END,
      updated_at=CURRENT_TIMESTAMP WHERE id=? AND status NOT IN ('completed','refused')`)
      .bind(status, resolutionNote ?? "", auth.operator.email, status, id).run();
    if (changedRows(result) !== 1) return jsonError(409, "privacy_request_not_open");
    await db.prepare(`INSERT INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json)
      VALUES (?, ?, 'privacy_request.updated', 'privacy_request', ?, ?)`)
      .bind(crypto.randomUUID(), auth.operator.email, id, JSON.stringify({ status })).run();
    return Response.json({ updated: true });
  } catch {
    return jsonError(500, "privacy_request_update_failed");
  }
}
