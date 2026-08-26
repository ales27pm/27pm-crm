export const CRM_MAILBOXES = [
  {
    id: "mailbox_bonjour",
    address: "bonjour@27pm.org",
    localPart: "bonjour",
    displayName: "27PM — Bonjour",
    purpose: "sales",
  },
  {
    id: "mailbox_admin",
    address: "admin@27pm.org",
    localPart: "admin",
    displayName: "27PM — Administration",
    purpose: "operations",
  },
] as const;

export type CrmMailbox = (typeof CRM_MAILBOXES)[number];

const SIMPLE_EMAIL =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

export function normalizeEmailAddress(value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !SIMPLE_EMAIL.test(normalized)) {
    return null;
  }
  return normalized;
}

export function extractEmailAddress(value: string): string | null {
  const angleAddress = value.match(/<\s*([^<>]+?)\s*>/u)?.[1];
  if (angleAddress) return normalizeEmailAddress(angleAddress);

  const direct = normalizeEmailAddress(value);
  if (direct) return direct;

  const match = value.match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/iu,
  );
  return match ? normalizeEmailAddress(match[0]) : null;
}

export function extractDisplayName(value: string): string | null {
  if (!value.includes("<")) return null;
  const displayName = value
    .slice(0, value.indexOf("<"))
    .trim()
    .replace(/^"|"$/gu, "")
    .trim();
  return displayName || null;
}

export function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let angleDepth = 0;

  for (const character of value) {
    if (character === '"') quoted = !quoted;
    if (!quoted && character === "<") angleDepth += 1;
    if (!quoted && character === ">") angleDepth = Math.max(0, angleDepth - 1);

    if (!quoted && angleDepth === 0 && (character === "," || character === ";")) {
      if (current.trim()) parts.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }

  if (current.trim()) parts.push(current.trim());
  return parts;
}

export function parseAddressList(value: string | null | undefined): string[] {
  if (!value) return [];
  return splitAddressList(value)
    .map(extractEmailAddress)
    .filter((address): address is string => Boolean(address));
}

export function mailboxForAddress(value: string): CrmMailbox | null {
  const address = extractEmailAddress(value);
  return (
    CRM_MAILBOXES.find((mailbox) => mailbox.address === address) ?? null
  );
}

export function mailboxFromRecipients(
  recipients: readonly string[],
): CrmMailbox | null {
  const matches = new Map<string, CrmMailbox>();
  for (const recipient of recipients) {
    const mailbox = mailboxForAddress(recipient);
    if (mailbox) matches.set(mailbox.id, mailbox);
  }
  return matches.size === 1 ? [...matches.values()][0] : null;
}
