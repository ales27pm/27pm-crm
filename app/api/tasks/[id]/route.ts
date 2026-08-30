import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import {
  jsonError,
  optionalTrimmedString,
  readJsonObject,
  validIsoTimestamp,
} from "@/lib/http";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const { id } = await context.params;
  if (!/^[a-zA-Z0-9_-]{1,128}$/u.test(id)) {
    return jsonError(400, "task_id_invalid");
  }

  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const assignments: string[] = [];
  const values: unknown[] = [];
  const audit: Record<string, unknown> = {};

  if ("completed" in payload && "status" in payload) {
    return jsonError(400, "task_status_ambiguous");
  }

  if ("completed" in payload) {
    if (typeof payload.completed !== "boolean") {
      return jsonError(400, "task_completed_invalid");
    }
    assignments.push("status = ?", "completed_at = ?");
    values.push(
      payload.completed ? "done" : "open",
      payload.completed ? new Date().toISOString() : null,
    );
    audit.completed = payload.completed;
  } else if ("status" in payload) {
    if (
      typeof payload.status !== "string" ||
      !["open", "done", "cancelled"].includes(payload.status)
    ) {
      return jsonError(400, "task_status_invalid");
    }
    assignments.push("status = ?", "completed_at = ?");
    values.push(
      payload.status,
      payload.status === "done" ? new Date().toISOString() : null,
    );
    audit.status = payload.status;
  }

  if ("title" in payload) {
    const title = optionalTrimmedString(payload.title, 300);
    if (!title) return jsonError(400, "task_title_invalid");
    assignments.push("title = ?");
    values.push(title);
    audit.title = title;
  }
  if ("dueAt" in payload) {
    const dueAt = validIsoTimestamp(payload.dueAt);
    if (dueAt === undefined) return jsonError(400, "task_due_at_invalid");
    assignments.push("due_at = ?");
    values.push(dueAt);
    audit.dueAt = dueAt;
  }
  if (assignments.length === 0) return jsonError(400, "no_changes");

  try {
    const db = crmDatabase();
    const current = await db
      .prepare("SELECT status, contact_action AS contactAction FROM tasks WHERE id = ? LIMIT 1")
      .bind(id)
      .first<{ status: string; contactAction: number | boolean }>();
    if (!current) return jsonError(404, "task_not_found");
    const requestedStatus = "completed" in payload
      ? payload.completed ? "done" : "open"
      : typeof payload.status === "string" ? payload.status : null;
    if (Boolean(current.contactAction) && current.status === "cancelled" && requestedStatus && requestedStatus !== "cancelled") {
      return jsonError(409, "cancelled_contact_task_locked");
    }
    assignments.push("updated_at = CURRENT_TIMESTAMP");
    const updated = await db
      .prepare(`UPDATE tasks SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
    if (changedRows(updated) === 0) return jsonError(404, "task_not_found");

    await db
      .prepare(
        `INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'task.updated', 'task', ?, ?)`,
      )
      .bind(crypto.randomUUID(), auth.operator.email, id, JSON.stringify(audit))
      .run();
    const task = await db
      .prepare(
        `SELECT id, title, status, due_at AS dueAt,
                completed_at AS completedAt,
                deal_id AS dealId, conversation_id AS conversationId
         FROM tasks WHERE id = ?`,
      )
      .bind(id)
      .first<{
        id: string;
        title: string;
        status: string;
        dueAt: string | null;
        completedAt: string | null;
        dealId: string | null;
        conversationId: string | null;
      }>();
    return Response.json(
      { task: task ? { ...task, completed: task.status === "done" } : null },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return jsonError(500, "task_update_failed");
  }
}
