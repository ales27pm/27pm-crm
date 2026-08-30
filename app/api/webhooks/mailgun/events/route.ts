import { crmDatabase } from "@/lib/d1";
import { boundedRequest } from "@/lib/bounded-request";
import { jsonError } from "@/lib/http";
import {
  eventCallbackKey,
  parseMailgunEventForm,
  parseMailgunEventJson,
  verifyMailgunSignature,
} from "@/lib/mailgun";
import { runtimeString } from "@/lib/runtime";
import { recordMailgunEvent } from "@/lib/mailgun-event-store";
import { hasWebhookToken, markWebhookProcessed, reserveWebhook } from "@/lib/webhook-receipts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const bounded = await boundedRequest(request, 1_000_000);
  if (!bounded) return jsonError(413, "webhook_too_large");
  request = bounded;
  let event;
  try {
    const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
    event = contentType.includes("application/json")
      ? parseMailgunEventJson(await request.json())
      : parseMailgunEventForm(await request.formData());
  } catch {
    return jsonError(400, "mailgun_payload_invalid");
  }

  const db = crmDatabase();
  const verification = await verifyMailgunSignature(event.signature, {
    secret: runtimeString("MAILGUN_WEBHOOK_SIGNING_KEY"),
    maxAgeSeconds: webhookMaximumAge(),
    isReplay: (token) => hasWebhookToken(db, token),
  });
  if (!verification.ok) {
    if (verification.reason === "missing_secret") {
      return jsonError(503, "mailgun_webhook_unconfigured");
    }
    if (verification.reason === "replayed") {
      return jsonError(409, "mailgun_signature_replayed");
    }
    return jsonError(401, "mailgun_signature_invalid");
  }

  try {
    const callbackKey = await eventCallbackKey(event);
    const reservation = await reserveWebhook(db, {
      kind: "event",
      token: verification.token,
      signatureTimestamp: verification.timestamp,
      callbackKey,
    });
    if (reservation === "replay") {
      return jsonError(409, "mailgun_signature_replayed");
    }
    if (reservation === "duplicate") {
      return Response.json({ accepted: true, duplicate: true });
    }

    await recordMailgunEvent(db, event, callbackKey);
    await markWebhookProcessed(db, callbackKey);
    return Response.json({ accepted: true }, { status: 202 });
  } catch {
    return jsonError(500, "mailgun_event_persistence_failed");
  }
}

function webhookMaximumAge(): number {
  const configured = Number(runtimeString("CRM_WEBHOOK_MAX_AGE_SECONDS") ?? 900);
  return Number.isInteger(configured) && configured >= 60 && configured <= 3600
    ? configured
    : 900;
}
