import { requireOperatorRequest } from "@/lib/api-auth";
import { sendMailgunMessage } from "@/lib/mailgun-client";
import { mailgunConfig } from "@/lib/mailgun-runtime";
import { classifyMailgunFailure } from "@/lib/mailgun-send-outcome";
import { normalizeEmailAddress } from "@/lib/mailboxes";
import { requireRuntimeString, runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const CANARY_FROM = "alexis@27pm.org";
const CANARY_SUBJECT = "Test DKIM 2048 — 27PM";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  const technicalTriggerAuthorized = auth.response
    ? await hasValidTechnicalTrigger(request)
    : false;
  if (auth.response && !technicalTriggerAuthorized) return auth.response;
  const actor = auth.response ? "technical-canary" : auth.operator.email;
  if (!isSameOriginBrowserRequest(request)) {
    return canaryError(403, "cross_origin_request_forbidden");
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch {
    return canaryError(400, "request_body_invalid");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as Record<string, unknown>).confirmed !== true
  ) {
    return canaryError(409, "operator_confirmation_required");
  }

  const canaryId = crypto.randomUUID();
  const sentAt = new Date().toISOString();
  let dispatchStarted = false;

  try {
    const configuredRecipient = requireRuntimeString("CRM_CANARY_RECIPIENT");
    const recipient = normalizeEmailAddress(configuredRecipient);
    if (!recipient || recipient !== configuredRecipient) {
      return canaryError(503, "canary_recipient_invalid");
    }

    const result = await sendMailgunMessage(
      {
        fromAddress: CANARY_FROM,
        fromName: "Alexis Boulet — 27PM",
        to: [recipient],
        subject: CANARY_SUBJECT,
        text: [
          "Test administratif de délivrabilité 27PM.",
          "",
          `Identifiant : ${canaryId}`,
          `Envoyé à : ${sentAt}`,
          "",
          "Aucune action n’est requise.",
        ].join("\n"),
        replyTo: CANARY_FROM,
      },
      mailgunConfig(),
      { onDispatchStart: () => { dispatchStarted = true; } },
    );

    console.info("mailgun_canary_accepted", {
      canaryId,
      providerMessageId: result.id,
      operator: actor,
    });
    return Response.json(
      {
        accepted: true,
        canaryId,
        providerMessageId: result.id,
        subject: CANARY_SUBJECT,
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

async function hasValidTechnicalTrigger(request: Request): Promise<boolean> {
  const configuredToken = runtimeString("CRM_CANARY_TRIGGER_TOKEN");
  const authorization = request.headers.get("authorization");
  if (!configuredToken || !authorization?.startsWith("Bearer ")) return false;

  const suppliedToken = authorization.slice("Bearer ".length);
  if (!suppliedToken || suppliedToken.length !== configuredToken.length) return false;

  const [suppliedDigest, configuredDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(suppliedToken)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(configuredToken)),
  ]);
  const supplied = new Uint8Array(suppliedDigest);
  const configured = new Uint8Array(configuredDigest);
  let difference = 0;
  for (let index = 0; index < supplied.length; index += 1) {
    difference |= supplied[index] ^ configured[index];
  }
  return difference === 0;
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
