import { requireOperatorRequest } from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import { jsonError } from "@/lib/http";
import { CRM_MAILBOXES, mailboxForAddress } from "@/lib/mailboxes";
import {
  buildDeliveryTimeline,
  mailgunDeliveryState,
  mailgunReasonFromPayloadJson,
  storedMessageDeliveryState,
  type DeliveryTimelineEvent,
} from "@/lib/mailgun-lifecycle";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

type MailboxRow = {
  id: string;
  address: string;
  purpose: "sales" | "operations";
  unreadCount: number;
};

type ContactRow = {
  id: string;
  email: string;
  phone: string | null;
  displayName: string | null;
  organization: string | null;
  organizationId: string | null;
  role: string | null;
  source: string;
  sourceUrl: string | null;
  sourceDate: string | null;
  contactBasis: string;
  roleRelevance: string;
  roleRelevanceDetail: string;
  personalDataCategory: string;
  qualificationMode: string;
  provenanceType: string;
  evidenceRef: string | null;
  lawfulBasis: string;
  basisEvidenceRef: string | null;
  basisVerifiedBy: string | null;
  basisVerifiedAt: string | null;
  basisExpiresAt: string | null;
  publicationByRecipient: number;
  publicationNoRestriction: number;
  publicationRoleRelevance: string;
  directDisclosureNoRestriction: number;
  b2bRelationshipEvidence: string;
  b2bMessageRelevance: string;
  phoneEvidenceRef: string | null;
  recipientTimezone: string | null;
  dnclCheckedAt: string | null;
  dnclEvidenceRef: string | null;
  dnclStatus: string;
  emailStatus: string;
  unsubscribedAt: string | null;
  doNotCall: number;
  doNotContact: number;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  validatedAt: string | null;
  conversationCount: number;
};

type OrganizationRow = {
  id: string; name: string; website: string | null; sourceLabel: string;
  sourceUrl: string | null; sourceDate: string | null; score: number | null;
  priority: "very_high" | "high" | "normal" | "low";
  budgetMinCents: number | null; budgetMaxCents: number | null;
  budgetIsHypothesis: number; ownerEmail: string | null; doNotContact: number;
  lastContactAt: string | null; nextFollowUpAt: string | null;
  nextStep: string | null; notes: string; contactCount: number;
};

type IntakeRow = { id: string; organizationName: string; contactName: string; contactEmail: string; projectType: string | null; message: string; createdAt: string };

type ConversationRow = {
  id: string;
  mailboxId: string;
  mailboxAddress: string;
  contactId: string | null;
  contactEmail: string | null;
  contactName: string | null;
  organization: string | null;
  subject: string;
  isUnread: number;
  followUpState: string;
  lastMessageAt: string;
  dealId: string | null;
};

type InteractionRow = {
  id: string;
  dealId: string;
  kind: "call" | "email" | "meeting" | "note" | "other";
  summary: string;
  occurredAt: string;
  createdBy: string;
};

type MessageRow = {
  id: string;
  conversationId: string;
  direction: "inbound" | "outbound";
  sender: string;
  subject: string;
  textBody: string | null;
  status: string;
  occurredAt: string;
};

type MessageEventRow = {
  messageId: string;
  eventType: string;
  severity: string | null;
  eventTimestamp: string;
  payloadJson: string;
  eventSequence: number;
};

type DealRow = {
  id: string;
  organizationId: string | null;
  contactId: string | null;
  conversationId: string;
  subject: string;
  contactName: string | null;
  organization: string | null;
  source: string;
  stage: string;
  projectType: string | null;
  nextAction: string | null;
  nextActionAt: string | null;
  note: string;
};

type TaskRow = {
  id: string;
  title: string;
  status: string;
  dueAt: string | null;
  dealId: string | null;
};

