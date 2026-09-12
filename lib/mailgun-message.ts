import { normalizeEmailAddress } from "./mailboxes";

export type OutboundMailgunMessage = {
  fromAddress: string;
  fromName: string;
  to: string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  inReplyTo?: string | null;
  references?: string[];
  replyTo: string;
  unsubscribeUrl?: string;
};

export function buildMailgunForm(message: OutboundMailgunMessage): FormData {
  const unsubscribeUrl = message.unsubscribeUrl
    ? validatedUnsubscribeUrl(message.unsubscribeUrl)
    : null;
  const fromAddress = normalizeEmailAddress(message.fromAddress);
  const replyTo = normalizeEmailAddress(message.replyTo);
  if (
    !fromAddress ||
    fromAddress !== message.fromAddress ||
    !replyTo ||
    replyTo !== message.replyTo ||
    replyTo !== fromAddress
  ) {
    throw new Error("Mailgun Reply-To address is invalid.");
  }
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

  // Keep CRM prospecting deterministic even if the Mailgun domain defaults
  // change. Delivery, bounce, and complaint events remain enabled.
  form.set("o:dkim", "yes");
  form.set("o:tracking", "no");
  form.set("o:tracking-clicks", "no");
  form.set("o:tracking-opens", "no");
  form.set("h:Reply-To", replyTo);
  if (unsubscribeUrl) {
    form.set("h:List-Unsubscribe", `<${unsubscribeUrl}>`);
    form.set("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  }
  return form;
}

function validatedUnsubscribeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Mailgun unsubscribe URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Mailgun unsubscribe URL is invalid.");
  }
  return url.toString();
}
