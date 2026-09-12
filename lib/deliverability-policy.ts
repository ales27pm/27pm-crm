export const MAILBOX_PROVIDERS = [
  "google",
  "microsoft",
  "yahoo",
  "other",
] as const;

export type MailboxProvider = (typeof MAILBOX_PROVIDERS)[number];

export type DeliverabilityEventClass =
  | "accepted_transport"
  | "delivered_transport"
  | "hard_bounce"
  | "complaint"
  | "unsubscribe"
  | "temporary"
  | "policy_block"
  | "auth_failure"
  | "other_permanent"
  | "unknown";

export type DeliverabilityEventInput = {
  event: string | null | undefined;
  severity?: string | null;
  reason?: string | null;
  smtpCode?: number | string | null;
  enhancedStatusCode?: string | null;
  description?: string | null;
};

type NormalizedDeliverabilityEvent = {
  event: string;
  severity: string;
  reason: string;
  description: string;
  enhancedStatusCode: string | null;
  smtpCode: number | null;
};

export const REPUTATION_MODES = [
  "normal",
  "domain_ramp",
  "recovery",
  "dedicated_ip_warmup",
] as const;

export type ReputationMode = (typeof REPUTATION_MODES)[number];

const DEDICATED_IP_WARMUP_INITIAL_DAILY_VOLUME = 100;
const DEDICATED_IP_WARMUP_DAILY_GROWTH_LIMIT = 0.2;
const DEFAULT_DELIVERABILITY_SAMPLE_MINIMUM = 100;

const DELIVERABILITY_THRESHOLDS_PERCENT = {
  complaint: { warningAt: 0.05, criticalAt: 0.1 },
  gmailSpam: { warningAt: 0.1, criticalAt: 0.3 },
  hardBounce: { warningAt: 1, criticalAt: 2 },
  delivery: { warningBelow: 98, criticalBelow: 95 },
  temporaryFailure: { criticalAbove: 5 },
} as const;

export type DeliverabilityCounts = {
  attempted: number;
  accepted: number;
  delivered: number;
  hardBounced: number;
  complained: number;
  unsubscribed: number;
  temporarilyFailed: number;
  policyBlocked?: number;
  authFailed?: number;
  otherPermanentFailed?: number;
  gmailDelivered?: number;
  gmailSpamReported?: number;
};

export type DeliverabilityDenominator =
  | "attempted"
  | "accepted"
  | "delivered"
  | "gmail_delivered";

export type DeliverabilityRateMetric = {
  numerator: number;
  denominator: number;
  denominatorKind: DeliverabilityDenominator;
  ratio: number | null;
  percent: number | null;
};

export type DeliverabilityMetrics = {
  acceptance: DeliverabilityRateMetric;
  delivery: DeliverabilityRateMetric;
  hardBounce: DeliverabilityRateMetric;
  complaint: DeliverabilityRateMetric;
  unsubscribe: DeliverabilityRateMetric;
  temporaryFailure: DeliverabilityRateMetric;
  policyBlock: DeliverabilityRateMetric;
  authFailure: DeliverabilityRateMetric;
  otherPermanentFailure: DeliverabilityRateMetric;
  gmailSpam: DeliverabilityRateMetric | null;
};

export type DeliverabilityThresholdStatus =
  | "target"
  | "warning"
  | "critical"
  | "insufficient_data";

export type EvaluatedDeliverabilityMetric = DeliverabilityRateMetric & {
  status: DeliverabilityThresholdStatus;
};

export type DeliverabilityThresholdEvaluation = {
  minimumSampleSize: number;
  overall: DeliverabilityThresholdStatus;
  complaint: EvaluatedDeliverabilityMetric;
  hardBounce: EvaluatedDeliverabilityMetric;
  delivery: EvaluatedDeliverabilityMetric;
  temporaryFailure: EvaluatedDeliverabilityMetric;
  gmailSpam: EvaluatedDeliverabilityMetric | null;
};

const GOOGLE_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

const MICROSOFT_DOMAINS = new Set([
  "outlook.com",
  "outlook.ca",
  "outlook.de",
  "outlook.fr",
  "outlook.jp",
  "hotmail.com",
  "hotmail.ca",
  "hotmail.co.jp",
  "hotmail.co.uk",
  "hotmail.de",
  "hotmail.es",
  "hotmail.fr",
  "hotmail.it",
  "live.com",
  "live.ca",
  "live.co.uk",
  "live.de",
  "live.fr",
  "live.it",
  "live.nl",
  "live.be",
  "msn.com",
]);

