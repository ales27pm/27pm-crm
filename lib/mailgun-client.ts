import "server-only";

export type OutboundMailgunMessage = {
  fromAddress: string;
  fromName: string;
  to: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[];
};

export type MailgunClientConfig = {
  apiBase: string;
  domain: string;
  sendingKey: string;
};

export async function sendMailgunMessage(
  message: OutboundMailgunMessage,
  config: MailgunClientConfig,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; message: string }> {
  const apiBase = config.apiBase.replace(/\/+$/u, "");
  const form = new FormData();
  form.set("from", `${message.fromName} <${message.fromAddress}>`);
  for (const recipient of message.to) form.append("to", recipient);
  form.set("subject", message.subject);
  if (message.text) form.set("text", message.text);
  if (message.html) form.set("html", message.html);
  if (message.inReplyTo) form.set("h:In-Reply-To", `<${message.inReplyTo}>`);
  if (message.references?.length) {
    form.set(
      "h:References",
      message.references.map((reference) => `<${reference}>`).join(" "),
    );
  }

  const response = await fetcher(
    `${apiBase}/v3/${encodeURIComponent(config.domain)}/messages`,
    {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`api:${config.sendingKey}`)}`,
      },
      body: form,
    },
  );

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) throw new MailgunSendError(response.status);
  if (!payload || typeof payload !== "object") throw new MailgunSendError(502);

  const record = payload as Record<string, unknown>;
  if (typeof record.id !== "string") throw new MailgunSendError(502);
  return {
    id: record.id,
    message: typeof record.message === "string" ? record.message : "Queued",
  };
}

export class MailgunSendError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("Mailgun rejected the send request.");
    this.name = "MailgunSendError";
    this.status = status;
  }
}
