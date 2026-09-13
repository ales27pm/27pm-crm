import { requireOperatorRequest } from "@/lib/api-auth";
import { changedRows, crmDatabase } from "@/lib/d1";
import {
  advanceSendAuthorization,
  canEmail,
  complianceEvidenceSnapshot,
  type ComplianceConfiguration,
  loadComplianceConfiguration,
  loadContactCompliance,
  type ContactCompliance,
  UNSUBSCRIBE_TOKEN_VALIDITY_MS,
} from "@/lib/compliance";
import { recordAcceptedOutboundMessage } from "@/lib/accepted-outbound-message";
import { cakemailAudiencePolicyViolation } from "@/lib/cakemail-audience-policy";
import { jsonError, readJsonObject } from "@/lib/http";
import {
  normalizeCommandIdempotencyKey,
  requestFingerprint,
} from "@/lib/mailgun";
import { extractEmailAddress, parseAddressList } from "@/lib/mailboxes";
import {
  createOutboundExternalMessageId,
  outboundTransmittedContent,
  sendOutboundMessage,
} from "@/lib/outbound-email";
import {
  outboundMessageSnapshotJson,
  parseOutboundMessageSnapshot,
  type OutboundMessageSnapshot,
} from "@/lib/outbound-message-snapshot";
import { reconcileOutboundEventsBestEffort } from "@/lib/outbound-event-reconciliation";
import {
  requireOutboundOperationalConfig,
  type OutboundProvider,
  type OutboundTransportConfig,
} from "@/lib/outbound-runtime";
import { classifyOutboundFailure } from "@/lib/outbound-send-outcome";
import {
  sendContentFromPayload,
  sendMailboxFromPayload,
} from "@/lib/send-payload";
import { requireRuntimeString, runtimeString } from "@/lib/runtime";
import { appendComplianceFooter, createUnsubscribeToken, validUnsubscribeSecret } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

const CRM_PROSPECTING_TAGS = ["source-crm", "traffic-prospecting"] as const;

type SendCommandRow = {
  commandId: string;
  requestHash: string;
  status: "pending" | "authorized" | "dispatching" | "sent" | "failed" | "cancelled";
  transportProvider: OutboundProvider;
  contactId: string | null;
  providerMessageId: string | null;
  externalMessageId: string | null;
  conversationId: string | null;
  crmRecorded: number | boolean;
  messageSnapshotJson: string | null;
};

