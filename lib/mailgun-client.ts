import "server-only";

import { type OutboundMailgunMessage } from "./mailgun-message";
import {
  mailgunFailureKindForStatus,
  MailgunSendError,
  normalizeAcceptedMailgunMessageId,
} from "./mailgun-send-outcome";
import {
  dispatchMailgunRequest,
  type MailgunRequestOptions,
} from "./mailgun-request";

export type { OutboundMailgunMessage } from "./mailgun-message";
export { MailgunSendError } from "./mailgun-send-outcome";

export type MailgunClientConfig = {
  apiBase: string;
  domain: string;
  sendingKey: string;
};

export async function sendMailgunMessage(
  message: OutboundMailgunMessage,
  config: MailgunClientConfig,
  options: MailgunRequestOptions = {},
): Promise<{ id: string; message: string }> {
  const apiBase = config.apiBase.replace(/\/+$/u, "");
  const response = await dispatchMailgunRequest(
    message,
    {
      url: `${apiBase}/v3/${encodeURIComponent(config.domain)}/messages`,
      authorization: `Basic ${btoa(`api:${config.sendingKey}`)}`,
    },
    options,
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    throw new MailgunSendError(
      response.status,
      mailgunFailureKindForStatus(response.status),
    );
  }
  if (!payload || typeof payload !== "object") {
    throw new MailgunSendError(502, "outcome_unknown");
  }

  const record = payload as Record<string, unknown>;
  if (typeof record.id !== "string") {
    throw new MailgunSendError(502, "outcome_unknown");
  }
  const id = normalizeAcceptedMailgunMessageId(record.id);
  return {
    id,
    message: typeof record.message === "string" ? record.message : "Queued",
  };
}
