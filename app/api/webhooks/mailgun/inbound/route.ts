import { crmDatabase } from "@/lib/d1";
import { jsonError } from "@/lib/http";
import {
  inboundCallbackKey,
  parseInboundForm,
  verifyMailgunSignature,
} from "@/lib/mailgun";
import {
  getPrivateObjectBucket,
  runtimeString,
} from "@/lib/runtime";
import {
  hasWebhookToken,
  recordInboundMessage,
  reserveWebhook,
  storeInboundAttachments,
} from "@/lib/webhook-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let inbound;
  try {
    inbound = parseInboundForm(await request.formData());
  } catch {
    return jsonError(400, "mailgun_payload_invalid");
  }

  const db = crmDatabase();
  const verification = await verifyMailgunSignature(inbound.signature, {
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
    const callbackKey = await inboundCallbackKey(inbound);
    const reservation = await reserveWebhook(db, {
      kind: "inbound",
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

    const recorded = await recordInboundMessage(db, inbound);
    const attachmentCount =
      recorded.created && inbound.attachments.length > 0
        ? await storeInboundAttachments(
            db,
            getPrivateObjectBucket(),
            recorded.messageId,
            inbound.attachments,
          )
        : 0;
    return Response.json(
      {
        accepted: true,
        conversationId: recorded.conversationId,
        attachmentCount,
      },
      { status: 202 },
    );
  } catch {
    return jsonError(500, "mailgun_inbound_persistence_failed");
  }
}

function webhookMaximumAge(): number {
  const configured = Number(runtimeString("CRM_WEBHOOK_MAX_AGE_SECONDS") ?? 900);
  return Number.isInteger(configured) && configured >= 60 && configured <= 3600
    ? configured
    : 900;
}