const YAHOO_DOMAINS = new Set([
  "yahoo.com",
  "yahoo.ca",
  "yahoo.co.in",
  "yahoo.co.jp",
  "yahoo.co.nz",
  "yahoo.co.uk",
  "yahoo.com.au",
  "yahoo.com.br",
  "yahoo.com.mx",
  "yahoo.com.sg",
  "yahoo.com.tw",
  "yahoo.de",
  "yahoo.es",
  "yahoo.fr",
  "yahoo.in",
  "yahoo.it",
  "ymail.com",
  "rocketmail.com",
  "aol.com",
  "aim.com",
]);

const PROVIDER_DOMAIN_SETS: readonly (readonly [
  MailboxProvider,
  ReadonlySet<string>,
])[] = [
  ["google", GOOGLE_DOMAINS],
  ["microsoft", MICROSOFT_DOMAINS],
  ["yahoo", YAHOO_DOMAINS],
];

const HARD_BOUNCE_EVENTS = new Set(["bounce", "bounced"]);
const HARD_BOUNCE_REASONS = new Set([
  "bounce",
  "suppress-bounce",
  "hard-bounce",
]);
const TEMPORARY_FAILURE_EVENTS = new Set([
  "temporary-fail",
  "temporary-failure",
  "deferred",
]);
const PERMANENT_FAILURE_EVENTS = new Set([
  "permanent-fail",
  "permanent-failure",
  "rejected",
]);
const HARD_BOUNCE_DIAGNOSTIC =
  /\b(?:user unknown|unknown user|no such (?:user|recipient|mailbox)|invalid recipient|recipient (?:does not exist|not found|unknown)|address (?:does not exist|not found))\b/u;
const AUTHENTICATION_DIAGNOSTIC =
  /\b(?:spf|dkim|dmarc|unauthenticated|authentication|reverse dns|ptr record)\b/u;
const POLICY_DIAGNOSTIC =
  /\b(?:policy|reputation|blocklist|blacklist|denylist|spam|blocked)\b/u;

type DeliverabilityClassificationRule = {
  eventClass: DeliverabilityEventClass;
  matches: (input: NormalizedDeliverabilityEvent) => boolean;
};

const DELIVERABILITY_CLASSIFICATION_RULES: readonly DeliverabilityClassificationRule[] = [
  { eventClass: "accepted_transport", matches: isAccepted },
  { eventClass: "delivered_transport", matches: isDelivered },
  { eventClass: "complaint", matches: isComplaintEvent },
  { eventClass: "unsubscribe", matches: isUnsubscribeEvent },
  { eventClass: "hard_bounce", matches: isHardBounceEvent },
  { eventClass: "auth_failure", matches: isAuthenticationFailure },
  { eventClass: "policy_block", matches: isPolicyBlock },
  { eventClass: "temporary", matches: isTemporaryFailure },
  { eventClass: "other_permanent", matches: isPermanentFailure },
];

/**
 * Classifies only known public mailbox domains. Custom Google Workspace and
 * Microsoft 365 domains remain `other` until independently derived MX evidence
 * is available; guessing from a company domain would be unsafe.
 */
export function mailboxProviderForDomain(domain: string): MailboxProvider {
  const normalized = normalizedDomain(domain);
  if (!normalized) return "other";
  const match = PROVIDER_DOMAIN_SETS.find(([, domains]) =>
    domains.has(normalized),
  );
  return match ? match[0] : "other";
}

export function mailboxProviderForAddress(address: string): MailboxProvider {
  const normalized = address.trim().toLowerCase();
  const separator = normalized.lastIndexOf("@");
  if (
    separator <= 0 ||
    separator !== normalized.indexOf("@") ||
    separator === normalized.length - 1
  ) {
    return "other";
  }
  return mailboxProviderForDomain(normalized.slice(separator + 1));
}

/**
 * Applies policy to already-extracted Mailgun fields. It deliberately returns
 * only a canonical category and never echoes SMTP text that may contain PII.
 */
export function classifyDeliverabilityEvent(
  input: DeliverabilityEventInput,
): DeliverabilityEventClass {
  const normalized = normalizeDeliverabilityEvent(input);
  return (
    DELIVERABILITY_CLASSIFICATION_RULES.find((rule) =>
      rule.matches(normalized),
    )?.eventClass ?? "unknown"
  );
}

