import { requireOperatorRequest } from "@/lib/api-auth";
import { entityId } from "@/lib/crm-accounts";
import { changedRows, crmDatabase } from "@/lib/d1";
import { jsonError, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const id = entityId((await context.params).id);
  const payload = await readJsonObject(request);
  const status = payload?.status;
  if (!id || (status !== "accepted" && status !== "rejected")) return jsonError(400, "intake_review_invalid");
  try {
    const db = crmDatabase();
    const result = await db.prepare(`UPDATE intake_submissions SET status=?, reviewed_by=?, reviewed_at=CURRENT_TIMESTAMP WHERE id=? AND status='pending'`).bind(status, auth.operator.email, id).run();
    if (changedRows(result) === 0) return jsonError(404, "intake_pending_not_found");
    await db.prepare(`INSERT INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json) VALUES (?, ?, 'intake.reviewed', 'intake', ?, ?)`).bind(crypto.randomUUID(), auth.operator.email, id, JSON.stringify({ status })).run();
    return Response.json({ reviewed: true, status }, { headers: { "cache-control": "private, no-store" } });
  } catch { return jsonError(500, "intake_review_failed"); }
}
