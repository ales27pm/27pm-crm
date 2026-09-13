import { boundedRequest } from "@/lib/bounded-request";
import { recordCakemailEvent } from "@/lib/cakemail-event-store";
import {
  CAKEMAIL_WEBHOOK_MAX_BYTES,
  cakemailWebhookCallbackKey,
  cakemailWebhookEventKey,
  cakemailWebhookReceiptToken,
  type CakemailWebhookEventKey,
  type CakemailWebhookSecretMap,
  parseCakemailWebhookEvent,
  parseCakemailWebhookSecrets,
  verifyCakemailWebhookSignature,
} from "@/lib/cakemail-webhook";
import { crmDatabase } from "@/lib/d1";
import { jsonError } from "@/lib/http";
import { runtimeString } from "@/lib/runtime";
import { markWebhookProcessed, reserveWebhook } from "@/lib/webhook-receipts";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const bounded = await boundedRequest(request, CAKEMAIL_WEBHOOK_MAX_BYTES);
  if (!bounded) return jsonError(413, "webhook_too_large");
  const rawBody = new Uint8Array(await bounded.arrayBuffer());

  let configuredSecrets: CakemailWebhookSecretMap;
  try {
    configuredSecrets = parseCakemailWebhookSecrets(
      runtimeString("CAKEMAIL_WEBHOOK_SECRETS_JSON"),
    );
  } catch {
    return jsonError(503, "cakemail_webhook_unconfigured");
  }

  let eventKey: CakemailWebhookEventKey;
  try {
    eventKey = cakemailWebhookEventKey(rawBody);
  } catch {
    return jsonError(400, "cakemail_payload_invalid");
  }

  const verification = await verifyCakemailWebhookSignature(
    rawBody,
    request.headers.get("X-Cakemail-Signature"),
    configuredSecrets[eventKey] ?? [],
  );
  if (!verification.ok) {
    if (verification.reason === "missing_secrets") {
      return jsonError(503, "cakemail_webhook_unconfigured");
    }
    return jsonError(401, "cakemail_signature_invalid");
  }

  let event;
  try {
    event = parseCakemailWebhookEvent(rawBody);
  } catch {
    return jsonError(400, "cakemail_payload_invalid");
  }

  try {
    const db = crmDatabase();
    const callbackKey = await cakemailWebhookCallbackKey(rawBody);
    const token = await cakemailWebhookReceiptToken(rawBody);
    const reservation = await reserveWebhook(db, {
      provider: "cakemail",
      kind: "event",
      token,
      signatureTimestamp: event.signatureTimestamp,
      callbackKey,
    });
    if (reservation === "duplicate" || reservation === "replay") {
      return Response.json({ accepted: true, duplicate: true });
    }

    await recordCakemailEvent(db, event, callbackKey);
    await markWebhookProcessed(db, callbackKey);
    return Response.json({ accepted: true }, { status: 202 });
  } catch {
    return jsonError(500, "cakemail_event_persistence_failed");
  }
}