/**
 * The input values are counts of unique messages in one reporting window, not
 * raw retry events. Rates are intentionally unrounded and retain their exact
 * numerator and denominator.
 */
export function buildDeliverabilityMetrics(
  input: DeliverabilityCounts,
): DeliverabilityMetrics {
  const counts = normalizedDeliverabilityCounts(input);
  validateDeliverabilityCounts(counts);
  const gmailCounts = validatedGmailCounts(counts);
  return metricsFromCounts(counts, gmailCounts);
}

export function evaluateDeliverabilityThresholds(
  metrics: DeliverabilityMetrics,
  options: { minimumSampleSize?: number } = {},
): DeliverabilityThresholdEvaluation {
  const minimumSampleSize = validatedMinimumSampleSize(
    options.minimumSampleSize,
  );

  const complaint = evaluateMaximumRate(
    metrics.complaint,
    minimumSampleSize,
    DELIVERABILITY_THRESHOLDS_PERCENT.complaint.warningAt,
    DELIVERABILITY_THRESHOLDS_PERCENT.complaint.criticalAt,
  );
  const hardBounce = evaluateMaximumRate(
    metrics.hardBounce,
    minimumSampleSize,
    DELIVERABILITY_THRESHOLDS_PERCENT.hardBounce.warningAt,
    DELIVERABILITY_THRESHOLDS_PERCENT.hardBounce.criticalAt,
  );
  const delivery = evaluateMinimumRate(
    metrics.delivery,
    minimumSampleSize,
    DELIVERABILITY_THRESHOLDS_PERCENT.delivery.warningBelow,
    DELIVERABILITY_THRESHOLDS_PERCENT.delivery.criticalBelow,
  );
  const temporaryFailure = evaluateCriticalAbove(
    metrics.temporaryFailure,
    minimumSampleSize,
    DELIVERABILITY_THRESHOLDS_PERCENT.temporaryFailure.criticalAbove,
  );
  // Gmail spam remains separate from aggregate feedback-loop complaints and
  // uses Google's distinct recommended operating bands.
  const gmailSpam = evaluateGmailSpam(metrics.gmailSpam, minimumSampleSize);

  const coreStatuses = [
    complaint.status,
    hardBounce.status,
    delivery.status,
    temporaryFailure.status,
  ];
  const actionableStatuses = withOptionalGmailStatus(coreStatuses, gmailSpam);

  return {
    minimumSampleSize,
    overall: overallStatus(actionableStatuses, coreStatuses),
    complaint,
    hardBounce,
    delivery,
    temporaryFailure,
    gmailSpam,
  };
}

function validatedMinimumSampleSize(value: number | undefined): number {
  const resolved =
    value === undefined ? DEFAULT_DELIVERABILITY_SAMPLE_MINIMUM : value;
  if (!isPositiveSafeInteger(resolved)) {
    throw new RangeError("minimumSampleSize must be a positive integer.");
  }
  return resolved;
}

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function evaluateGmailSpam(
  metric: DeliverabilityRateMetric | null,
  minimumSampleSize: number,
): EvaluatedDeliverabilityMetric | null {
  if (metric === null) return null;
  return evaluateMaximumRate(
    metric,
    minimumSampleSize,
    DELIVERABILITY_THRESHOLDS_PERCENT.gmailSpam.warningAt,
    DELIVERABILITY_THRESHOLDS_PERCENT.gmailSpam.criticalAt,
  );
}

function withOptionalGmailStatus(
  coreStatuses: readonly DeliverabilityThresholdStatus[],
  gmailSpam: EvaluatedDeliverabilityMetric | null,
): DeliverabilityThresholdStatus[] {
  if (gmailSpam === null) return [...coreStatuses];
  return [...coreStatuses, gmailSpam.status];
}

/**
 * Returns an integer maximum that never exceeds the report's theoretical
 * `100 * 1.2^(day - 1)` curve.
 */
export function dedicatedIpWarmupDailyCeiling(day: number): number {
  if (!Number.isSafeInteger(day) || day <= 0) {
    throw new RangeError("Warm-up day must be a positive integer.");
  }
  const ceiling = Math.floor(
    DEDICATED_IP_WARMUP_INITIAL_DAILY_VOLUME *
      (1 + DEDICATED_IP_WARMUP_DAILY_GROWTH_LIMIT) ** (day - 1),
  );
  if (!Number.isSafeInteger(ceiling)) {
    throw new RangeError("Warm-up day exceeds the supported integer range.");
  }
  return ceiling;
}