type ParsedSendCommand = NonNullable<ReturnType<typeof parseSendCommand>>;

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
  try {
    const existing = await loadSendCommand(db, idempotencyKey);
    if (existing) {
      return responseForExistingSendCommand(
        db,
        existing,
        requestHash,
        command,
      );
    }
  } catch {
    return jsonError(503, "send_command_lookup_failed");
  }

  let transport: OutboundTransportConfig;
  try {
    transport = requireOutboundOperationalConfig();
  } catch {
    return jsonError(503, "transport_configuration_invalid");
  }
  const transportProvider = transport.provider;
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
  let providerResponseStatus: number | null = null;
  let externalMessageId: string | null = null;
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
          (id, transport_provider, idempotency_key, request_hash, mailbox_id, conversation_id, status,
           contact_id, contact_compliance_version, configuration_version,
           operator_confirmed_at, compliance_snapshot_json)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      )
      .bind(
        commandId,
        transportProvider,
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
      const existing = await loadSendCommand(db, idempotencyKey);
      if (!existing) return jsonError(409, "send_command_conflict");
      return responseForExistingSendCommand(
        db,
        existing,
        requestHash,
        command,
      );
    }

    const authorized = await advanceSendAuthorization(db, commandId, contact, configuration, "pending", "authorized", authorizationSnapshot, auth.operator.email, suppressionCategory);
    if (!authorized) {
      await cancelSendCommand(db, commandId, "compliance_state_changed");
      return jsonError(409, "compliance_state_changed");
    }
    let compliantContent;
    try {
      compliantContent = await compliantOutboundContent(
        command,
        contact,
        configuration,
      );
    } catch {
      await cancelSendCommand(db, commandId, "unsubscribe_origin_invalid");
      return jsonError(503, "unsubscribe_origin_invalid");
    }
    const dispatching = await advanceSendAuthorization(db, commandId, contact, configuration, "authorized", "dispatching", authorizationSnapshot, auth.operator.email, suppressionCategory);
    if (!dispatching) {
      await cancelSendCommand(db, commandId, "compliance_state_changed");
      return jsonError(409, "compliance_state_changed");
    }

    externalMessageId = createOutboundExternalMessageId(
      transport,
      command.mailbox.address,
    );
    const transmittedContent = outboundTransmittedContent(
      compliantContent,
      transport,
    );
    const occurredAt = new Date().toISOString();
    const messageSnapshotJson = outboundMessageSnapshotJson({
      version: 1,
      requestHash,
      provider: transportProvider,
      contactId: contact.contactId,
      mailbox: {
        id: command.mailbox.id,
        address: command.mailbox.address,
        purpose: command.mailbox.purpose,
      },
      recipient: command.to[0],
      subject: command.subject,
      contentMode: transmittedContent.contentMode,
      text: transmittedContent.text,
      html: transmittedContent.html,
      actorEmail: auth.operator.email,
      conversationId: conversation?.id ?? null,
      occurredAt,
    });
    const snapshotRecorded = await db
      .prepare(
        `UPDATE send_commands
         SET external_message_id = ?, message_snapshot_json = ?,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND transport_provider = ?
           AND status = 'dispatching' AND message_snapshot_json IS NULL`,
      )
      .bind(
        externalMessageId,
        messageSnapshotJson,
        commandId,
        transportProvider,
      )
      .run();
    if (changedRows(snapshotRecorded) !== 1) {
      throw new Error("outbound_snapshot_persistence_failed");
    }

    const audienceViolation = cakemailAudiencePolicyViolation(
      transport,
      contact,
    );
    if (audienceViolation) {
      await cancelSendCommand(db, commandId, audienceViolation);
      return jsonError(409, audienceViolation);
    }

    const result = await sendOutboundMessage(
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
        unsubscribeUrl: compliantContent.unsubscribeUrl,
        tags: CRM_PROSPECTING_TAGS,
      },
      transport,
      {
        externalMessageId,
        onDispatchStart: () => {
          providerDispatchStarted = true;
        },
      },
    );

    if (result.provider !== transportProvider) {
      throw new Error("transport_provider_mismatch");
    }
    providerMessageId = result.providerMessageId;
    externalMessageId = result.externalMessageId;
    providerResponseStatus = result.responseStatus;
    providerAccepted = true;
    const acceptanceRecorded = await db
      .prepare(
        `UPDATE send_commands
         SET status = 'sent', provider_message_id = ?, external_message_id = ?,
             response_status = ?,
             failure_code = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND transport_provider = ? AND status = 'dispatching'`,
      )
      .bind(
        providerMessageId,
        externalMessageId,
        providerResponseStatus,
        commandId,
        transportProvider,
      )
      .run();
    if (changedRows(acceptanceRecorded) !== 1) {
      throw new Error("provider_acceptance_persistence_failed");
    }

    recordedConversationId = await recordAcceptedOutboundMessage(db, {
      commandId,
      contactId: contact.contactId,
      provider: transportProvider,
      providerMessageId,
      externalMessageId,
      mailbox: command.mailbox,
      recipient: command.to[0],
      subject: command.subject,
      text: transmittedContent.text,
      html: transmittedContent.html,
      actorEmail: auth.operator.email,
      conversationId: conversation?.id,
      occurredAt,
    });

    // A provider callback can arrive before this outbound row is committed.
    // Link it using the transport-specific correlation contract.
    await reconcileOutboundEventsBestEffort(
      db,
      transportProvider,
      providerMessageId,
      externalMessageId,
    );

    return Response.json(
      {
        accepted: true,
        provider: transportProvider,
        providerMessageId,
        externalMessageId,
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
                 external_message_id = COALESCE(?, external_message_id),
                 response_status = COALESCE(?, response_status),
                 failure_code = 'post_acceptance_persistence_failure',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND transport_provider = ?
               AND status IN ('dispatching','sent')`,
          )
          .bind(
            providerMessageId,
            externalMessageId,
            providerResponseStatus,
            commandId,
            transportProvider,
          )
          .run();
      } catch {
        // The provider accepted the message; never turn a D1 outage into a
        // retry signal.
      }
      return Response.json(
        {
          accepted: true,
          provider: transportProvider,
          providerMessageId,
          externalMessageId,
          conversationId: recordedConversationId,
          crmRecorded: false,
        },
        { status: 202 },
      );
    }

    if (
      classifyOutboundFailure(providerDispatchStarted, cause) ===
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
      return jsonError(503, "outbound_send_unconfirmed");
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
    return jsonError(502, "outbound_send_failed");
  }
}

async function loadSendCommand(
  db: ReturnType<typeof crmDatabase>,
  idempotencyKey: string,
): Promise<SendCommandRow | null> {
  return db
    .prepare(
      `SELECT id AS commandId, request_hash AS requestHash, status,
              transport_provider AS transportProvider,
              contact_id AS contactId,
              provider_message_id AS providerMessageId,
              external_message_id AS externalMessageId,
              conversation_id AS conversationId,
              message_snapshot_json AS messageSnapshotJson,
              EXISTS (
                SELECT 1 FROM messages message
                WHERE message.transport_provider = send_commands.transport_provider
                  AND message.provider_message_id = send_commands.provider_message_id
              ) AS crmRecorded
       FROM send_commands WHERE idempotency_key = ? LIMIT 1`,
    )
    .bind(idempotencyKey)
    .first<SendCommandRow>();
}

async function responseForExistingSendCommand(
  db: ReturnType<typeof crmDatabase>,
  existing: SendCommandRow,
  requestHash: string,
  command: ParsedSendCommand,
): Promise<Response> {
  if (existing.requestHash !== requestHash) {
    return jsonError(409, "idempotency_key_reused");
  }
  if (existing.status === "sent") {
    return responseForAcceptedSendCommand(db, existing, command);
  }
  if (
    existing.status === "pending" ||
    existing.status === "authorized" ||
    existing.status === "dispatching"
  ) {
    return jsonError(409, "send_command_in_progress");
  }
  if (existing.status === "cancelled") {
    return jsonError(409, "send_command_cancelled");
  }
  return jsonError(502, "send_command_failed");
}

async function responseForAcceptedSendCommand(
  db: ReturnType<typeof crmDatabase>,
  existing: SendCommandRow,
  command: ParsedSendCommand,
): Promise<Response> {
  let crmRecorded = Boolean(existing.crmRecorded);
  let conversationId = existing.conversationId;
  const snapshot = parseOutboundMessageSnapshot(existing.messageSnapshotJson);
  if (
    !crmRecorded &&
    existing.providerMessageId &&
    existing.externalMessageId &&
    snapshot &&
    snapshotMatchesCommand(snapshot, existing, command)
  ) {
    try {
      conversationId = await recordAcceptedOutboundMessage(db, {
        commandId: existing.commandId,
        contactId: snapshot.contactId,
        provider: existing.transportProvider,
        providerMessageId: existing.providerMessageId,
        externalMessageId: existing.externalMessageId,
        mailbox: snapshot.mailbox,
        recipient: snapshot.recipient,
        subject: snapshot.subject,
        text: snapshot.text,
        html: snapshot.html,
        actorEmail: snapshot.actorEmail,
        conversationId: existing.conversationId ?? snapshot.conversationId,
        occurredAt: snapshot.occurredAt,
      });
      crmRecorded = true;
    } catch {
      // Provider acceptance is authoritative. The same key may safely retry
      // this local-only repair without redispatching the message.
    }
  }
  await reconcileOutboundEventsBestEffort(
    db,
    existing.transportProvider,
    existing.providerMessageId,
    existing.externalMessageId,
  );
  return Response.json({
    accepted: true,
    idempotent: true,
    provider: existing.transportProvider,
    providerMessageId: existing.providerMessageId,
    externalMessageId: existing.externalMessageId,
    conversationId,
    crmRecorded,
  });
}

function snapshotMatchesCommand(
  snapshot: OutboundMessageSnapshot,
  existing: SendCommandRow,
  command: ParsedSendCommand,
): boolean {
  return (
    snapshot.requestHash === existing.requestHash &&
    snapshot.provider === existing.transportProvider &&
    snapshot.contactId === existing.contactId &&
    snapshot.mailbox.id === command.mailbox.id &&
    snapshot.mailbox.address === command.mailbox.address &&
    snapshot.mailbox.purpose === command.mailbox.purpose &&
    snapshot.recipient === command.to[0] &&
    snapshot.subject === command.subject &&
    (existing.conversationId === null ||
      snapshot.conversationId === null ||
      existing.conversationId === snapshot.conversationId)
  );
}

async function cancelSendCommand(db: ReturnType<typeof crmDatabase>, commandId: string, reason: string) {
  await db.prepare(`UPDATE send_commands SET status='cancelled', failure_code=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status IN ('pending','authorized','dispatching')
      AND provider_message_id IS NULL`).bind(reason, commandId).run();
}

function parseSendCommand(payload: Record<string, unknown>) {
  const mailbox = salesMailbox(payload);
  if (!mailbox) return null;
  const recipient = singleSendRecipient(payload.to);
  if (!recipient) return null;

  const content = sendContentFromPayload(payload);
  const conversationId = validConversationId(content.conversationId);
  if (!validSendContent(payload, content, conversationId)) return null;

  return { mailbox, to: [recipient], ...content, conversationId };
}

function salesMailbox(payload: Record<string, unknown>) {
  const { mailbox } = sendMailboxFromPayload(payload);
  if (!mailbox || mailbox.purpose !== "sales") return null;
  return mailbox;
}

function singleSendRecipient(value: unknown): string | null {
  const recipients = recipientCandidates(value)
    .map(normalizedRecipient)
    .filter((recipient): recipient is string => recipient !== null);
  return recipients.length === 1 ? recipients[0] : null;
}

function recipientCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return parseAddressList(value);
  return [];
}

function normalizedRecipient(value: unknown): string | null {
  return typeof value === "string" ? extractEmailAddress(value) : null;
}

function validConversationId(value: string | null): string | null {
  return value !== null && /^[a-zA-Z0-9_-]{1,128}$/u.test(value) ? value : null;
}

function validSendContent(
  payload: Record<string, unknown>,
  content: ReturnType<typeof sendContentFromPayload>,
  conversationId: string | null,
): boolean {
  if (!validSubject(content.subject)) return false;
  if (!validBody(content.text, content.html)) return false;
  return payload.conversationId === undefined || conversationId !== null;
}

function validSubject(subject: string): boolean {
  return subject.length > 0 && subject.length <= 500;
}

function validBody(text: string | null, html: string | null): boolean {
  if (!hasBodyContent(text, html)) return false;
  if (!bodyWithinLimit(text)) return false;
  return bodyWithinLimit(html);
}

function hasBodyContent(text: string | null, html: string | null): boolean {
  return Boolean(text) || Boolean(html);
}

function bodyWithinLimit(value: string | null): boolean {
  return value === null || value.length <= 2_000_000;
}

async function compliantOutboundContent(
  command: NonNullable<ReturnType<typeof parseSendCommand>>,
  contact: ContactCompliance,
  configuration: ComplianceConfiguration,
): Promise<{ text: string; html: string; unsubscribeUrl: string }> {
  const publicOrigin = new URL(requireRuntimeString("CRM_PUBLIC_ORIGIN"));
  if (
    publicOrigin.protocol !== "https:" ||
    publicOrigin.username ||
    publicOrigin.password
  ) {
    throw new Error("unsubscribe_origin_invalid");
  }
  const expiresAt = new Date(
    Date.now() + UNSUBSCRIBE_TOKEN_VALIDITY_MS,
  ).toISOString();
  const unsubscribeToken = await createUnsubscribeToken(
    requireRuntimeString("CRM_UNSUBSCRIBE_SIGNING_KEY"),
    {
      contactId: contact.contactId,
      email: contact.addressNormalized,
      expiresAt,
    },
  );
  const unsubscribeUrl = new URL("/api/public/unsubscribe", publicOrigin.origin);
  unsubscribeUrl.searchParams.set("token", unsubscribeToken);
  return {
    ...appendComplianceFooter(
      command.text,
      command.html,
      configuration,
      unsubscribeUrl.toString(),
    ),
    unsubscribeUrl: unsubscribeUrl.toString(),
  };
}
