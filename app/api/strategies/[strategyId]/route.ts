import { requireOperatorRequest } from "@/lib/api-auth";
import { entityId } from "@/lib/crm-accounts";
import { changedRows, crmDatabase } from "@/lib/d1";
import {
  jsonError,
  optionalTrimmedString,
  readJsonObject,
  validIsoTimestamp,
} from "@/lib/http";
import { evaluateOutreachChannel } from "@/lib/outreach-readiness";
import { buildOutreachSteps } from "@/lib/outreach-strategy";
import { uniqueOperationTimestamp } from "@/lib/operation-stamp";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ strategyId: string }> };

const STATUSES = ["draft", "ready", "active", "paused", "completed", "archived"] as const;

type ExistingStrategy = {
  id: string;
  version: number;
  status: string;
};

export async function PUT(request: Request, context: RouteContext) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const { strategyId: rawOrganizationId } = await context.params;
  const organizationId = entityId(rawOrganizationId);
  if (!organizationId) return jsonError(400, "strategy_organization_invalid");
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");

  const objective = optionalTrimmedString(payload.objective, 2_000);
  const targetName = optionalTrimmedString(payload.targetName, 300);
  const targetRole = optionalTrimmedString(payload.targetRole, 500);
  const valueProposition = optionalTrimmedString(payload.valueProposition, 4_000);
  const openingAngle = optionalTrimmedString(payload.openingAngle, 4_000);
  const timingRationale = optionalTrimmedString(payload.timingRationale, 4_000);
  const contactResearchNotes = optionalTrimmedString(payload.contactResearchNotes, 8_000) ?? "";
  const recommendedStartAt = validIsoTimestamp(payload.recommendedStartAt);
  const recipientTimezone = validTimezone(payload.recipientTimezone);
  const researchSource = optionalTrimmedString(payload.researchSource, 500) ?? "Saisie opérateur";
  const researchSourceUrl = optionalUrl(payload.researchSourceUrl);
  const researchCapturedAt = validIsoTimestamp(payload.researchCapturedAt);
  const contactId = payload.contactId == null || payload.contactId === "" ? null : entityId(payload.contactId);
  const status = typeof payload.status === "string" && STATUSES.includes(payload.status as (typeof STATUSES)[number])
    ? payload.status as (typeof STATUSES)[number]
    : null;
  const expectedVersion = payload.version == null ? null : integer(payload.version, 1, 1_000_000);

  if (!objective || !targetRole || !valueProposition || !openingAngle || !timingRationale) {
    return jsonError(400, "strategy_content_invalid");
  }
  if (!recommendedStartAt || !recipientTimezone || !status) {
    return jsonError(400, "strategy_schedule_invalid");
  }
  if (payload.contactId && !contactId) return jsonError(400, "strategy_contact_invalid");
  if (payload.researchSourceUrl !== undefined && researchSourceUrl === undefined) {
    return jsonError(400, "strategy_source_invalid");
  }
  if (payload.researchCapturedAt !== undefined && researchCapturedAt === undefined) {
    return jsonError(400, "strategy_source_date_invalid");
  }
  if (payload.version !== undefined && expectedVersion === null) {
    return jsonError(400, "strategy_version_invalid");
  }

  try {
    const db = crmDatabase();
    const organization = await db
      .prepare("SELECT id FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1")
      .bind(organizationId)
      .first();
    if (!organization) return jsonError(404, "account_not_found");
    if (contactId) {
      const linked = await db
        .prepare("SELECT id FROM contacts WHERE id=? AND organization_id=? AND deleted_at IS NULL LIMIT 1")
        .bind(contactId, organizationId)
        .first();
      if (!linked) return jsonError(409, "strategy_contact_mismatch");
    }

    const existing = await db
      .prepare("SELECT id, version, status FROM outreach_strategies WHERE organization_id=? LIMIT 1")
      .bind(organizationId)
      .first<ExistingStrategy>();
    if (existing && expectedVersion !== existing.version) {
      return jsonError(409, "strategy_version_conflict");
    }
    if (!existing && expectedVersion !== null) {
      return jsonError(409, "strategy_version_conflict");
    }
    if (existing?.status === "completed") {
      return jsonError(409, "strategy_completed_locked");
    }

    const readiness = await evaluateOutreachChannel(db, contactId, "email");
    if ((status === "ready" || status === "active") && !readiness.allowed) {
      return jsonError(409, readiness.reasons[0] ?? "strategy_contact_blocked", readiness.reasons.join(","));
    }
    const strategyId = existing?.id ?? crypto.randomUUID();
    const nextVersion = existing ? existing.version + 1 : 1;
    const operationStamp = uniqueOperationTimestamp();
    const builtSteps = buildOutreachSteps({
      strategyId,
      startAt: recommendedStartAt,
      contactReady: readiness.allowed,
      recipientTimezone,
    });
    const steps = status === "completed"
      ? builtSteps.map((step) => ({ ...step, status: "skipped" as const }))
      : builtSteps;
    const strategyWrite = existing
      ? db.prepare(`UPDATE outreach_strategies SET
            contact_id=?, version=version+1, status=?, objective=?, target_name=?, target_role=?,
            value_proposition=?, opening_angle=?, timing_rationale=?, contact_research_notes=?,
            recommended_start_at=?, recipient_timezone=?, research_source=?, research_source_url=?,
            research_captured_at=?, updated_by=?, updated_at=?
          WHERE id=? AND version=?`)
          .bind(
            contactId, status, objective, targetName, targetRole, valueProposition, openingAngle,
            timingRationale, contactResearchNotes, recommendedStartAt, recipientTimezone,
            researchSource, researchSourceUrl ?? null, researchCapturedAt ?? null,
            auth.operator.email, operationStamp, strategyId, existing.version,
          )
      : db.prepare(`INSERT INTO outreach_strategies
            (id, organization_id, contact_id, status, objective, target_name, target_role,
             value_proposition, opening_angle, timing_rationale, contact_research_notes,
             recommended_start_at, recipient_timezone, research_source, research_source_url,
             research_captured_at, created_by, updated_by, updated_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM outreach_strategies WHERE organization_id=?
          )`)
          .bind(
            strategyId, organizationId, contactId, status, objective, targetName, targetRole,
            valueProposition, openingAngle, timingRationale, contactResearchNotes,
            recommendedStartAt, recipientTimezone, researchSource, researchSourceUrl ?? null,
            researchCapturedAt ?? null, auth.operator.email, auth.operator.email, operationStamp,
            organizationId,
          );

    const batchResults = await db.batch([
      strategyWrite,
      ...steps.map((step) =>
        db.prepare(`INSERT INTO outreach_steps
            (id, strategy_id, sequence_index, business_day_offset, action_type, title,
             purpose, requires_contact, status, scheduled_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM outreach_strategies WHERE id=? AND version=? AND updated_at=?
          )
          ON CONFLICT(id) DO UPDATE SET
            business_day_offset=excluded.business_day_offset,
            action_type=excluded.action_type,
            title=excluded.title,
            purpose=excluded.purpose,
            requires_contact=excluded.requires_contact,
            status=CASE WHEN outreach_steps.status IN ('done','skipped')
              THEN outreach_steps.status ELSE excluded.status END,
            scheduled_at=CASE WHEN outreach_steps.status IN ('done','skipped')
              THEN outreach_steps.scheduled_at ELSE excluded.scheduled_at END,
            updated_at=CURRENT_TIMESTAMP`)
          .bind(
            step.id, strategyId, step.sequenceIndex, step.businessDayOffset,
            step.actionType, step.title, step.purpose, step.requiresContact ? 1 : 0,
            step.status, step.scheduledAt, strategyId, nextVersion, operationStamp,
          ),
      ),
      db.prepare(`INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
        SELECT ?, ?, ?, 'outreach_strategy', ?, ?
        WHERE EXISTS (
          SELECT 1 FROM outreach_strategies WHERE id=? AND version=? AND updated_at=?
        )`)
        .bind(
          crypto.randomUUID(), auth.operator.email,
          existing ? "outreach.strategy.updated" : "outreach.strategy.created",
          strategyId,
          JSON.stringify({ organizationId, contactId, version: nextVersion, status, readiness: readiness.decision }),
          strategyId, nextVersion, operationStamp,
        ),
    ]);
    if (changedRows(batchResults[0]) !== 1) {
      return jsonError(409, "strategy_version_conflict");
    }

    return Response.json(
      {
        strategy: { id: strategyId, organizationId, contactId, version: nextVersion, status },
        readiness: { allowed: readiness.allowed, reasons: readiness.reasons },
      },
      { status: existing ? 200 : 201, headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return jsonError(500, "strategy_save_failed");
  }
}

function integer(value: unknown, minimum: number, maximum: number): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : null;
}

function validTimezone(value: unknown): string | null {
  const candidate = optionalTrimmedString(value, 100);
  if (!candidate) return null;
  try {
    new Intl.DateTimeFormat("fr-CA", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return null;
  }
}

function optionalUrl(value: unknown): string | null | undefined {
  const candidate = optionalTrimmedString(value, 2_000);
  if (candidate == null) return candidate;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}
