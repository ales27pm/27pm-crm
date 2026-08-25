import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import { jsonError, readJsonObject, validIsoTimestamp } from "@/lib/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) {
    return jsonError(400, "conversation_id_invalid");
  }

  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const assignments: string[] = [];
  const values: unknown[] = [];
  const audit: Record<string, unknown> = {};

  const unreadValue = "isUnread" in payload ? payload.isUnread : payload.unread;
  if ("isUnread" in payload || "unread" in payload) {
    if (typeof unreadValue !== "boolean") {
      return jsonError(400, "is_unread_invalid");
    }
    assignments.push("is_unread = ?");
    values.push(unreadValue ? 1 : 0);
    audit.isUnread = unreadValue;
  }
  if ("followUpState" in payload) {
    if (
      typeof payload.followUpState !== "string" ||
      !["none", "pending", "waiting", "done"].includes(payload.followUpState)
    ) {
      return jsonError(400, "follow_up_state_invalid");
    }
    assignments.push("follow_up_state = ?");
    values.push(payload.followUpState);
    audit.followUpState = payload.followUpState;
  }
  if ("followUpAt" in payload) {
    const followUpAt = validIsoTimestamp(payload.followUpAt);
    if (followUpAt === undefined) return jsonError(400, "follow_up_at_invalid");
    assignments.push("follow_up_at = ?");
    values.push(followUpAt);
    audit.followUpAt = followUpAt;
  }
  if (assignments.length === 0) return jsonError(400, "no_changes");

  try {
    const db = crmDatabase();
    assignments.push("updated_at = CURRENT_TIMESTAMP");
    const updated = await db
      .prepare(`UPDATE conversations SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
    if (changedRows(updated) === 0) return jsonError(404, "conversation_not_found");

    await db
      .prepare(
        `INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'conversation.updated', 'conversation', ?, ?)`,
      )
      .bind(crypto.randomUUID(), auth.operator.email, id, JSON.stringify(audit))
      .run();
    const conversation = await db
      .prepare(
        `SELECT id, is_unread AS isUnread, follow_up_state AS followUpState,
                follow_up_at AS followUpAt, updated_at AS updatedAt
         FROM conversations WHERE id = ?`,
      )
      .bind(id)
      .first();
    return Response.json({ conversation });
  } catch {
    return jsonError(500, "conversation_update_failed");
  }
}
