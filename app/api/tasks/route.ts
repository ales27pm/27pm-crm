import { requireOperatorRequest } from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import { emailContactability, phoneContactability, type ContactabilityRow } from "@/lib/crm-accounts";
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
      const contact = await db
        .prepare(
          `SELECT contact.id AS contactId,
                  contact.organization_id AS organizationId,
                  contact.phone AS phone,
                  contact.validated_at AS validatedAt,
                  contact.contact_basis AS contactBasis,
                  contact.role_relevance AS roleRelevance,
                  contact.email_status AS emailStatus,
                  contact.unsubscribed_at AS unsubscribedAt,
                  contact.do_not_call AS doNotCall,
                  contact.do_not_contact AS doNotContact,
                  contact.deleted_at AS deletedAt,
                  contact.dncl_status AS dnclStatus,
                  organization.do_not_contact AS organizationDoNotContact,
                  organization.deleted_at AS organizationDeletedAt
           FROM conversations conversation
           LEFT JOIN deals deal ON deal.id = ? AND deal.conversation_id = conversation.id
           LEFT JOIN contacts contact ON contact.id = COALESCE(deal.contact_id, conversation.contact_id)
           LEFT JOIN organizations organization ON organization.id = COALESCE(deal.organization_id, contact.organization_id)
           WHERE conversation.id = ? LIMIT 1`,
        )
        .bind(dealId, conversationId)
        .first<ContactabilityRow & { dnclStatus: string }>();
      if (!contact?.contactId) return jsonError(409, "contact_required_for_action");
      const blocked = contactChannel === "phone"
        ? phoneContactability(contact)
        : emailContactability(contact);
      if (blocked) return jsonError(409, blocked);
    }

    const id = crypto.randomUUID();
    await db.batch([
      db
        .prepare(
          `INSERT INTO tasks
            (id, conversation_id, deal_id, title, status, due_at, contact_action, contact_channel)
           VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`,
        )
        .bind(id, conversationId, dealId, title, dueAt, contactAction ? 1 : 0, contactChannel),
      db
        .prepare(
          `INSERT INTO audit_entries
            (id, actor_email, action, entity_type, entity_id, details_json)
           VALUES (?, ?, 'task.created', 'task', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          auth.operator.email,
          id,
          JSON.stringify({ conversationId, dealId, contactAction, contactChannel }),
        ),
    ]);

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
