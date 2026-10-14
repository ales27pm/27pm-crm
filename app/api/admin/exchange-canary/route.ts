import { requireSameOriginOperatorJsonRequest } from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import {
  DELIVERABILITY_CANARY_RECIPIENT,
  DELIVERABILITY_CANARY_SENDER,
  deliverabilityCanaryApprovalDigest,
  deliverabilityCanaryTransmittedText,
  parseDeliverabilityCanaryContent,
  resolveDeliverabilityCanaryRecipient,
} from "@/lib/deliverability-canary";
import {
  recordExchangeDeliverabilityCanaryResult,
  reserveExchangeDeliverabilityCanary,
  type ExchangeCanaryReservation,
} from "@/lib/exchange-deliverability-canary";
import { sendApprovedExchangeMessage } from "@/lib/exchange-outbound";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";
import { classifyOutboundFailure } from "@/lib/outbound-send-outcome";
import { requireOutboundOperationalConfig } from "@/lib/outbound-runtime";
import { requireRuntimeString, runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireSameOriginOperatorJsonRequest(
    request,
    "request_body_invalid",
  );
  if (auth.response) return auth.response;
  const { payload } = auth;
  if (payload.confirmed !== true) {
    return privateJsonError(409, "operator_confirmation_required");
  }
  const content = parseDeliverabilityCanaryContent(payload);
  if (!content) return privateJsonError(400, "canary_content_invalid");

  let recipient: string;
  let approvalDigest: string;
  let exchange: Extract<
    ReturnType<typeof requireOutboundOperationalConfig>,
    { provider: "exchange" }
  >;
  try {
    const configuredRecipient = requireRuntimeString("CRM_CANARY_RECIPIENT");
    const resolved = resolveDeliverabilityCanaryRecipient(
      payload.to,
      configuredRecipient,
      runtimeString("CRM_CANARY_OUTLOOK_RECIPIENT"),
    );
    if (!resolved) {
      return privateJsonError(409, "canary_recipient_invalid");
    }
    recipient = resolved;
    approvalDigest = await deliverabilityCanaryApprovalDigest({
      recipient,
      subject: content.subject,
      text: content.text,
    });
    if (recipient !== DELIVERABILITY_CANARY_RECIPIENT) {
      const configuredApproval = runtimeString(
        "CRM_CANARY_OUTLOOK_APPROVAL_SHA256",
      );
      if (!configuredApproval ||
          !/^[a-f0-9]{64}$/u.test(configuredApproval) ||
          configuredApproval !== approvalDigest) {
        return privateJsonError(409, "canary_approval_mismatch");
      }
    }
    const transport = requireOutboundOperationalConfig();
    if (transport.provider !== "exchange") {
      return privateJsonError(409, "exchange_canary_provider_inactive");
    }
    exchange = transport;
  } catch {
    return privateJsonError(503, "canary_configuration_invalid");
  }

  const canaryId = crypto.randomUUID();
  const commandId = crypto.randomUUID();
  const sentAt = new Date().toISOString();
  const transmittedText = deliverabilityCanaryTransmittedText(
    content.text,
    canaryId,
    sentAt,
  );
  const reservation: ExchangeCanaryReservation = {
    approvalDigest,
    canaryId,
    commandId,
    operator: auth.operator.email,
    recipient,
    subject: content.subject,
    text: transmittedText,
    sentAt,
  };
  const db = crmDatabase();
  try {
    const reserved = await reserveExchangeDeliverabilityCanary(
      db,
      reservation,
    );
    if (!reserved) {
      return privateJsonError(409, "canary_already_attempted");
    }
  } catch {
    return privateJsonError(503, "canary_reservation_unconfirmed");
  }

  let dispatchStarted = false;
  try {
    const result = await sendApprovedExchangeMessage(
      db,
      exchange.config,
      {
        commandId,
        fromAddress: DELIVERABILITY_CANARY_SENDER,
        fromName: "Alexis Boulet — 27PM",
        to: [recipient],
        subject: content.subject,
        text: transmittedText,
        replyTo: DELIVERABILITY_CANARY_SENDER,
      },
      { onDispatchStart: () => { dispatchStarted = true; } },
    );
    try {
      await recordExchangeDeliverabilityCanaryResult(db, {
        ...reservation,
        result: {
          outcome: "accepted",
          providerMessageId: result.providerMessageId,
          providerConversationId: result.providerConversationId,
        },
      });
    } catch {
      console.error("exchange_canary_result_record_failed", {
        canaryId,
        commandId,
      });
    }
    console.info("exchange_canary_accepted", {
      canaryId,
      commandId,
      providerMessageId: result.providerMessageId,
      operator: auth.operator.email,
    });
    return Response.json(
      {
        accepted: true,
        provider: "exchange",
        canaryId,
        commandId,
        providerMessageId: result.providerMessageId,
        recipient,
        subject: content.subject,
      },
      { status: 202, headers: privateNoStoreHeaders() },
    );
  } catch (cause: unknown) {
    const outcome = classifyOutboundFailure(dispatchStarted, cause);
    const result = outcome === "outcome_unknown"
      ? { outcome: "unconfirmed" as const }
      : { outcome: "failed" as const };
    try {
      await recordExchangeDeliverabilityCanaryResult(db, {
        ...reservation,
        result,
      });
    } catch {
      console.error("exchange_canary_result_record_failed", {
        canaryId,
        commandId,
      });
    }
    return outcome === "outcome_unknown"
      ? privateJsonError(503, "canary_send_unconfirmed")
      : privateJsonError(502, "canary_send_failed");
  }
}
