import { requireOperatorRequest } from "@/lib/api-auth";
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
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  if (!isSameOriginBrowserRequest(request)) {
    return canaryError(403, "cross_origin_request_forbidden");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return canaryError(400, "request_body_invalid");
  }
  if (!payload || typeof payload !== "object") {
    return canaryError(400, "request_body_invalid");
  }
  const record = payload as Record<string, unknown>;
  if (record.confirmed !== true) {
    return canaryError(409, "operator_confirmation_required");
  }
  const content = parseCanaryContent(record);
  if (!content) return canaryError(400, "canary_content_invalid");

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
      return canaryError(503, "canary_recipient_invalid");
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
      { status: 202, headers: noStoreHeaders() },
    );
  } catch (cause: unknown) {
    if (classifyMailgunFailure(dispatchStarted, cause) === "outcome_unknown") {
      return canaryError(503, "canary_send_unconfirmed");
    }
    return canaryError(502, "canary_send_failed");
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

function isSameOriginBrowserRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function canaryError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders() });
}

function noStoreHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}
