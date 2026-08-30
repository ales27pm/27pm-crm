import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import { canCall, canEmail, complianceEvidenceSnapshot, loadComplianceConfiguration, loadContactCompliance, type ComplianceDecision, type ContactCompliance } from "@/lib/compliance";
import { runtimeString } from "@/lib/runtime";
import { validUnsubscribeSecret } from "@/lib/unsubscribe";
import {
  jsonError,
  optionalTrimmedString,
  readJsonObject,
  validIsoTimestamp,
} from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;

  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const title = optionalTrimmedString(payload.title, 300);
  const dealId = entityId(payload.dealId);
  const requestedConversationId = entityId(payload.conversationId);
  const dueAt = "dueAt" in payload ? validIsoTimestamp(payload.dueAt) : null;
  const contactAction = payload.contactAction === true;
  const requestedChannel = payload.contactChannel;
  const contactChannel = contactAction
    ? requestedChannel === "email" || requestedChannel === "phone" ? requestedChannel : null
    : "internal";
  if (
    !title ||
    dueAt === undefined ||
    (payload.dealId !== undefined && !dealId) ||
    (payload.conversationId !== undefined && !requestedConversationId) ||
    !contactChannel ||
    (!dealId && !requestedConversationId)
  ) {
    return jsonError(400, "task_invalid");
  }

  try {
    const db = crmDatabase();
    let contact: ContactCompliance | null = null;
    let decision: ComplianceDecision | null = null;
    let configurationVersion: number | null = null;
    let evidenceSnapshot: ReturnType<typeof complianceEvidenceSnapshot> | null = null;
    const deal = dealId
      ? await db
          .prepare("SELECT conversation_id AS conversationId FROM deals WHERE id = ? LIMIT 1")
          .bind(dealId)
          .first<{ conversationId: string }>()
      : null;
    if (dealId && !deal) return jsonError(404, "deal_not_found");

    const conversationId = deal?.conversationId ?? requestedConversationId;
    if (!conversationId) return jsonError(400, "task_parent_required");
    if (requestedConversationId && requestedConversationId !== conversationId) {
      return jsonError(409, "task_parent_mismatch");
    }
    const conversation = await db
      .prepare("SELECT 1 AS present FROM conversations WHERE id = ? LIMIT 1")
      .bind(conversationId)
      .first();
    if (!conversation) return jsonError(404, "conversation_not_found");

    if (contactAction) {
      const actionChannel: "email" | "phone" = contactChannel === "phone" ? "phone" : "email";
      const linked = await db
        .prepare(
          `SELECT contact.id AS contactId, contact.email, contact.phone
           FROM conversations conversation
           LEFT JOIN deals deal ON deal.id = ? AND deal.conversation_id = conversation.id
           LEFT JOIN contacts contact ON contact.id = COALESCE(deal.contact_id, conversation.contact_id)
           LEFT JOIN organizations organization ON organization.id = COALESCE(deal.organization_id, contact.organization_id)
           WHERE conversation.id = ? LIMIT 1`,
        )
        .bind(dealId, conversationId)
        .first<{ contactId: string | null; email: string | null; phone: string | null }>();
      const address = actionChannel === "phone" ? linked?.phone : linked?.email;
      if (!linked?.contactId || !address) return jsonError(409, "contact_required_for_action");
      contact = await loadContactCompliance(db, actionChannel, address);
      if (!contact || contact.contactId !== linked.contactId) return jsonError(409, "contact_compliance_missing");
      const configuration = await loadComplianceConfiguration(db);
      configuration.unsubscribeSigningKeyConfigured = validUnsubscribeSecret(runtimeString("CRM_UNSUBSCRIBE_SIGNING_KEY"));
      decision = actionChannel === "phone" ? canCall(contact, configuration) : canEmail(contact, configuration);
      configurationVersion = configuration.version;
      if (!decision.allowed) return jsonError(409, decision.reasons[0] ?? "contact_action_blocked", decision.reasons.join(","));
      evidenceSnapshot = complianceEvidenceSnapshot(contact, configuration);
    }

    const id = crypto.randomUUID();
    const inserted = contactAction && contact && decision && configurationVersion !== null
      ? await db.prepare(`INSERT INTO tasks
          (id, conversation_id, deal_id, title, status, due_at, contact_action, contact_channel)
          SELECT ?, ?, ?, ?, 'open', ?, 1, ?
          WHERE EXISTS (SELECT 1 FROM contacts contact
            JOIN organizations organization ON organization.id=contact.organization_id
            WHERE contact.id=? AND contact.compliance_version=?
              AND contact.do_not_contact=0 AND contact.unsubscribed_at IS NULL AND contact.deleted_at IS NULL
              AND organization.do_not_contact=0 AND organization.deleted_at IS NULL)
            AND EXISTS (SELECT 1 FROM compliance_configuration WHERE id='default' AND version=?)
            AND NOT EXISTS (SELECT 1 FROM contact_suppressions WHERE channel=? AND address_normalized=?
              AND (scope='global' OR (scope='category' AND category=?)))`)
          .bind(id, conversationId, dealId, title, dueAt, contactChannel, contact.contactId, contact.complianceVersion, configurationVersion, contactChannel, contact.addressNormalized, contactChannel === "email" ? "prospecting" : "all").run()
      : await db.prepare(`INSERT INTO tasks
          (id, conversation_id, deal_id, title, status, due_at, contact_action, contact_channel)
          VALUES (?, ?, ?, ?, 'open', ?, 0, 'internal')`)
          .bind(id, conversationId, dealId, title, dueAt).run();
    if (changedRows(inserted) !== 1) return jsonError(409, "compliance_state_changed");
    await db
        .prepare(
          `INSERT INTO audit_entries
            (id, actor_email, action, entity_type, entity_id, details_json)
           VALUES (?, ?, 'task.created', 'task', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          auth.operator.email,
          id,
          JSON.stringify({ conversationId, dealId, contactAction, contactChannel, complianceDecision: decision, evidenceSnapshot }),
        )
        .run();

    return Response.json(
      {
        task: {
          id,
          title,
          dueAt,
          completed: false,
          dealId,
          conversationId,
        },
      },
      {
        status: 201,
        headers: { "cache-control": "private, no-store" },
      },
    );
  } catch {
    return jsonError(500, "task_create_failed");
  }
}

function entityId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value)
    ? value
    : null;
}