type ActivityRow = { id: string; actorEmail: string; action: string; entityType: string; entityId: string; createdAt: string };

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;

  const url = new URL(request.url);
  const mailboxFilter = resolveMailboxFilter(url.searchParams.get("mailbox"));
  if (url.searchParams.has("mailbox") && !mailboxFilter) {
    return jsonError(400, "mailbox_invalid");
  }
  const unreadFilter = parseBooleanFilter(url.searchParams.get("unread"));
  if (url.searchParams.has("unread") && unreadFilter === null) {
    return jsonError(400, "unread_filter_invalid");
  }
  const followUp = url.searchParams.get("followUp");
  if (
    followUp &&
    !["none", "pending", "waiting", "done"].includes(followUp)
  ) {
    return jsonError(400, "follow_up_filter_invalid");
  }

  const conditions: string[] = [];
  const values: unknown[] = [];
  if (mailboxFilter) {
    conditions.push("c.mailbox_id = ?");
    values.push(mailboxFilter);
  }
  if (unreadFilter !== undefined && unreadFilter !== null) {
    conditions.push("c.is_unread = ?");
    values.push(unreadFilter ? 1 : 0);
  }
  if (followUp) {
    conditions.push("c.follow_up_state = ?");
    values.push(followUp);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const conversationWhere = conditions.length
    ? `${where} AND EXISTS (SELECT 1 FROM messages visible_message WHERE visible_message.conversation_id = c.id)`
    : "WHERE EXISTS (SELECT 1 FROM messages visible_message WHERE visible_message.conversation_id = c.id)";

  try {
    const db = crmDatabase();
    const [
      mailboxes,
      organizations,
      contacts,
      conversations,
      messages,
      messageEvents,
      deals,
      interactions,
      tasks,
      intakes,
      activities,
    ] =
      await Promise.all([
        db
          .prepare(
            `SELECT mb.id, mb.address, mb.purpose,
                    COUNT(CASE WHEN c.is_unread = 1 THEN 1 END) AS unreadCount
             FROM mailboxes mb
             LEFT JOIN conversations c ON c.mailbox_id = mb.id
             WHERE mb.is_active = 1
             GROUP BY mb.id, mb.address, mb.purpose
             ORDER BY CASE mb.purpose WHEN 'sales' THEN 0 ELSE 1 END`,
          )
          .all<MailboxRow>(),
        db
          .prepare(
            `SELECT organization.id, organization.name, organization.website,
                    organization.source_label AS sourceLabel,
                    organization.source_url AS sourceUrl,
                    organization.source_date AS sourceDate,
                    organization.score, organization.priority,
                    organization.budget_min_cents AS budgetMinCents,
                    organization.budget_max_cents AS budgetMaxCents,
                    organization.budget_is_hypothesis AS budgetIsHypothesis,
                    organization.owner_email AS ownerEmail,
                    organization.do_not_contact AS doNotContact,
                    organization.last_contact_at AS lastContactAt,
                    organization.next_follow_up_at AS nextFollowUpAt,
                    organization.next_step AS nextStep, organization.notes,
                    COUNT(contact.id) AS contactCount
             FROM organizations organization
             LEFT JOIN contacts contact ON contact.organization_id = organization.id AND contact.deleted_at IS NULL
             WHERE organization.deleted_at IS NULL
             GROUP BY organization.id
             ORDER BY organization.sort_order, organization.score DESC, organization.name`,
          )
          .all<OrganizationRow>(),
        db
          .prepare(
            `SELECT contact.id, contact.email, contact.phone,
                    contact.display_name AS displayName,
                    contact.organization, contact.organization_id AS organizationId,
                    contact.role, contact.source,
                    contact.source_url AS sourceUrl,
                    contact.source_date AS sourceDate,
                    contact.contact_basis AS contactBasis,
                    contact.role_relevance AS roleRelevance,
                    contact.role_relevance_detail AS roleRelevanceDetail,
                    contact.personal_data_category AS personalDataCategory,
                    contact.qualification_mode AS qualificationMode,
                    email_channel.provenance_type AS provenanceType,
                    email_channel.evidence_ref AS evidenceRef,
                    email_channel.lawful_basis AS lawfulBasis,
                    email_channel.basis_evidence_ref AS basisEvidenceRef,
                    email_channel.basis_verified_by AS basisVerifiedBy,
                    email_channel.basis_verified_at AS basisVerifiedAt,
                    email_channel.basis_expires_at AS basisExpiresAt,
                    email_channel.publication_by_recipient AS publicationByRecipient,
                    email_channel.publication_no_restriction AS publicationNoRestriction,
                    email_channel.publication_role_relevance AS publicationRoleRelevance,
                    email_channel.direct_disclosure_no_restriction AS directDisclosureNoRestriction,
                    email_channel.b2b_relationship_evidence AS b2bRelationshipEvidence,
                    email_channel.b2b_message_relevance AS b2bMessageRelevance,
                    phone_channel.evidence_ref AS phoneEvidenceRef,
                    phone_channel.recipient_timezone AS recipientTimezone,
                    phone_channel.dncl_checked_at AS dnclCheckedAt,
                    phone_channel.dncl_evidence_ref AS dnclEvidenceRef,
                    contact.dncl_status AS dnclStatus,
                    contact.email_status AS emailStatus,
                    contact.unsubscribed_at AS unsubscribedAt,
                    contact.do_not_call AS doNotCall,
                    contact.do_not_contact AS doNotContact,
                    contact.last_contact_at AS lastContactAt,
                    contact.next_follow_up_at AS nextFollowUpAt,
                    contact.validated_at AS validatedAt,
                    COUNT(c.id) AS conversationCount
             FROM contacts contact
             LEFT JOIN conversations c ON c.contact_id = contact.id
             LEFT JOIN contact_channel_compliance email_channel ON email_channel.contact_id=contact.id AND email_channel.channel='email'
             LEFT JOIN contact_channel_compliance phone_channel ON phone_channel.contact_id=contact.id AND phone_channel.channel='phone'
             WHERE contact.deleted_at IS NULL
             GROUP BY contact.id
             ORDER BY contact.display_name, contact.email`,
          )
          .all<ContactRow>(),
        db
          .prepare(
            `SELECT c.id, c.mailbox_id AS mailboxId,
                    mb.address AS mailboxAddress,
                    contact.id AS contactId,
                    contact.email AS contactEmail,
                    contact.display_name AS contactName,
                    contact.organization,
                    c.subject,
                    c.is_unread AS isUnread,
                    c.follow_up_state AS followUpState,
                    c.last_message_at AS lastMessageAt,
                    d.id AS dealId
             FROM conversations c
             JOIN mailboxes mb ON mb.id = c.mailbox_id
             LEFT JOIN contacts contact ON contact.id = c.contact_id
             LEFT JOIN deals d ON d.conversation_id = c.id
             ${conversationWhere}
             ORDER BY c.last_message_at DESC
             LIMIT 100`,
          )
          .bind(...values)
          .all<ConversationRow>(),
        db
          .prepare(
            `SELECT m.id, m.conversation_id AS conversationId,
                    m.direction, m.sender, m.subject,
                    m.text_body AS textBody, m.status,
                    m.occurred_at AS occurredAt
             FROM messages m
             JOIN conversations c ON c.id = m.conversation_id
             ${where}
             ORDER BY m.occurred_at, m.created_at`,
          )
          .bind(...values)
          .all<MessageRow>(),
        db
          .prepare(
            `SELECT me.message_id AS messageId,
                    me.event_type AS eventType,
                    me.severity,
                    me.event_timestamp AS eventTimestamp,
                    me.payload_json AS payloadJson,
                    me.rowid AS eventSequence
             FROM message_events me
             JOIN messages m ON m.id = me.message_id
             JOIN conversations c ON c.id = m.conversation_id
             ${where}
             ORDER BY me.event_timestamp, me.rowid`,
          )
          .bind(...values)
          .all<MessageEventRow>(),
        db
          .prepare(
            `SELECT d.id, d.organization_id AS organizationId,
                    COALESCE(d.contact_id, c.contact_id) AS contactId,
                    d.conversation_id AS conversationId,
                    c.subject,
                    contact.display_name AS contactName,
                    COALESCE(organization.name, contact.organization) AS organization,
                    COALESCE(organization.source_label, contact.source, 'Non renseignée') AS source,
                    d.stage, d.project_type AS projectType,
                    d.next_action AS nextAction,
                    d.next_action_at AS nextActionAt,
                    d.note
             FROM deals d
             JOIN conversations c ON c.id = d.conversation_id
             LEFT JOIN contacts contact ON contact.id = COALESCE(d.contact_id, c.contact_id)
             LEFT JOIN organizations organization ON organization.id = d.organization_id
             ORDER BY d.updated_at DESC`,
          )
          .all<DealRow>(),
        db
          .prepare(
            `SELECT id, deal_id AS dealId, kind, summary,
                    occurred_at AS occurredAt, created_by AS createdBy
             FROM interactions
             WHERE deal_id IS NOT NULL
             ORDER BY occurred_at DESC, created_at DESC`,
          )
          .all<InteractionRow>(),
        db
          .prepare(
            `SELECT id, title, status, due_at AS dueAt, deal_id AS dealId
             FROM tasks
             WHERE status <> 'cancelled'
             ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at`,
          )
          .all<TaskRow>(),
        db
          .prepare(
            `SELECT id, organization_name AS organizationName,
                    contact_name AS contactName, contact_email AS contactEmail,
                    project_type AS projectType, message, created_at AS createdAt
             FROM intake_submissions WHERE status='pending'
             ORDER BY created_at DESC LIMIT 100`,
          )
          .all<IntakeRow>(),
        db
          .prepare(`SELECT id, actor_email AS actorEmail, action, entity_type AS entityType,
                    entity_id AS entityId, created_at AS createdAt
             FROM audit_entries ORDER BY created_at DESC, rowid DESC LIMIT 100`)
          .all<ActivityRow>(),
      ]);

    const messagesByConversation = new Map<string, MessageRow[]>();
    for (const message of messages.results) {
      const current = messagesByConversation.get(message.conversationId) ?? [];
      current.push(message);
      messagesByConversation.set(message.conversationId, current);
    }
    const deliveryEventsByMessage = new Map<
      string,
      DeliveryTimelineEvent[]
    >();
    for (const event of messageEvents.results) {
      const state = mailgunDeliveryState({
        eventType: event.eventType,
        severity: event.severity,
        reason: mailgunReasonFromPayloadJson(event.payloadJson),
      });
      if (!state) continue;
      const current = deliveryEventsByMessage.get(event.messageId) ?? [];
      current.push({
        state,
        occurredAt: event.eventTimestamp,
        sequence: event.eventSequence,
      });
      deliveryEventsByMessage.set(event.messageId, current);
    }
    const contactById = new Map(contacts.results.map((contact) => [contact.id, contact]));
    const interactionsByDeal = new Map<string, InteractionRow[]>();
    for (const interaction of interactions.results) {
      const current = interactionsByDeal.get(interaction.dealId) ?? [];
      current.push(interaction);
      interactionsByDeal.set(interaction.dealId, current);
    }

    return Response.json(
      {
        mailboxes: mailboxes.results.map((mailbox) => ({
          address: mailbox.address,
          label:
            mailbox.purpose === "sales"
              ? "Prospects et clients"
              : "Comptes et opérations",
          kind: mailbox.purpose,
          unreadCount: Number(mailbox.unreadCount ?? 0),
        })),
        transportState: transportState(),
        conversations: conversations.results.map((conversation) => {
          const contact = conversation.contactId
            ? contactById.get(conversation.contactId)
            : null;
          const threadMessages =
            messagesByConversation.get(conversation.id) ?? [];
          const latest = threadMessages.at(-1);
          const contactName =
            conversation.contactName ??
            conversation.contactEmail ??
            "Contact inconnu";
          return {
            id: conversation.id,
            mailboxAddress: conversation.mailboxAddress,
            contactId: conversation.contactId ?? "",
            contactName,
            contactEmail: conversation.contactEmail ?? "",
            organization: conversation.organization ?? "",
            subject: conversation.subject,
            preview: latest?.textBody?.slice(0, 280) ?? "",
            updatedLabel: displayDate(conversation.lastMessageAt),
            unread: Boolean(conversation.isUnread),
            followUp: ["pending", "waiting"].includes(
              conversation.followUpState,
            ),
            dealId: conversation.dealId,
            messages: threadMessages.map((message) => {
              const storedState = storedMessageDeliveryState(
                message.status,
                message.direction,
              );
              const deliveryTimeline =
                message.direction === "outbound"
                  ? buildDeliveryTimeline({
                      messageOccurredAt: message.occurredAt,
                      storedState:
                        storedState === "received" ? "accepted" : storedState,
                      providerEvents:
                        deliveryEventsByMessage.get(message.id) ?? [],
                    })
                  : [];

              return {
                id: message.id,
                direction: message.direction,
                senderName:
                  message.direction === "outbound" ? "27PM" : contactName,
                senderEmail: message.sender,
                recipientLabel:
                  message.direction === "outbound"
                    ? contact?.displayName ?? contact?.email ?? "Contact"
                    : conversation.mailboxAddress,
                sentAt: displayDate(message.occurredAt),
                sentAtIso: message.occurredAt,
                body: message.textBody ?? "",
                deliveryState:
                  deliveryTimeline.at(-1)?.state ?? storedState,
                deliveryEvents: deliveryTimeline.map((event) => ({
                  state: event.state,
                  occurredAt: event.occurredAt,
                  occurredLabel: displayEventDate(event.occurredAt),
                })),
              };
            }),
          };
        }),
        organizations: organizations.results.map((organization) => ({
          ...organization,
          score: organization.score === null ? null : Number(organization.score),
          budgetMinCents: organization.budgetMinCents === null ? null : Number(organization.budgetMinCents),
          budgetMaxCents: organization.budgetMaxCents === null ? null : Number(organization.budgetMaxCents),
          budgetIsHypothesis: Boolean(organization.budgetIsHypothesis),
          doNotContact: Boolean(organization.doNotContact),
          contactCount: Number(organization.contactCount ?? 0),
        })),
        contacts: contacts.results.map((contact) => ({
          id: contact.id,
          name: contact.displayName ?? contact.email,
          email: contact.email,
          phone: contact.phone ?? "",
          organization: contact.organization ?? "",
          organizationId: contact.organizationId ?? "",
          role: contact.role ?? "",
          source: contact.source,
          sourceUrl: contact.sourceUrl,
          sourceDate: contact.sourceDate,
          contactBasis: contact.contactBasis,
          roleRelevance: contact.roleRelevance,
          roleRelevanceDetail: contact.roleRelevanceDetail,
          personalDataCategory: contact.personalDataCategory,
          qualificationMode: contact.qualificationMode,
          provenanceType: contact.provenanceType,
          evidenceRef: contact.evidenceRef,
          lawfulBasis: contact.lawfulBasis,
          basisEvidenceRef: contact.basisEvidenceRef,
          basisVerifiedBy: contact.basisVerifiedBy,
          basisVerifiedAt: contact.basisVerifiedAt,
          basisExpiresAt: contact.basisExpiresAt,
          publicationByRecipient: Boolean(contact.publicationByRecipient),
          publicationNoRestriction: Boolean(contact.publicationNoRestriction),
          publicationRoleRelevance: contact.publicationRoleRelevance,
          directDisclosureNoRestriction: Boolean(contact.directDisclosureNoRestriction),
          b2bRelationshipEvidence: contact.b2bRelationshipEvidence,
          b2bMessageRelevance: contact.b2bMessageRelevance,
          phoneEvidenceRef: contact.phoneEvidenceRef,
          recipientTimezone: contact.recipientTimezone,
          dnclCheckedAt: contact.dnclCheckedAt,
          dnclEvidenceRef: contact.dnclEvidenceRef,
          dnclStatus: contact.dnclStatus,
          emailStatus: contact.emailStatus,
          unsubscribed: Boolean(contact.unsubscribedAt),
          doNotCall: Boolean(contact.doNotCall),
          doNotContact: Boolean(contact.doNotContact),
          lastContactAt: contact.lastContactAt,
          nextFollowUpAt: contact.nextFollowUpAt,
          validated: Boolean(contact.validatedAt),
          status: contact.doNotContact || contact.unsubscribedAt
            ? "Bloqué"
            : contact.validatedAt && contact.emailStatus === "valid" && contact.roleRelevance === "relevant" && contact.roleRelevanceDetail && contact.lawfulBasis !== "none" && contact.basisEvidenceRef && contact.evidenceRef
              ? "Documenté"
              : "À valider",
          conversationCount: Number(contact.conversationCount ?? 0),
        })),
        deals: deals.results.map((deal) => ({
          id: deal.id,
          organizationId: deal.organizationId ?? "",
          contactId: deal.contactId ?? "",
          conversationId: deal.conversationId,
          title: deal.subject,
          contactName: deal.contactName ?? "Aucun contact vérifié",
          organization: deal.organization ?? "",
          projectType: presentationProjectType(deal.projectType),
          stage: presentationStage(deal.stage),
          source: deal.source,
          nextAction: deal.nextAction ?? "",
          nextActionDate: deal.nextActionAt?.slice(0, 10) ?? "",
          note: deal.note,
          interactions: (interactionsByDeal.get(deal.id) ?? []).map(
            (interaction) => ({
              id: interaction.id,
              kind: interaction.kind,
              summary: interaction.summary,
              occurredAt: interaction.occurredAt,
              occurredLabel: displayDate(interaction.occurredAt),
              createdBy: interaction.createdBy,
            }),
          ),
        })),
        tasks: tasks.results.map((task) => ({
          id: task.id,
          title: task.title,
          dueLabel: task.dueAt ? displayDate(task.dueAt) : "À planifier",
          dueAt: task.dueAt,
          overdue:
            task.status === "open" &&
            Boolean(task.dueAt) &&
            new Date(task.dueAt as string).valueOf() < Date.now(),
          completed: task.status === "done",
          dealId: task.dealId,
        })),
        intakes: intakes.results.map((intake) => ({ ...intake, createdLabel: displayDate(intake.createdAt) })),
        activities: activities.results.map((activity) => ({ ...activity, createdLabel: displayDate(activity.createdAt) })),
        live: true,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch {
    return jsonError(500, "dashboard_unavailable");
  }
}

function resolveMailboxFilter(value: string | null): string | null {
  if (!value) return null;
  return (
    CRM_MAILBOXES.find((mailbox) => mailbox.id === value)?.id ??
    mailboxForAddress(value)?.id ??
    null
  );
}

function parseBooleanFilter(value: string | null): boolean | undefined | null {
  if (value === null || value === "") return undefined;
  if (value === "1" || value === "true") return true;
  if (value === "0" || value === "false") return false;
  return null;
}

function transportState(): "operational" | "configuration" {
  return runtimeString("MAILGUN_DOMAIN") === "27pm.org" &&
    Boolean(runtimeString("MAILGUN_SENDING_KEY")) &&
    Boolean(runtimeString("MAILGUN_WEBHOOK_SIGNING_KEY"))
    ? "operational"
    : "configuration";
}

function presentationStage(
  stage: string,
): "nouveau" | "qualifie" | "proposition" | "production" | "gagne" {
  switch (stage) {
    case "qualified":
      return "qualifie";
    case "discovery":
      return "production";
    case "proposal":
      return "proposition";
    case "won":
      return "gagne";
    case "archived":
    case "lost":
      return "production";
    default:
      return "nouveau";
  }
}

function presentationProjectType(
  projectType: string | null,
): "Site web" | "Application" | "Produit numérique" {
  if (projectType === "Application") return "Application";
  if (projectType === "Produit numérique") return "Produit numérique";
  return "Site web";
}

function displayDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("fr-CA", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Toronto",
  }).format(date);
}

function displayEventDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("fr-CA", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "America/Toronto",
  }).format(date);
}
