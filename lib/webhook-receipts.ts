import type { CrmDatabase } from "./d1";

export type WebhookReservation = "accepted" | "duplicate" | "replay";

export async function hasWebhookToken(db: CrmDatabase, token: string): Promise<boolean> {
  return Boolean(await db.prepare(
    "SELECT 1 AS present FROM webhook_receipts WHERE signature_token=? AND status='processed' LIMIT 1",
  ).bind(token).first());
}

export async function reserveWebhook(
  db: CrmDatabase,
  input: { kind: "inbound" | "event"; token: string; signatureTimestamp: number; callbackKey: string },
): Promise<WebhookReservation> {
  try {
    await db.prepare(`INSERT INTO webhook_receipts
      (kind, signature_token, signature_timestamp, callback_key)
      VALUES (?, ?, ?, ?)`).bind(input.kind, input.token, input.signatureTimestamp, input.callbackKey).run();
    return "accepted";
  } catch (error) {
    if (!isUniqueConstraintError(error)) throw error;
    const tokenReceipt = await db.prepare(
      "SELECT status, callback_key AS callbackKey, kind FROM webhook_receipts WHERE signature_token=? LIMIT 1",
    ).bind(input.token).first<{ status: string; callbackKey: string; kind: string }>();
    if (tokenReceipt) {
      if (tokenReceipt.status === "processed") return "replay";
      if (tokenReceipt.callbackKey === input.callbackKey && tokenReceipt.kind === input.kind) return "accepted";
    }
    const callbackReceipt = await db.prepare(
      "SELECT status FROM webhook_receipts WHERE callback_key=? LIMIT 1",
    ).bind(input.callbackKey).first<{ status: string }>();
    if (callbackReceipt?.status === "processed") return "duplicate";
    if (callbackReceipt?.status === "reserved") return "accepted";
    throw error;
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unique constraint failed|constraint failed/i.test(message);
}

export async function markWebhookProcessed(db: CrmDatabase, callbackKey: string): Promise<void> {
  const result = await db.prepare(`UPDATE webhook_receipts SET status='processed', processed_at=CURRENT_TIMESTAMP
    WHERE callback_key=? AND status='reserved'`).bind(callbackKey).run();
  if ((result.meta?.changes ?? 0) > 1) throw new Error("webhook_receipt_state_invalid");
}