/**
 * Shared-IP domain ramps and recovery plans require evidence-based caps; the
 * dedicated-IP formula must not leak into those modes.
 */
export function reputationDailyVolumeCeiling(
  mode: ReputationMode,
  day: number,
): number | null {
  if (!(REPUTATION_MODES as readonly string[]).includes(mode)) {
    throw new RangeError("Unsupported reputation mode.");
  }
  return mode === "dedicated_ip_warmup"
    ? dedicatedIpWarmupDailyCeiling(day)
    : null;
}

export function dedicatedIpWarmupIncreaseAllowed(
  previousDailyVolume: number,
  proposedDailyVolume: number,
): boolean {
  assertCount("previousDailyVolume", previousDailyVolume);
  assertCount("proposedDailyVolume", proposedDailyVolume);
  return (
    proposedDailyVolume <=
    Math.floor(
      previousDailyVolume *
        (1 + DEDICATED_IP_WARMUP_DAILY_GROWTH_LIMIT),
    )
  );
}

function normalizeDeliverabilityEvent(
  input: DeliverabilityEventInput,
): NormalizedDeliverabilityEvent {
  const description = normalizedDiagnostic(input.description);
  return {
    event: normalizedToken(input.event),
    severity: normalizedToken(input.severity),
    reason: normalizedToken(input.reason),
    description,
    enhancedStatusCode:
      normalizedEnhancedStatusCode(input.enhancedStatusCode) ??
      enhancedStatusCodeFromText(description),
    smtpCode: normalizedSmtpCode(input.smtpCode),
  };
}

function isAccepted(input: NormalizedDeliverabilityEvent): boolean {
  return input.event === "accepted";
}

function isDelivered(input: NormalizedDeliverabilityEvent): boolean {
  return input.event === "delivered";
}

function isComplaintEvent(input: NormalizedDeliverabilityEvent): boolean {
  return [
    isComplaint(input.event),
    isComplaint(input.reason),
    input.reason === "suppress-complaint",
  ].includes(true);
}

function isUnsubscribeEvent(input: NormalizedDeliverabilityEvent): boolean {
  return [
    isUnsubscribe(input.event),
    isUnsubscribe(input.reason),
    input.reason === "suppress-unsubscribe",
  ].includes(true);
}

function isHardBounceEvent(input: NormalizedDeliverabilityEvent): boolean {
  return [
    HARD_BOUNCE_EVENTS.has(input.event),
    HARD_BOUNCE_REASONS.has(input.reason),
    enhancedStatusStartsWith(input.enhancedStatusCode, "5.1."),
    HARD_BOUNCE_DIAGNOSTIC.test(input.description),
  ].includes(true);
}

function isAuthenticationFailure(
  input: NormalizedDeliverabilityEvent,
): boolean {
  return [
    isAuthenticationEnhancedStatus(input.enhancedStatusCode),
    AUTHENTICATION_DIAGNOSTIC.test(diagnosticText(input)),
  ].includes(true);
}

function isPolicyBlock(input: NormalizedDeliverabilityEvent): boolean {
  return [
    input.reason === "espblock",
    enhancedStatusStartsWith(input.enhancedStatusCode, "5.7."),
    POLICY_DIAGNOSTIC.test(diagnosticText(input)),
  ].includes(true);
}

function isTemporaryFailure(input: NormalizedDeliverabilityEvent): boolean {
  return [
    TEMPORARY_FAILURE_EVENTS.has(input.event),
    input.severity === "temporary",
    smtpCodeIsClass(input.smtpCode, 4),
  ].includes(true);
}

function isPermanentFailure(input: NormalizedDeliverabilityEvent): boolean {
  return [
    PERMANENT_FAILURE_EVENTS.has(input.event),
    input.severity === "permanent",
    smtpCodeIsClass(input.smtpCode, 5),
  ].includes(true);
}

function diagnosticText(input: NormalizedDeliverabilityEvent): string {
  return `${input.reason} ${input.description}`;
}

function enhancedStatusStartsWith(
  value: string | null,
  prefix: string,
): boolean {
  return value !== null && value.startsWith(prefix);
}

