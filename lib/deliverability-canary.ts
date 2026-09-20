import { normalizeEmailAddress } from "./mailboxes";
import { isWellFormedUnicode } from "./unicode";

export const DELIVERABILITY_CANARY_RECIPIENT = "27pmorg@gmail.com";
export const DELIVERABILITY_CANARY_SENDER = "alexis@27pm.org";
export const DELIVERABILITY_CANARY_SUBJECT = "Test DKIM 2048 — 27PM";

export function deliverabilityCanaryTransmittedText(
  text: string,
  canaryId: string,
  sentAt: string,
): string {
  return `${text}\n\nIdentifiant : ${canaryId}\nEnvoyé à : ${sentAt}`;
}

export async function deliverabilityCanaryApprovalDigest(input: {
  recipient: string;
  subject: string;
  text: string;
}): Promise<string> {
  const scope = JSON.stringify({
    version: 1,
    sender: DELIVERABILITY_CANARY_SENDER,
    recipient: input.recipient,
    subject: input.subject,
    text: input.text,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(scope),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function parseDeliverabilityCanaryContent(payload: Record<string, unknown>) {
  const subject =
    typeof payload.subject === "string"
      ? payload.subject.replace(/[\r\n]+/gu, " ").trim()
      : DELIVERABILITY_CANARY_SUBJECT;
  const text =
    typeof payload.text === "string"
      ? payload.text.trim()
      : "Test administratif de délivrabilité 27PM.";
  if (!subject || subject.length > 500 || !text || text.length > 20_000 ||
    !isWellFormedUnicode(subject) || !isWellFormedUnicode(text)) {
    return null;
  }
  return { subject, text };
}

/** Keep the private Outlook seed out of source and require an exact runtime pin. */
export function resolveDeliverabilityCanaryRecipient(
  requested: unknown,
  configuredGmail: string,
  configuredOutlook: string | null,
): string | null {
  if (configuredGmail !== DELIVERABILITY_CANARY_RECIPIENT) return null;

  const recipient =
    requested === undefined
      ? DELIVERABILITY_CANARY_RECIPIENT
      : typeof requested === "string"
        ? normalizeEmailAddress(requested)
        : null;
  if (!recipient) return null;
  if (recipient === DELIVERABILITY_CANARY_RECIPIENT) return recipient;

  const outlook = configuredOutlook && normalizeEmailAddress(configuredOutlook);
  return outlook &&
    configuredOutlook === outlook &&
    outlook.endsWith("@outlook.com") &&
    outlook !== DELIVERABILITY_CANARY_RECIPIENT &&
    recipient === outlook
    ? recipient
    : null;
}
