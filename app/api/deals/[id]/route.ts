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
    return jsonError(400, "deal_id_invalid");
  }

  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const assignments: string[] = [];
  const values: unknown[] = [];
  const audit: Record<string, unknown> = {};

  if ("stage" in payload) {
    const stage = databaseStage(payload.stage);
    if (!stage) {
      return jsonError(400, "deal_stage_invalid");
    }
    assignments.push("stage = ?");
    values.push(stage);
    audit.stage = stage;
  }

  for (const [payloadKey, column, maxLength] of [
    ["projectType", "project_type", 120],
    ["nextAction", "next_action", 500],
    ["note", "note", 10_000],
  ] as const) {
    if (!(payloadKey in payload)) continue;
    const value = optionalTrimmedString(payload[payloadKey], maxLength);
    if (value === undefined) return jsonError(400, `${payloadKey}_invalid`);
    assignments.push(`${column} = ?`);
    values.push(value);
    audit[payloadKey] = payloadKey === "note" ? { changed: true } : value;
  }

  if ("nextActionAt" in payload) {
    const nextActionAt = validIsoTimestamp(payload.nextActionAt);
    if (nextActionAt === undefined) return jsonError(400, "next_action_at_invalid");
    assignments.push("next_action_at = ?");
    values.push(nextActionAt);
    audit.nextActionAt = nextActionAt;
  }
  if (assignments.length === 0) return jsonError(400, "no_changes");

  try {
    const db = crmDatabase();
    assignments.push("updated_at = CURRENT_TIMESTAMP");
    const updated = await db
      .prepare(`UPDATE deals SET ${assignments.join(", ")} WHERE id = ?`)
      .bind(...values, id)
      .run();
    if (changedRows(updated) === 0) return jsonError(404, "deal_not_found");

    await db
      .prepare(
        `INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'deal.updated', 'deal', ?, ?)`,
      )
      .bind(crypto.randomUUID(), auth.operator.email, id, JSON.stringify(audit))
      .run();
    const deal = await db
      .prepare(
        `SELECT id, conversation_id AS conversationId, stage,
                project_type AS projectType, next_action AS nextAction,
                next_action_at AS nextActionAt, note,
                updated_at AS updatedAt
         FROM deals WHERE id = ?`,
      )
      .bind(id)
      .first();
    return Response.json({ deal });
  } catch {
    return jsonError(500, "deal_update_failed");
  }
}

function databaseStage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const stages: Record<string, string> = {
    new: "new",
    nouveau: "new",
    qualified: "qualified",
    qualifie: "qualified",
    discovery: "discovery",
    proposal: "proposal",
    proposition: "proposal",
    production: "discovery",
    won: "won",
    gagne: "won",
    lost: "lost",
    archived: "archived",
  };
  return stages[value] ?? null;
}
