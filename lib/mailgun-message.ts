import { normalizeEmailAddress } from "./mailboxes";
import { isWellFormedUnicode } from "./unicode";

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
  /** Taxonomy labels only. Never include recipient or other user identifiers. */
  tags?: readonly string[];
};

export function buildMailgunForm(message: OutboundMailgunMessage): FormData {
  const unsubscribeUrl = message.unsubscribeUrl
    ? validatedUnsubscribeUrl(message.unsubscribeUrl)
    : null;
  const tags = validatedMailgunTags(message.tags);
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
  if (
    !isWellFormedUnicode(message.fromName) ||
    !isWellFormedUnicode(message.subject) ||
    (message.text !== null &&
      message.text !== undefined &&
      !isWellFormedUnicode(message.text)) ||
    (message.html !== null &&
      message.html !== undefined &&
      !isWellFormedUnicode(message.html))
  ) {
    throw new Error("Mailgun message content is invalid.");
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
  for (const tag of tags) form.append("o:tag", tag);
  form.set("h:Reply-To", replyTo);
  if (unsubscribeUrl) {
    form.set("h:List-Unsubscribe", `<${unsubscribeUrl}>`);
    form.set("h:List-Unsubscribe-Post", "List-Unsubscribe=One-Click");
  }
  return form;
}

// Mailgun currently accepts at most three tags on one message. Keep a tighter
// local length bound than the provider limit because these are taxonomy labels,
// never identifiers or free-form metadata.
const MAX_MAILGUN_TAGS = 3;
const MAX_MAILGUN_TAG_LENGTH = 64;
const SAFE_MAILGUN_TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PHONE_SHAPED_VALUE = /(?:[0-9]-?){7,}/u;
const UUID_SHAPED_VALUE = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u;
const CANADIAN_POSTAL_CODE_SHAPED_VALUE = /[abceghj-nprstvxy][0-9][abceghj-nprstv-z]-?[0-9][abceghj-nprstv-z][0-9]/u;
const MAILGUN_TAG_RULES: readonly ((value: string) => boolean)[] = [
  (value) => value.length > 0,
  (value) => value.length <= MAX_MAILGUN_TAG_LENGTH,
  (value) => SAFE_MAILGUN_TAG.test(value),
  (value) => !PHONE_SHAPED_VALUE.test(value),
  (value) => !UUID_SHAPED_VALUE.test(value),
  (value) => !CANADIAN_POSTAL_CODE_SHAPED_VALUE.test(value),
];

function validatedMailgunTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) {
    throw new Error("Mailgun tags are invalid.");
  }
  const tagValues: unknown[] = tags;
  assertValidMailgunTagValues(tagValues);

  return [...tagValues].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function assertValidMailgunTagValues(
  tags: unknown[],
): asserts tags is string[] {
  const checks = [
    tags.length <= MAX_MAILGUN_TAGS,
    tags.every(isSafeMailgunTag),
    new Set(tags).size === tags.length,
  ];
  if (!checks.every(Boolean)) throw new Error("Mailgun tags are invalid.");
}

function isSafeMailgunTag(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return MAILGUN_TAG_RULES.every((rule) => rule(value));
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