function smtpCodeIsClass(value: number | null, expectedClass: number): boolean {
  return value !== null && Math.floor(value / 100) === expectedClass;
}

type NormalizedDeliverabilityCounts = DeliverabilityCounts & {
  policyBlocked: number;
  authFailed: number;
  otherPermanentFailed: number;
};

type GmailCounts = {
  delivered: number;
  spamReported: number;
};

function normalizedDeliverabilityCounts(
  input: DeliverabilityCounts,
): NormalizedDeliverabilityCounts {
  return {
    ...input,
    policyBlocked: input.policyBlocked ?? 0,
    authFailed: input.authFailed ?? 0,
    otherPermanentFailed: input.otherPermanentFailed ?? 0,
  };
}

function validateDeliverabilityCounts(
  counts: NormalizedDeliverabilityCounts,
): void {
  for (const [name, value] of Object.entries(counts)) {
    if (value !== undefined) assertCount(name, value);
  }

  const relationships: readonly (readonly [string, number, string, number])[] = [
    ["accepted", counts.accepted, "attempted", counts.attempted],
    ["delivered", counts.delivered, "accepted", counts.accepted],
    ["hardBounced", counts.hardBounced, "accepted", counts.accepted],
    [
      "temporarilyFailed",
      counts.temporarilyFailed,
      "accepted",
      counts.accepted,
    ],
    ["policyBlocked", counts.policyBlocked, "accepted", counts.accepted],
    ["authFailed", counts.authFailed, "accepted", counts.accepted],
    [
      "otherPermanentFailed",
      counts.otherPermanentFailed,
      "accepted",
      counts.accepted,
    ],
    ["complained", counts.complained, "delivered", counts.delivered],
    ["unsubscribed", counts.unsubscribed, "delivered", counts.delivered],
  ];
  for (const relationship of relationships) {
    assertNotGreater(...relationship);
  }
}

function validatedGmailCounts(
  counts: NormalizedDeliverabilityCounts,
): GmailCounts | null {
  const gmailDelivered = counts.gmailDelivered;
  const gmailSpamReported = counts.gmailSpamReported;
  const providedCount = [gmailDelivered, gmailSpamReported].filter(
    (value) => value !== undefined,
  ).length;
  if (providedCount === 0) return null;
  if (providedCount !== 2) {
    throw new RangeError(
      "gmailDelivered and gmailSpamReported must be provided together.",
    );
  }
  const delivered = gmailDelivered as number;
  const spamReported = gmailSpamReported as number;
  assertNotGreater(
    "gmailDelivered",
    delivered,
    "delivered",
    counts.delivered,
  );
  assertNotGreater(
    "gmailSpamReported",
    spamReported,
    "gmailDelivered",
    delivered,
  );
  return { delivered, spamReported };
}

function metricsFromCounts(
  counts: NormalizedDeliverabilityCounts,
  gmailCounts: GmailCounts | null,
): DeliverabilityMetrics {
  return {
    acceptance: rate(counts.accepted, counts.attempted, "attempted"),
    delivery: rate(counts.delivered, counts.accepted, "accepted"),
    hardBounce: rate(counts.hardBounced, counts.accepted, "accepted"),
    complaint: rate(counts.complained, counts.delivered, "delivered"),
    unsubscribe: rate(counts.unsubscribed, counts.delivered, "delivered"),
    temporaryFailure: rate(
      counts.temporarilyFailed,
      counts.accepted,
      "accepted",
    ),
    policyBlock: rate(counts.policyBlocked, counts.accepted, "accepted"),
    authFailure: rate(counts.authFailed, counts.accepted, "accepted"),
    otherPermanentFailure: rate(
      counts.otherPermanentFailed,
      counts.accepted,
      "accepted",
    ),
    gmailSpam: gmailCounts
      ? rate(gmailCounts.spamReported, gmailCounts.delivered, "gmail_delivered")
      : null,
  };
}

function normalizedDomain(value: string): string | null {
  const normalized = value.trim().toLowerCase().replace(/\.+$/u, "");
  if (!validDomainShape(normalized)) return null;
  return normalized.split(".").every(validDomainLabel) ? normalized : null;
}

function validDomainShape(value: string): boolean {
  return [
    value.length > 0,
    value.length <= 253,
    value.includes("."),
    !value.includes("@"),
  ].every(Boolean);
}

