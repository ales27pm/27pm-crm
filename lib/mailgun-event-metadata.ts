import {
  classifyDeliverabilityEvent,
  type DeliverabilityEventClass,
} from "./deliverability-policy";

export type NormalizedMailboxProvider =
  | "google"
  | "microsoft"
  | "yahoo"
  | "other";

export type MailgunFailureClass = Exclude<
  DeliverabilityEventClass,
  "accepted_transport" | "delivered_transport" | "unknown"
>;

export type MailgunEventMetadata = {
  sendingDomain: string | null;
  recipientDomain: string | null;
  mailboxProvider: NormalizedMailboxProvider;
  sendingIp: string | null;
  failureClass: MailgunFailureClass | null;
  smtpCode: number | null;
  enhancedStatusCode: string | null;
  smtpDescription: string | null;
  attemptNo: number | null;
  tags: string[];
  campaigns: string[];
};

const MAX_DIMENSION_COUNT = 32;
const DIMENSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/u;
const DOMAIN_PATTERN =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const IPV4_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const IPV6_LIKE_PATTERN = /^[0-9a-f:]+$/u;
const SMTP_CODE_PATTERN = /^\d{3}$/u;
const INTEGER_PATTERN = /^\d+$/u;
const MAILBOX_PROVIDER_PATTERNS: ReadonlyArray<{
  provider: NormalizedMailboxProvider;
  pattern: RegExp;
}> = [
  { provider: "google", pattern: /\b(?:gmail|googlemail|google)\b/u },
  {
    provider: "microsoft",
    pattern: /\b(?:microsoft|outlook|hotmail|live\.com|msn\.com|office365)\b/u,
  },
  { provider: "yahoo", pattern: /\b(?:yahoo|ymail|rocketmail|aol)\b/u },
];

/**
 * Extracts only bounded, operator-safe dimensions from a signed Mailgun event.
 * The signed raw payload remains the audit source; browser responses must use
 * these normalized fields and never expose the raw payload.
 */
export function extractMailgunEventMetadata(input: {
  raw: Record<string, unknown>;
  eventType: string;
  severity: string | null;
  reason: string | null;
  recipient: string | null;
}): MailgunEventMetadata {
  const domain = objectValue(input.raw.domain);
  const envelope = objectValue(input.raw.envelope);
  const deliveryStatus = objectValue(input.raw["delivery-status"]);
  const recipientDomain =
    normalizedDomain(input.raw["recipient-domain"]) ??
    recipientDomainFromAddress(input.recipient);
  const smtpCode = normalizedSmtpCode(deliveryStatus.code);
  const enhancedStatusCode = normalizedEnhancedStatusCode(
    deliveryStatus["enhanced-code"],
  );
  const smtpDescription = safeSmtpDescription(
    stringValue(deliveryStatus.message) ??
      stringValue(deliveryStatus.description),
  );

  return {
    sendingDomain: normalizedDomain(domain.name),
    recipientDomain,
    mailboxProvider: normalizedMailboxProvider(
      stringValue(input.raw["recipient-provider"]),
      recipientDomain,
    ),
    sendingIp: normalizedIp(
      envelope["sending-ip"] ?? input.raw["sending-ip"],
    ),
    failureClass: classifyMailgunFailure({
      eventType: input.eventType,
      severity: input.severity,
      reason: input.reason,
      bounceType: stringValue(deliveryStatus["bounce-type"]),
      smtpCode,
      enhancedStatusCode,
      smtpDescription,
    }),
    smtpCode,
    enhancedStatusCode,
    smtpDescription,
    attemptNo: boundedInteger(deliveryStatus["attempt-no"], 1, 10_000),
    tags: safeDimensionList(input.raw.tags),
    campaigns: safeCampaignList(input.raw.campaigns),
  };
}

export function normalizedMailboxProvider(
  provider: string | null | undefined,
  recipientDomain: string | null | undefined,
): NormalizedMailboxProvider {
  const hint =
    `${stringOrEmpty(provider)} ${stringOrEmpty(recipientDomain)}`.toLowerCase();
  for (const candidate of MAILBOX_PROVIDER_PATTERNS) {
    if (candidate.pattern.test(hint)) return candidate.provider;
  }
  return "other";
}

