import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import { jsonError, readJsonObject, validIsoTimestamp } from "@/lib/http";
import { evaluateOutreachChannel } from "@/lib/outreach-readiness";
import { uniqueOperationTimestamp } from "@/lib/operation-stamp";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ strategyId: string; stepId: string }> };

const STATUSES = ["planned", "ready", "blocked", "done", "skipped"] as const;

type CurrentStep = {
  id: string;
  strategyId: string;
  actionType: string;
  requiresContact: number | boolean;
  status: string;
  scheduledAt: string;
  contactId: string | null;
  strategyStatus: string;
};

export async function PATCH(request: Request, context: RouteContext) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const { strategyId, stepId } = await context.params;
  if (!validId(strategyId) || !validId(stepId)) return jsonError(400, "outreach_step_id_invalid");
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const status = payload.status === undefined
    ? null
    : typeof payload.status === "string" && STATUSES.includes(payload.status as (typeof STATUSES)[number])
      ? payload.status as (typeof STATUSES)[number]
      : undefined;
  const scheduledAt = payload.scheduledAt === undefined ? null : validIsoTimestamp(payload.scheduledAt);
  if (status === undefined) return jsonError(400, "outreach_step_status_invalid");
  if (scheduledAt === undefined) return jsonError(400, "outreach_step_schedule_invalid");
  if (status === null && scheduledAt === null) return jsonError(400, "no_changes");

  try {
    const db = crmDatabase();
    const current = await db.prepare(`SELECT step.id, step.strategy_id AS strategyId,
        step.action_type AS actionType, step.requires_contact AS requiresContact,
        step.status, step.scheduled_at AS scheduledAt, strategy.contact_id AS contactId,
        strategy.status AS strategyStatus
      FROM outreach_steps step
      JOIN outreach_strategies strategy ON strategy.id=step.strategy_id
      WHERE step.id=? AND step.strategy_id=? LIMIT 1`)
      .bind(stepId, strategyId)
      .first<CurrentStep>();
    if (!current) return jsonError(404, "outreach_step_not_found");
    if (["paused", "completed", "archived"].includes(current.strategyStatus)) {
      return jsonError(409, "outreach_strategy_frozen");
    }
    if (["done", "skipped"].includes(current.status)) {
      return jsonError(409, "outreach_step_terminal_locked");
    }

    const proposedStatus = status ?? current.status;
    const proposedSchedule = scheduledAt ?? current.scheduledAt;
    const channel = current.actionType === "email"
      ? "email"
      : current.actionType === "call"
        ? "phone"
        : null;
    const requiresReadiness = Boolean(current.requiresContact) &&
      ["planned", "ready", "done"].includes(proposedStatus);
    const readiness = channel && requiresReadiness
      ? await evaluateOutreachChannel(
          db,
          current.contactId,
          channel,
          proposedStatus === "done" ? new Date() : new Date(proposedSchedule),
        )
      : null;
    if (readiness && !readiness.allowed) {
      return jsonError(409, readiness.reasons[0] ?? "outreach_step_blocked", readiness.reasons.join(","));
    }

    const assignments: string[] = [];
    const values: unknown[] = [];
    if (status !== null) {
      assignments.push("status=?", "completed_at=?");
      values.push(status, status === "done" ? new Date().toISOString() : null);
    }
    if (scheduledAt !== null) {
      assignments.push("scheduled_at=?");
      values.push(scheduledAt);
    }
    const operationStamp = uniqueOperationTimestamp();
    assignments.push("updated_at=?");
    values.push(operationStamp);

    const stepWrite = readiness?.allowed
      ? db.prepare(`UPDATE outreach_steps SET ${assignments.join(", ")}
          WHERE id=? AND strategy_id=?
            AND status=? AND scheduled_at=?
            AND EXISTS (SELECT 1 FROM outreach_strategies parent
              WHERE parent.id=? AND parent.contact_id=?
                AND parent.status NOT IN ('paused','completed','archived'))
            AND EXISTS (SELECT 1 FROM contacts contact
              JOIN organizations organization ON organization.id=contact.organization_id
              WHERE contact.id=? AND contact.compliance_version=?
                AND contact.do_not_contact=0 AND contact.unsubscribed_at IS NULL AND contact.deleted_at IS NULL
                AND organization.do_not_contact=0 AND organization.deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM compliance_configuration WHERE id='default' AND version=?)
            AND NOT EXISTS (SELECT 1 FROM contact_suppressions
              WHERE channel=? AND address_normalized=?
                AND (scope='global' OR (scope='category' AND category=?)))`)
          .bind(
            ...values, stepId, strategyId, current.status, current.scheduledAt,
            strategyId, readiness.contactId,
            readiness.contactId, readiness.contactVersion,
            readiness.configurationVersion, readiness.channel, readiness.address,
            readiness.channel === "email" ? "prospecting" : "all",
          )
      : db.prepare(`UPDATE outreach_steps SET ${assignments.join(", ")}
          WHERE id=? AND strategy_id=? AND status=? AND scheduled_at=?
            AND EXISTS (SELECT 1 FROM outreach_strategies parent
              WHERE parent.id=? AND parent.status NOT IN ('paused','completed','archived'))`)
          .bind(...values, stepId, strategyId, current.status, current.scheduledAt, strategyId);
    const auditWrite = db.prepare(`INSERT INTO audit_entries
        (id, actor_email, action, entity_type, entity_id, details_json)
      SELECT ?, ?, 'outreach.step.updated', 'outreach_step', ?, ?
      WHERE EXISTS (
        SELECT 1 FROM outreach_steps
        WHERE id=? AND strategy_id=? AND updated_at=?
      )`)
      .bind(
        crypto.randomUUID(), auth.operator.email, stepId,
        JSON.stringify({ strategyId, status, scheduledAt, readiness: readiness?.decision ?? null,
          evidenceSnapshot: readiness?.evidenceSnapshot ?? null }),
        stepId, strategyId, operationStamp,
      );
    const [updated] = await db.batch([stepWrite, auditWrite]);
    if (changedRows(updated) !== 1) {
      return jsonError(409, readiness ? "compliance_state_changed" : "outreach_step_update_conflict");
    }

    return Response.json(
      { step: { id: stepId, strategyId, status: proposedStatus, scheduledAt: proposedSchedule } },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return jsonError(500, "outreach_step_update_failed");
  }
}

function validId(value: string): boolean {
  return /^[a-zA-Z0-9_-]{1,128}$/u.test(value);
}
