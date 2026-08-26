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
  displayName: string | null;
  organization: string | null;
  conversationCount: number;
};

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
  contactId: string | null;
  conversationId: string;
  subject: string;
  contactName: string | null;
  organization: string | null;
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

  try {
    const db = crmDatabase();
    const [
      mailboxes,
      contacts,
      conversations,
      messages,
      messageEvents,
      deals,
      tasks,
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
            `SELECT contact.id, contact.email,
                    contact.display_name AS displayName,
                    contact.organization,
                    COUNT(c.id) AS conversationCount
             FROM contacts contact
             LEFT JOIN conversations c ON c.contact_id = contact.id
             GROUP BY contact.id, contact.email, contact.display_name, contact.organization
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
             ${where}
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
            `SELECT d.id, c.contact_id AS contactId,
                    d.conversation_id AS conversationId,
                    c.subject,
                    contact.display_name AS contactName,
                    contact.organization,
                    d.stage, d.project_type AS projectType,
                    d.next_action AS nextAction,
                    d.next_action_at AS nextActionAt,
                    d.note
             FROM deals d
             JOIN conversations c ON c.id = d.conversation_id
             LEFT JOIN contacts contact ON contact.id = c.contact_id
             ORDER BY d.updated_at DESC`,
          )
          .all<DealRow>(),
        db
          .prepare(
            `SELECT id, title, status, due_at AS dueAt, deal_id AS dealId
             FROM tasks
             WHERE status <> 'cancelled'
             ORDER BY CASE WHEN due_at IS NULL THEN 1 ELSE 0 END, due_at`,
          )
          .all<TaskRow>(),
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
        contacts: contacts.results.map((contact) => ({
          id: contact.id,
          name: contact.displayName ?? contact.email,
          email: contact.email,
          organization: contact.organization ?? "",
          source: "Courriel",
          status: "Contact",
          conversationCount: Number(contact.conversationCount ?? 0),
        })),
        deals: deals.results.map((deal) => ({
          id: deal.id,
          contactId: deal.contactId ?? "",
          conversationId: deal.conversationId,
          title: deal.organization || deal.subject,
          contactName: deal.contactName ?? "Contact inconnu",
          organization: deal.organization ?? "",
          projectType: presentationProjectType(deal.projectType),
          stage: presentationStage(deal.stage),
          source: "Courriel",
          nextAction: deal.nextAction ?? "",
          nextActionDate: deal.nextActionAt?.slice(0, 10) ?? "",
          note: deal.note,
        })),
        tasks: tasks.results.map((task) => ({
          id: task.id,
          title: task.title,
          dueLabel: task.dueAt ? displayDate(task.dueAt) : "À planifier",
          completed: task.status === "done",
          dealId: task.dealId,
        })),
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