function validDomainLabel(label: string): boolean {
  return [
    label.length > 0,
    label.length <= 63,
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
  ].every(Boolean);
}

function normalizedToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-");
}

function normalizedDiagnostic(value: string | null | undefined): string {
  return (value ?? "").trim().toLowerCase().slice(0, 4_096);
}

function normalizedSmtpCode(value: number | string | null | undefined): number | null {
  if (typeof value === "number") return validSmtpCode(value);
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^(\d{3})(?:\b|\s)/u);
  if (!match) return null;
  return validSmtpCode(Number(match[1]));
}

function validSmtpCode(value: number): number | null {
  return Number.isInteger(value) && value >= 100 && value <= 599
    ? value
    : null;
}

function normalizedEnhancedStatusCode(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const match = value.trim().match(/^([245]\.\d{1,3}\.\d{1,3})(?:\b|\s)/u);
  return match?.[1] ?? null;
}

function enhancedStatusCodeFromText(value: string): string | null {
  return value.match(/\b([245]\.\d{1,3}\.\d{1,3})\b/u)?.[1] ?? null;
}

function isAuthenticationEnhancedStatus(value: string | null): boolean {
  return Boolean(
    value &&
      /^5\.7\.(?:23|24|25|26|27|29|30|31|32)$/u.test(value),
  );
}

function isComplaint(value: string): boolean {
  return value === "complaint" || value === "complained";
}

function isUnsubscribe(value: string): boolean {
  return (
    value === "unsubscribe" ||
    value === "unsubscribed" ||
    value === "unsubscription"
  );
}

function assertCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function assertNotGreater(
  numeratorName: string,
  numerator: number,
  denominatorName: string,
  denominator: number,
): void {
  if (numerator > denominator) {
    throw new RangeError(
      `${numeratorName} cannot exceed ${denominatorName}.`,
    );
  }
}

function rate(
  numerator: number,
  denominator: number,
  denominatorKind: DeliverabilityDenominator,
): DeliverabilityRateMetric {
  const ratio = denominator === 0 ? null : numerator / denominator;
  return {
    numerator,
    denominator,
    denominatorKind,
    ratio,
    percent: ratio === null ? null : ratio * 100,
  };
}

function evaluateMaximumRate(
  metric: DeliverabilityRateMetric,
  minimumSampleSize: number,
  warningAt: number,
  criticalAt: number,
): EvaluatedDeliverabilityMetric {
  if (insufficient(metric, minimumSampleSize)) {
    return { ...metric, status: "insufficient_data" };
  }
  if (metric.percent! >= criticalAt) {
    return { ...metric, status: "critical" };
  }
  if (metric.percent! >= warningAt) {
    return { ...metric, status: "warning" };
  }
  return { ...metric, status: "target" };
}

function evaluateMinimumRate(
  metric: DeliverabilityRateMetric,
  minimumSampleSize: number,
  warningBelow: number,
  criticalBelow: number,
): EvaluatedDeliverabilityMetric {
  if (insufficient(metric, minimumSampleSize)) {
    return { ...metric, status: "insufficient_data" };
  }
  if (metric.percent! < criticalBelow) {
    return { ...metric, status: "critical" };
  }
  if (metric.percent! < warningBelow) {
    return { ...metric, status: "warning" };
  }
  return { ...metric, status: "target" };
}

function evaluateCriticalAbove(
  metric: DeliverabilityRateMetric,
  minimumSampleSize: number,
  criticalAbove: number,
): EvaluatedDeliverabilityMetric {
  if (insufficient(metric, minimumSampleSize)) {
    return { ...metric, status: "insufficient_data" };
  }
  return {
    ...metric,
    status: metric.percent! > criticalAbove ? "critical" : "target",
  };
}

function insufficient(
  metric: DeliverabilityRateMetric,
  minimumSampleSize: number,
): boolean {
  return metric.percent === null || metric.denominator < minimumSampleSize;
}

function overallStatus(
  actionableStatuses: readonly DeliverabilityThresholdStatus[],
  coreStatuses: readonly DeliverabilityThresholdStatus[],
): DeliverabilityThresholdStatus {
  if (actionableStatuses.includes("critical")) return "critical";
  if (actionableStatuses.includes("warning")) return "warning";
  if (coreStatuses.includes("insufficient_data")) return "insufficient_data";
  return "target";
}
