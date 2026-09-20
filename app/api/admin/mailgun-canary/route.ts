import { requireSameOriginOperatorJsonRequest } from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import {
  privateJsonError,
  privateNoStoreHeaders,
} from "@/lib/http";
import { sendMailgunMessage } from "@/lib/mailgun-client";
import { mailgunConfig } from "@/lib/mailgun-runtime";
import { classifyMailgunFailure } from "@/lib/mailgun-send-outcome";
import { requireRuntimeString, runtimeString } from "@/lib/runtime";
import {
  DELIVERABILITY_CANARY_RECIPIENT,
  DELIVERABILITY_CANARY_SENDER,
  deliverabilityCanaryApprovalDigest,
  deliverabilityCanaryTransmittedText,
  parseDeliverabilityCanaryContent,
  resolveDeliverabilityCanaryRecipient,
} from "@/lib/deliverability-canary";
import {
  recordDeliverabilityCanaryResult,
  reserveDeliverabilityCanary,
} from "@/lib/deliverability-canary-ledger";

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
  let config: ReturnType<typeof mailgunConfig>;
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
      const configuredApproval = runtimeString("CRM_CANARY_OUTLOOK_APPROVAL_SHA256");
      if (!configuredApproval ||
        !/^[a-f0-9]{64}$/u.test(configuredApproval) ||
        configuredApproval !== approvalDigest) {
        return privateJsonError(409, "canary_approval_mismatch");
      }
    }
    config = mailgunConfig();
  } catch {
    return privateJsonError(503, "canary_configuration_invalid");
  }

  const canaryId = crypto.randomUUID();
  const sentAt = new Date().toISOString();
  let db: ReturnType<typeof crmDatabase>;
  try {
    db = crmDatabase();
    const reserved = await reserveDeliverabilityCanary(db, {
      approvalDigest,
      canaryId,
      operator: auth.operator.email,
      recipient,
      subject: content.subject,
      sentAt,
    });
    if (!reserved) return privateJsonError(409, "canary_already_attempted");
  } catch {
    // A lost D1 acknowledgement may have committed the reservation. Never
    // dispatch or retry automatically when that boundary is uncertain.
    return privateJsonError(503, "canary_reservation_unconfirmed");
  }

  let dispatchStarted = false;
  let result: Awaited<ReturnType<typeof sendMailgunMessage>>;
  try {
    result = await sendMailgunMessage(
      {
        fromAddress: DELIVERABILITY_CANARY_SENDER,
        fromName: "Alexis Boulet — 27PM",
        to: [recipient],
        subject: content.subject,
        text: deliverabilityCanaryTransmittedText(content.text, canaryId, sentAt),
        replyTo: DELIVERABILITY_CANARY_SENDER,
      },
      config,
      { onDispatchStart: () => { dispatchStarted = true; } },
    );
  } catch (cause: unknown) {
    const failure = classifyMailgunFailure(dispatchStarted, cause);
    try {
      await recordDeliverabilityCanaryResult(db, {
        approvalDigest,
        canaryId,
        operator: auth.operator.email,
        result: failure === "outcome_unknown" ? "unconfirmed" : "failed",
      });
    } catch {
      console.error("mailgun_canary_result_record_failed", { canaryId });
    }
    if (failure === "outcome_unknown") {
      return privateJsonError(503, "canary_send_unconfirmed");
    }
    return privateJsonError(502, "canary_send_failed");
  }

  try {
    await recordDeliverabilityCanaryResult(db, {
      approvalDigest,
      canaryId,
      operator: auth.operator.email,
      result: "accepted",
      providerMessageId: result.id,
    });
  } catch {
    // Mailgun acceptance is known even when the local result event fails.
    // The immutable reservation still prevents a second provider dispatch.
    console.error("mailgun_canary_result_record_failed", { canaryId });
  }
  console.info("mailgun_canary_accepted", {
    canaryId,
    providerMessageId: result.id,
    operator: auth.operator.email,
  });
  return Response.json(
    {
      accepted: true,
      canaryId,
      providerMessageId: result.id,
      recipient,
      subject: content.subject,
    },
    { status: 202, headers: privateNoStoreHeaders() },
  );
}
