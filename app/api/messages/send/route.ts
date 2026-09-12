import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import {
  advanceSendAuthorization,
  canEmail,
  complianceEvidenceSnapshot,
  loadComplianceConfiguration,
  loadContactCompliance,
  type ContactCompliance,
  UNSUBSCRIBE_TOKEN_VALIDITY_MS,
} from "@/lib/compliance";
import { jsonError, readJsonObject } from "@/lib/http";
import { sendMailgunMessage } from "@/lib/mailgun-client";
import { mailgunConfig } from "@/lib/mailgun-runtime";
import { reconcileMailgunEventsBestEffort } from "@/lib/mailgun-event-reconciliation";
import { classifyMailgunFailure } from "@/lib/mailgun-send-outcome";
import {
  normalizeCommandIdempotencyKey,
  requestFingerprint,
} from "@/lib/mailgun";
import {
  CRM_MAILBOXES,
  extractEmailAddress,
  mailboxForAddress,
  parseAddressList,
} from "@/lib/mailboxes";
import { requireRuntimeString, runtimeString } from "@/lib/runtime";
import { appendComplianceFooter, createUnsubscribeToken, validUnsubscribeSecret } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

type SendCommandRow = {
  requestHash: string;
  status: "pending" | "authorized" | "dispatching" | "sent" | "failed" | "cancelled";
  providerMessageId: string | null;
  conversationId: string | null;
  crmRecorded: number | boolean;
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
  if (payload.complianceConfirmed !== true) return jsonError(409, "operator_compliance_confirmation_required");

  const requestHash = await requestFingerprint({
    mailboxId: command.mailbox.id,
    to: command.to,
    subject: command.subject,
    text: command.text,
    html: command.html,
    conversationId: command.conversationId,
  });
  const db = crmDatabase();
  const commandId = crypto.randomUUID();
  let conversation: {
    id: string;
    mailboxId: string;
    contactEmail: string | null;
    externalMessageId: string | null;
  } | null = null;
  let contact: ContactCompliance | null = null;
  let providerDispatchStarted = false;
  let providerAccepted = false;
  let providerMessageId: string | null = null;
  let recordedConversationId: string | null = null;

  try {
    if (command.conversationId) {
      conversation = await db
        .prepare(
          `SELECT c.id, c.mailbox_id AS mailboxId, contact.email AS contactEmail,
                  (SELECT m.external_message_id FROM messages m
                    WHERE m.conversation_id = c.id AND m.external_message_id IS NOT NULL
                    ORDER BY m.occurred_at DESC LIMIT 1) AS externalMessageId
           FROM conversations c
           LEFT JOIN contacts contact ON contact.id = c.contact_id
           WHERE c.id = ? LIMIT 1`,
        )
        .bind(command.conversationId)
        .first();
      if (!conversation) return jsonError(404, "conversation_not_found");
      if (conversation.mailboxId !== command.mailbox.id) {
        return jsonError(409, "conversation_mailbox_mismatch");
      }
      if (
        !conversation.contactEmail ||
        command.to.length !== 1 ||
        command.to[0] !== conversation.contactEmail
      ) {
        return jsonError(409, "conversation_recipient_mismatch");
      }
    }

    // Every operator-composed CRM message is treated as prospecting. Choosing
    // another mailbox must never bypass a category suppression.
    const suppressionCategory = "prospecting";
    contact = await loadContactCompliance(db, "email", command.to[0], suppressionCategory);
    if (!contact) return jsonError(409, "recipient_not_qualified");
    const unsubscribeSecret = runtimeString("CRM_UNSUBSCRIBE_SIGNING_KEY");
    const configuration = await loadComplianceConfiguration(db);
    configuration.unsubscribeSigningKeyConfigured = validUnsubscribeSecret(unsubscribeSecret);
    const complianceDecision = canEmail(contact, configuration);
    if (!complianceDecision.allowed) return jsonError(409, complianceDecision.reasons[0] ?? "recipient_not_qualified", complianceDecision.reasons.join(","));
    const authorizationSnapshot = { decision: complianceDecision, evidence: complianceEvidenceSnapshot(contact, configuration) };

    const inserted = await db
      .prepare(
        `INSERT OR IGNORE INTO send_commands
          (id, idempotency_key, request_hash, mailbox_id, conversation_id, status,
           contact_id, contact_compliance_version, configuration_version,
           operator_confirmed_at, compliance_snapshot_json)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .bind(
        commandId,
        idempotencyKey,
        requestHash,
        command.mailbox.id,
        command.conversationId,
        contact.contactId,
        contact.complianceVersion,
        configuration.version,
        new Date().toISOString(),
        JSON.stringify(authorizationSnapshot),
      )
      .run();

    if (changedRows(inserted) === 0) {
      const existing = await db
        .prepare(
          `SELECT request_hash AS requestHash, status,
                  provider_message_id AS providerMessageId,
                  conversation_id AS conversationId,
                  EXISTS (
                    SELECT 1 FROM messages message
                    WHERE message.external_message_id = send_commands.provider_message_id
                  ) AS crmRecorded
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
          crmRecorded: Boolean(existing.crmRecorded),
        });
      }
      if (existing.status === "pending") {
        return jsonError(409, "send_command_in_progress");
      }
      if (existing.status === "authorized" || existing.status === "dispatching") return jsonError(409, "send_command_in_progress");
      if (existing.status === "cancelled") return jsonError(409, "send_command_cancelled");
      return jsonError(502, "send_command_failed");
    }

    const authorized = await advanceSendAuthorization(db, commandId, contact, configuration, "pending", "authorized", authorizationSnapshot, auth.operator.email, suppressionCategory);
    if (!authorized) {
      await cancelSendCommand(db, commandId, "compliance_state_changed");
      return jsonError(409, "compliance_state_changed");
    }
    const publicOrigin = new URL(requireRuntimeString("CRM_PUBLIC_ORIGIN"));
    if (publicOrigin.protocol !== "https:") {
      await cancelSendCommand(db, commandId, "unsubscribe_origin_invalid");
      return jsonError(503, "unsubscribe_origin_invalid");
    }
    const expiresAt = new Date(Date.now() + UNSUBSCRIBE_TOKEN_VALIDITY_MS).toISOString();
    const unsubscribeToken = await createUnsubscribeToken(requireRuntimeString("CRM_UNSUBSCRIBE_SIGNING_KEY"), {
      contactId: contact.contactId,
      email: contact.addressNormalized,
      expiresAt,
    });
    const unsubscribeUrl = new URL("/api/public/unsubscribe", publicOrigin);
    unsubscribeUrl.searchParams.set("token", unsubscribeToken);
    const compliantContent = appendComplianceFooter(command.text, command.html, configuration, unsubscribeUrl.toString());
    const dispatching = await advanceSendAuthorization(db, commandId, contact, configuration, "authorized", "dispatching", authorizationSnapshot, auth.operator.email, suppressionCategory);
    if (!dispatching) {
      await cancelSendCommand(db, commandId, "compliance_state_changed");
      return jsonError(409, "compliance_state_changed");
    }

    const config = mailgunConfig();
    const result = await sendMailgunMessage(
      {
        fromAddress: command.mailbox.address,
        fromName: command.mailbox.displayName,
        to: command.to,
        subject: command.subject,
        text: compliantContent.text,
        html: compliantContent.html,
        inReplyTo: conversation?.externalMessageId,
        references: conversation?.externalMessageId
          ? [conversation.externalMessageId]
          : undefined,
        replyTo: command.mailbox.address,
        unsubscribeUrl: unsubscribeUrl.toString(),
      },
      config,
      {
        onDispatchStart: () => {
          providerDispatchStarted = true;
        },
      },
    );

    providerMessageId = result.id;
    providerAccepted = true;
    const acceptanceRecorded = await db
      .prepare(
        `UPDATE send_commands
         SET status = 'sent', provider_message_id = ?, response_status = 200,
             failure_code = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'dispatching'`,
      )
      .bind(providerMessageId, commandId)
      .run();
    if (changedRows(acceptanceRecorded) !== 1) {
      throw new Error("provider_acceptance_persistence_failed");
    }

    const occurredAt = new Date().toISOString();
    recordedConversationId =
      conversation?.id ??
      (await createOutboundConversation(
        db,
        command.mailbox,
        command.to[0],
        command.subject,
        providerMessageId,
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
          recordedConversationId,
          command.mailbox.id,
          providerMessageId,
          command.mailbox.address,
          JSON.stringify(command.to),
          command.subject,
          compliantContent.text,
          compliantContent.html,
          occurredAt,
        ),
      db
        .prepare(
          `UPDATE conversations
           SET is_unread = 0, last_message_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
        )
        .bind(occurredAt, recordedConversationId),
      db
        .prepare(
          `UPDATE send_commands
           SET conversation_id = ?, failure_code = NULL,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status = 'sent'`,
        )
        .bind(recordedConversationId, commandId),
      db
        .prepare(
          `INSERT INTO audit_entries
            (id, actor_email, action, entity_type, entity_id, details_json)
           VALUES (?, ?, 'message.sent', 'conversation', ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          auth.operator.email,
          recordedConversationId,
          JSON.stringify({ mailboxId: command.mailbox.id }),
        ),
      db
        .prepare(
          `UPDATE contacts
           SET last_contact_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = (SELECT contact_id FROM conversations WHERE id = ?)`,
        )
        .bind(occurredAt, recordedConversationId),
      db
        .prepare(
          `UPDATE organizations
           SET last_contact_at = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = (
             SELECT COALESCE(deal.organization_id, contact.organization_id)
             FROM conversations conversation
             LEFT JOIN deals deal ON deal.conversation_id = conversation.id
             LEFT JOIN contacts contact ON contact.id = conversation.contact_id
             WHERE conversation.id = ? LIMIT 1
           )`,
        )
        .bind(occurredAt, recordedConversationId),
    ]);

    // A provider callback can arrive before this outbound row is committed.
    // Link any such callback by Mailgun message ID and apply its latest state.
    await reconcileMailgunEventsBestEffort(db, providerMessageId);

    return Response.json(
      {
        accepted: true,
        providerMessageId,
        conversationId: recordedConversationId,
        crmRecorded: true,
      },
      { status: 202 },
    );
  } catch (cause: unknown) {
    if (providerAccepted) {
      try {
        await db
          .prepare(
            `UPDATE send_commands
             SET status = 'sent', provider_message_id = COALESCE(?, provider_message_id),
                 response_status = 200,
                 failure_code = 'post_acceptance_persistence_failure',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status IN ('dispatching','sent')`,
          )
          .bind(providerMessageId, commandId)
          .run();
      } catch {
        // Mailgun accepted the message; never turn a D1 outage into a retry signal.
      }
      return Response.json(
        {
          accepted: true,
          providerMessageId,
          conversationId: recordedConversationId,
          crmRecorded: false,
        },
        { status: 202 },
      );
    }

    if (
      classifyMailgunFailure(providerDispatchStarted, cause) ===
      "outcome_unknown"
    ) {
      try {
        await db
          .prepare(
            `UPDATE send_commands
             SET response_status = 503,
                 failure_code = 'transport_outcome_unknown',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status = 'dispatching'`,
          )
          .bind(commandId)
          .run();
      } catch {
        // Keep the durable dispatching state non-retryable when D1 is unavailable.
      }
      return jsonError(503, "mailgun_send_unconfirmed");
    }

    try {
      await db
        .prepare(
          `UPDATE send_commands
           SET status = 'failed', response_status = 502,
               failure_code = 'transport_failure', updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND status IN ('pending','authorized','dispatching')`,
        )
        .bind(commandId)
        .run();
    } catch {
      // Preserve the original generic failure without exposing runtime details.
    }
    return jsonError(502, "mailgun_send_failed");
  }
}

async function cancelSendCommand(db: ReturnType<typeof crmDatabase>, commandId: string, reason: string) {
  await db.prepare(`UPDATE send_commands SET status='cancelled', failure_code=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status IN ('pending','authorized')`).bind(reason, commandId).run();
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
  if (!mailbox || mailbox.purpose !== "sales") return null;

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
  if (to.length !== 1) return null;

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

async function createOutboundConversation(
  db: ReturnType<typeof crmDatabase>,
  mailbox: (typeof CRM_MAILBOXES)[number],
  recipient: string,
  subject: string,
  externalMessageId: string | null,
  occurredAt: string,
): Promise<string> {
  const contact = await db
    .prepare("SELECT id, organization_id AS organizationId FROM contacts WHERE email = ? LIMIT 1")
    .bind(recipient)
    .first<{ id: string; organizationId: string | null }>();
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
        "INSERT INTO deals (id, conversation_id, organization_id, contact_id, stage) VALUES (?, ?, ?, ?, 'new')",
      )
      .bind(crypto.randomUUID(), conversationId, contact.organizationId, contact.id)
      .run();
  }
  return conversationId;
}
