import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import { jsonError, readJsonObject } from "@/lib/http";
import { sendMailgunMessage } from "@/lib/mailgun-client";
import { reconcileMailgunEventsBestEffort } from "@/lib/mailgun-event-reconciliation";
import {
  normalizeCommandIdempotencyKey,
  normalizeMessageId,
  requestFingerprint,
} from "@/lib/mailgun";
import {
  CRM_MAILBOXES,
  extractEmailAddress,
  mailboxForAddress,
  parseAddressList,
} from "@/lib/mailboxes";
import { requireRuntimeString, runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

type SendCommandRow = {
  requestHash: string;
  status: "pending" | "sent" | "failed";
  providerMessageId: string | null;
  conversationId: string | null;
};

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;

  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const idempotencyKey = normalizeCommandIdempotencyKey(
    request.headers.get("idempotency-key") ??
      (typeof payload.idempotencyKey === "string"
        ? payload.idempotencyKey
        : null),
  );
  if (!idempotencyKey) return jsonError(400, "idempotency_key_invalid");
  const command = parseSendCommand(payload);
  if (!command) return jsonError(400, "message_invalid");

  const requestHash = await requestFingerprint(command);
  const db = crmDatabase();
  const commandId = crypto.randomUUID();
  let conversation: {
    id: string;
    mailboxId: string;
    externalMessageId: string | null;
  } | null = null;

  try {
    if (command.conversationId) {
      conversation = await db
        .prepare(
          `SELECT c.id, c.mailbox_id AS mailboxId,
                  (SELECT m.external_message_id FROM messages m
                    WHERE m.conversation_id = c.id AND m.external_message_id IS NOT NULL
                    ORDER BY m.occurred_at DESC LIMIT 1) AS externalMessageId
           FROM conversations c WHERE c.id = ? LIMIT 1`,
        )
        .bind(command.conversationId)
        .first();
      if (!conversation) return jsonError(404, "conversation_not_found");
      if (conversation.mailboxId !== command.mailbox.id) {
        return jsonError(409, "conversation_mailbox_mismatch");
      }
    }

    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO send_commands
          (id, idempotency_key, request_hash, mailbox_id, conversation_id, status)
         VALUES (?, ?, ?, ?, ?, 'pending')`,
      )
      .bind(
        commandId,
        idempotencyKey,
        requestHash,
        command.mailbox.id,
        command.conversationId,
      )
      .run();

    if (changedRows(inserted) === 0) {
      const existing = await db
        .prepare(
          `SELECT request_hash AS requestHash, status,
                  provider_message_id AS providerMessageId,
                  conversation_id AS conversationId
           FROM send_commands WHERE idempotency_key = ? LIMIT 1`,
        )
        .bind(idempotencyKey)
        .first<SendCommandRow>();
      if (!existing) return jsonError(409, "send_command_conflict");
      if (existing.requestHash !== requestHash) {
        return jsonError(409, "idempotency_key_reused");
      }
      if (existing.status === "sent") {
        await reconcileMailgunEventsBestEffort(
          db,
          existing.providerMessageId,
        );
        return Response.json({
          accepted: true,
          idempotent: true,
          providerMessageId: existing.providerMessageId,
          conversationId: existing.conversationId,
        });
      }
      if (existing.status === "pending") {
        return jsonError(409, "send_command_in_progress");
      }
      return jsonError(502, "send_command_failed");
    }

    const result = await sendMailgunMessage(
      {
        fromAddress: command.mailbox.address,
        fromName: command.mailbox.displayName,
        to: command.to,
        subject: command.subject,
        text: command.text,
        html: command.html,
        inReplyTo: conversation?.externalMessageId,
        references: conversation?.externalMessageId
          ? [conversation.externalMessageId]
          : undefined,
      },
      mailgunConfig(),
    );

    const externalMessageId = normalizeMessageId(result.id);
    const occurredAt = new Date().toISOString();
    const conversationId =
      conversation?.id ??
      (await createOutboundConversation(
        db,
        command.mailbox,
        command.to[0],
        command.subject,
        externalMessageId,
        occurredAt,
      ));

    await db.batch([
      db
        .prepare(
          `INSERT OR IGNORE INTO messages
            (id, conversation_id, mailbox_id, direction, external_message_id,
             sender, recipients_json, subject, text_body, html_body, status, occurred_at)
           VALUES (?, ?, ?, 'outbound', ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .bind(
          crypto.randomUUID(),
          conversationId,
          command.mailbox.id,
          externalMessageId,
          command.mailbox.address,
          JSON.stringify(command.to),
          command.subject,
          command.text,
          command.html,
          occurredAt,
        ),
      db
        .prepare(
          `UPDATE conversations
           SET is_unread = 0, last_message_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(occurredAt, conversationId),
      db
        .prepare(
          `UPDATE send_commands
           SET status = 'sent', provider_message_id = ?, response_status = 200,
               conversation_id = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(externalMessageId, conversationId, commandId),
      db
        .prepare(
          `INSERT INTO audit_entries
            (id, actor_email, action, entity_type, entity_id, details_json)
           VALUES (?, ?, 'message.sent', 'conversation', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          auth.operator.email,
          conversationId,
          JSON.stringify({ mailboxId: command.mailbox.id }),
        ),
    ]);

    // A provider callback can arrive before this outbound row is committed.
    // Link any such callback by Mailgun message ID and apply its latest state.
    await reconcileMailgunEventsBestEffort(db, externalMessageId);

    return Response.json(
      {
        accepted: true,
        providerMessageId: externalMessageId,
        conversationId,
      },
      { status: 202 },
    );
  } catch {
    try {
      await db
        .prepare(
          `UPDATE send_commands
           SET status = 'failed', response_status = 502,
               failure_code = 'transport_failure', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'pending'`,
        )
        .bind(commandId)
        .run();
    } catch {
      // Preserve the original generic failure without exposing runtime details.
    }
    return jsonError(502, "mailgun_send_failed");
  }
}

function parseSendCommand(payload: Record<string, unknown>) {
  const mailboxValue =
    typeof payload.mailbox === "string"
      ? payload.mailbox.trim()
      : typeof payload.from === "string"
        ? payload.from.trim()
        : "";
  const mailbox =
    CRM_MAILBOXES.find((candidate) => candidate.id === mailboxValue) ??
    mailboxForAddress(mailboxValue);
  if (!mailbox) return null;

  const recipientValues = Array.isArray(payload.to)
    ? payload.to
    : typeof payload.to === "string"
      ? parseAddressList(payload.to)
      : [];
  const to = recipientValues
    .map((value) =>
      typeof value === "string" ? extractEmailAddress(value) : null,
    )
    .filter((value): value is string => Boolean(value));
  if (to.length === 0 || to.length > 20) return null;

  const subject =
    typeof payload.subject === "string"
      ? payload.subject.replace(/[\r\n]+/gu, " ").trim()
      : "";
  const text =
    typeof payload.text === "string"
      ? payload.text.trim()
      : typeof payload.body === "string"
        ? payload.body.trim()
        : null;
  const html = typeof payload.html === "string" ? payload.html.trim() : null;
  const conversationId =
    typeof payload.conversationId === "string" &&
    /^[a-zA-Z0-9_-]{1,128}$/u.test(payload.conversationId)
      ? payload.conversationId
      : null;
  if (
    !subject ||
    subject.length > 500 ||
    (!text && !html) ||
    (text?.length ?? 0) > 2_000_000 ||
    (html?.length ?? 0) > 2_000_000 ||
    (payload.conversationId !== undefined && !conversationId)
  ) {
    return null;
  }

  return { mailbox, to, subject, text, html, conversationId };
}

function mailgunConfig() {
  const apiBase = runtimeString("MAILGUN_API_BASE") ?? "https://api.mailgun.net";
  const url = new URL(apiBase);
  if (
    url.protocol !== "https:" ||
    !["api.mailgun.net", "api.eu.mailgun.net"].includes(url.hostname)
  ) {
    throw new Error("MAILGUN_API_BASE is invalid.");
  }
  const domain = requireRuntimeString("MAILGUN_DOMAIN").toLowerCase();
  if (domain !== "27pm.org") throw new Error("MAILGUN_DOMAIN is invalid.");
  return {
    apiBase: url.origin,
    domain,
    sendingKey: requireRuntimeString("MAILGUN_SENDING_KEY"),
  };
}

async function createOutboundConversation(
  db: ReturnType<typeof crmDatabase>,
  mailbox: (typeof CRM_MAILBOXES)[number],
  recipient: string,
  subject: string,
  externalMessageId: string | null,
  occurredAt: string,
): Promise<string> {
  const contactCandidateId = crypto.randomUUID();
  await db
    .prepare("INSERT OR IGNORE INTO contacts (id, email) VALUES (?, ?)")
    .bind(contactCandidateId, recipient)
    .run();
  const contact = await db
    .prepare("SELECT id FROM contacts WHERE email = ? LIMIT 1")
    .bind(recipient)
    .first<{ id: string }>();
  if (!contact) throw new Error("contact_create_failed");

  const conversationId = crypto.randomUUID();
  const threadKey = externalMessageId
    ? `message:${externalMessageId}`
    : `outbound:${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO conversations
        (id, mailbox_id, contact_id, subject, normalized_subject, thread_key,
         is_unread, last_message_at)
       VALUES (?, ?, ?, ?, lower(trim(?)), ?, 0, ?)`,
    )
    .bind(
      conversationId,
      mailbox.id,
      contact.id,
      subject,
      subject,
      threadKey,
      occurredAt,
    )
    .run();
  if (mailbox.purpose === "sales") {
    await db
      .prepare(
        "INSERT INTO deals (id, conversation_id, stage) VALUES (?, ?, 'new')",
      )
      .bind(crypto.randomUUID(), conversationId)
      .run();
  }
  return conversationId;
}
