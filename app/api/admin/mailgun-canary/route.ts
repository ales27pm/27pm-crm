import { requireSameOriginOperatorJsonRequest } from "@/lib/api-auth";
import {
  privateJsonError,
  privateNoStoreHeaders,
} from "@/lib/http";
import { sendMailgunMessage } from "@/lib/mailgun-client";
import { mailgunConfig } from "@/lib/mailgun-runtime";
import { classifyMailgunFailure } from "@/lib/mailgun-send-outcome";
import { normalizeEmailAddress } from "@/lib/mailboxes";
import { requireRuntimeString } from "@/lib/runtime";
import {
  DELIVERABILITY_CANARY_RECIPIENT,
  DELIVERABILITY_CANARY_SENDER,
  DELIVERABILITY_CANARY_SUBJECT,
} from "@/lib/deliverability-canary";

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
  const content = parseCanaryContent(payload);
  if (!content) return privateJsonError(400, "canary_content_invalid");

  const canaryId = crypto.randomUUID();
  const sentAt = new Date().toISOString();
  let dispatchStarted = false;

  try {
    const configuredRecipient = requireRuntimeString("CRM_CANARY_RECIPIENT");
    const recipient = normalizeEmailAddress(configuredRecipient);
    if (
      !recipient ||
      recipient !== configuredRecipient ||
      recipient !== DELIVERABILITY_CANARY_RECIPIENT
    ) {
      return privateJsonError(503, "canary_recipient_invalid");
    }

    const result = await sendMailgunMessage(
      {
        fromAddress: DELIVERABILITY_CANARY_SENDER,
        fromName: "Alexis Boulet — 27PM",
        to: [recipient],
        subject: content.subject,
        text: [
          content.text,
          "",
          "— Test administratif de délivrabilité 27PM —",
          `Identifiant : ${canaryId}`,
          `Envoyé à : ${sentAt}`,
          "",
          "Aucune action n’est requise.",
        ].join("\n"),
        replyTo: DELIVERABILITY_CANARY_SENDER,
      },
      mailgunConfig(),
      { onDispatchStart: () => { dispatchStarted = true; } },
    );

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
        subject: content.subject,
      },
      { status: 202, headers: privateNoStoreHeaders() },
    );
  } catch (cause: unknown) {
    if (classifyMailgunFailure(dispatchStarted, cause) === "outcome_unknown") {
      return privateJsonError(503, "canary_send_unconfirmed");
    }
    return privateJsonError(502, "canary_send_failed");
  }
}

function parseCanaryContent(payload: Record<string, unknown>) {
  const subject =
    typeof payload.subject === "string"
      ? payload.subject.replace(/[\r\n]+/gu, " ").trim()
      : DELIVERABILITY_CANARY_SUBJECT;
  const text =
    typeof payload.text === "string"
      ? payload.text.trim()
      : "Test administratif de délivrabilité 27PM.";
  if (!subject || subject.length > 500 || !text || text.length > 20_000) {
    return null;
  }
  return { subject, text };
}
