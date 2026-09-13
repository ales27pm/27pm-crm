import { normalizeEmailAddress } from "./mailboxes";

export type OutboundCakemailMessage = {
  fromAddress: string;
  fromName: string;
  to: readonly string[];
  subject: string;
  text?: string | null;
  html?: string | null;
  inReplyTo?: string | null;
  references?: readonly string[];
  replyTo: string;
  unsubscribeUrl?: string;
  /** Taxonomy labels only. Never include recipient or other user identifiers. */
  tags?: readonly string[];
};

export type CakemailContentMode = "html" | "text";

export type CakemailMessageConfig = {
  listId: number;
  contentMode: CakemailContentMode;
  senderIds: Readonly<Record<string, string>>;
};

export type CakemailAdditionalHeader = {
  name:
    | "Message-ID"
    | "Reply-To"
    | "In-Reply-To"
    | "References"
    | "List-Unsubscribe"
    | "List-Unsubscribe-Post";
  value: string;
};

export type CakemailPayload = {
  sender: { id: string; name: string };
  email: string;
  list_id: number;
  content: {
    type: "marketing";
    subject: string;
    encoding: "utf-8";
    html?: string;
    text?: string;
  };
  tags: string[];
  tracking: {
    opens: false;
    clicks_html: false;
    clicks_text: false;
  };
  additional_headers: CakemailAdditionalHeader[];
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const MESSAGE_ID = /^[^<>\s@]+@[^<>\s@]+$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const MAX_TAGS = 3;
const MAX_TAG_LENGTH = 64;
const MAX_CONTENT_LENGTH = 2_000_000;
const SAFE_TAG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const PHONE_SHAPED_VALUE = /(?:[0-9]-?){7,}/u;
const UUID_SHAPED_VALUE =
  /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/u;
const CANADIAN_POSTAL_CODE_SHAPED_VALUE =
  /[abceghj-nprstvxy][0-9][abceghj-nprstv-z]-?[0-9][abceghj-nprstv-z][0-9]/u;

/**
 * Generates the RFC Message-ID used by the CRM for threading and callback
 * correlation. Cakemail's provider UUID remains a separate identifier.
 */
export function createCakemailExternalMessageId(
  fromAddress: string,
  createUuid: () => string = () => crypto.randomUUID(),
): string {
  const sender = validatedExactEmail(fromAddress, "sender");
  const domain = sender.slice(sender.lastIndexOf("@") + 1);
  const uuid = createUuid();
  if (!UUID.test(uuid)) {
    throw new Error("Cakemail Message-ID UUID is invalid.");
  }
  return `cakemail.${uuid}@${domain}`;
}

export function buildCakemailPayload(
  message: OutboundCakemailMessage,
  config: CakemailMessageConfig,
  externalMessageId: string,
): CakemailPayload {
  const fromAddress = validatedExactEmail(message.fromAddress, "sender");
  const replyTo = validatedExactEmail(message.replyTo, "Reply-To");
  if (replyTo !== fromAddress) {
    throw new Error("Cakemail Reply-To must match the sender address.");
  }
  if (message.to.length !== 1) {
    throw new Error("Cakemail requires exactly one recipient.");
  }
  const recipient = validatedExactEmail(message.to[0] ?? "", "recipient");
  const listId = validatedPositiveInteger(config.listId, "list ID");
  const senderId = validatedSenderId(config.senderIds, fromAddress);
  const content = selectedContent(message, config.contentMode);
  const canonicalExternalMessageId = validatedMessageId(
    externalMessageId,
    "Message-ID",
  );

  const additionalHeaders: CakemailAdditionalHeader[] = [
    { name: "Message-ID", value: `<${canonicalExternalMessageId}>` },
    { name: "Reply-To", value: replyTo },
  ];
  if (message.inReplyTo) {
    additionalHeaders.push({
      name: "In-Reply-To",
      value: `<${validatedMessageId(message.inReplyTo, "In-Reply-To")}>`,
    });
  }
  if (message.references?.length) {
    const references = message.references.map((reference) =>
      validatedMessageId(reference, "References"),
    );
    const value = references.map((reference) => `<${reference}>`).join(" ");
    if (value.length > 998) {
      throw new Error("Cakemail References header is invalid.");
    }
    additionalHeaders.push({ name: "References", value });
  }

  if (message.unsubscribeUrl) {
    const unsubscribeUrl = validatedUnsubscribeUrl(message.unsubscribeUrl);
    additionalHeaders.push(
      { name: "List-Unsubscribe", value: `<${unsubscribeUrl}>` },
      {
        name: "List-Unsubscribe-Post",
        value: "List-Unsubscribe=One-Click",
      },
    );
  }

  return {
    sender: {
      id: senderId,
      name: validatedHeaderText(message.fromName, "sender name", 256),
    },
    email: recipient,
    list_id: listId,
    content: {
      type: "marketing",
      subject: validatedHeaderText(message.subject, "subject", 998),
      encoding: "utf-8",
      [config.contentMode]: content,
    },
    tags: validatedTags(message.tags),
    tracking: {
      opens: false,
      clicks_html: false,
      clicks_text: false,
    },
    additional_headers: additionalHeaders,
  };
}

function validatedExactEmail(value: string, field: string): string {
  const normalized = normalizeEmailAddress(value);
  if (!normalized || normalized !== value) {
    throw new Error(`Cakemail ${field} address is invalid.`);
  }
  return normalized;
}

function validatedPositiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Cakemail ${field} is invalid.`);
  }
  return value;
}

function validatedSenderId(
  senderIds: Readonly<Record<string, string>>,
  fromAddress: string,
): string {
  if (
    !senderIds ||
    typeof senderIds !== "object" ||
    !Object.prototype.hasOwnProperty.call(senderIds, fromAddress)
  ) {
    throw new Error("Cakemail sender ID is not configured.");
  }
  const senderId = senderIds[fromAddress];
  if (
    typeof senderId !== "string" ||
    senderId.length === 0 ||
    senderId.length > 128 ||
    senderId.trim() !== senderId ||
    CONTROL_CHARACTER.test(senderId)
  ) {
    throw new Error("Cakemail sender ID is invalid.");
  }
  return senderId;
}

function selectedContent(
  message: OutboundCakemailMessage,
  mode: CakemailContentMode,
): string {
  if (mode !== "html" && mode !== "text") {
    throw new Error("Cakemail content mode is invalid.");
  }
  const value = message[mode];
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > MAX_CONTENT_LENGTH
  ) {
    throw new Error(`Cakemail ${mode} content is required.`);
  }
  return value;
}

function validatedMessageId(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    value.toLowerCase() !== value ||
    !MESSAGE_ID.test(value) ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`Cakemail ${field} is invalid.`);
  }
  return value;
}

function validatedHeaderText(
  value: string,
  field: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > maximumLength ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`Cakemail ${field} is invalid.`);
  }
  return value;
}

function validatedUnsubscribeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Cakemail unsubscribe URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error("Cakemail unsubscribe URL is invalid.");
  }
  return url.toString();
}

function validatedTags(tags: readonly string[] | undefined): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > MAX_TAGS) {
    throw new Error("Cakemail tags are invalid.");
  }
  const values: unknown[] = tags;
  if (
    !values.every(isSafeTag) ||
    new Set(values).size !== values.length
  ) {
    throw new Error("Cakemail tags are invalid.");
  }
  return [...values].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function isSafeTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_TAG_LENGTH &&
    SAFE_TAG.test(value) &&
    !PHONE_SHAPED_VALUE.test(value) &&
    !UUID_SHAPED_VALUE.test(value) &&
    !CANADIAN_POSTAL_CODE_SHAPED_VALUE.test(value)
  );
}