export function classifyMailgunFailure(input: {
  eventType: string;
  severity?: string | null;
  reason?: string | null;
  bounceType?: string | null;
  smtpCode?: number | null;
  enhancedStatusCode?: string | null;
  smtpDescription?: string | null;
}): MailgunFailureClass | null {
  const severity = normalizedToken(input.severity);
  const bounceType = normalizedToken(input.bounceType);
  if (severity === "permanent" && bounceType === "hard") {
    return "hard_bounce";
  }
  const eventClass = classifyDeliverabilityEvent({
    event: input.eventType,
    severity: input.severity,
    reason: input.reason,
    smtpCode: input.smtpCode,
    enhancedStatusCode: input.enhancedStatusCode,
    description: input.smtpDescription,
  });
  return ["accepted_transport", "delivered_transport", "unknown"].includes(
    eventClass,
  )
    ? null
    : (eventClass as MailgunFailureClass);
}

function safeDimensionList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of value) {
    if (appendDimension(result, seen, item)) break;
  }
  return result;
}

function appendDimension(
  result: string[],
  seen: Set<string>,
  value: unknown,
): boolean {
  const normalized = safeDimension(value);
  if (!normalized) return false;
  if (seen.has(normalized)) return false;
  seen.add(normalized);
  result.push(normalized);
  return result.length >= MAX_DIMENSION_COUNT;
}

function safeDimension(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return DIMENSION_PATTERN.test(normalized) ? normalized : null;
}

function safeCampaignList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return safeDimensionList(
    value.map((item) => {
      if (typeof item === "string") return item;
      const record = objectValue(item);
      return stringValue(record.id) ?? stringValue(record.name) ?? "";
    }),
  );
}

function safeSmtpDescription(value: string | null): string | null {
  if (!value) return null;
  const bounded = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9.-]+/gu, "[email]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
  return bounded || null;
}

function normalizedDomain(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const domain = value.trim().toLowerCase().replace(/\.$/u, "");
  if (!isLengthBetween(domain, 1, 253)) return null;
  return DOMAIN_PATTERN.test(domain) ? domain : null;
}

function recipientDomainFromAddress(value: string | null): string | null {
  if (!value || !value.includes("@")) return null;
  return normalizedDomain(value.slice(value.lastIndexOf("@") + 1));
}

function normalizedIp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ip = value.trim().toLowerCase();
  if (!isLengthBetween(ip, 3, 45)) return null;
  return normalizedIpCandidate(ip);
}

function normalizedIpCandidate(ip: string): string | null {
  if (IPV4_PATTERN.test(ip)) return validIpv4(ip) ? ip : null;
  return isIpv6Like(ip) ? ip : null;
}

function normalizedSmtpCode(value: unknown): number | null {
  return boundedParsedInteger(value, 100, 599, SMTP_CODE_PATTERN);
}

function normalizedEnhancedStatusCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[245]\.\d{1,3}\.\d{1,3}$/u.test(code) ? code : null;
}

function boundedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): number | null {
  return boundedParsedInteger(value, minimum, maximum, INTEGER_PATTERN);
}

function boundedParsedInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  stringPattern: RegExp,
): number | null {
  const candidate = parsedNumber(value, stringPattern);
  if (!Number.isInteger(candidate)) return null;
  if (candidate < minimum) return null;
  return candidate <= maximum ? candidate : null;
}

function parsedNumber(value: unknown, stringPattern: RegExp): number {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const normalized = value.trim();
  return stringPattern.test(normalized) ? Number(normalized) : Number.NaN;
}

function validIpv4(ip: string): boolean {
  return ip.split(".").every(validIpv4Part);
}

function validIpv4Part(part: string): boolean {
  const numericPart = Number(part);
  return numericPart >= 0 && numericPart <= 255;
}

function isIpv6Like(ip: string): boolean {
  return IPV6_LIKE_PATTERN.test(ip) && ip.includes(":");
}

function isLengthBetween(
  value: string,
  minimum: number,
  maximum: number,
): boolean {
  return value.length >= minimum && value.length <= maximum;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringOrEmpty(value: string | null | undefined): string {
  return value ?? "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizedToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-");
}
