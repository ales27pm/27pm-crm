import {
  buildDeliverabilityMetrics,
  evaluateDeliverabilityThresholds,
  mailboxProviderForAddress,
  MAILBOX_PROVIDERS,
  type DeliverabilityCounts,
  type DeliverabilityEventClass,
  type DeliverabilityMetrics,
  type DeliverabilityThresholdEvaluation,
  type MailboxProvider,
} from "./deliverability-policy";

export type DeliverabilityTelemetryEvent = {
  eventType: string;
  reason: string | null;
  eventClass: DeliverabilityEventClass | null;
  mailboxProvider: MailboxProvider | null;
  sendingDomain: string | null;
  sendingIp: string | null;
  tags: readonly string[];
  occurredAt: string;
};

export type DeliverabilityTelemetryMessage = {
  id: string;
  transportProvider?: "mailgun" | "cakemail" | "unknown";
  recipient: string;
  trafficType: string;
  tags: readonly string[];
  status: string;
  occurredAt: string;
  events: readonly DeliverabilityTelemetryEvent[];
};

export type DeliverabilitySignal =
  | "complaint"
  | "hard_bounce"
  | "policy_block"
  | "auth_failure"
  | "temporary_failure"
  | "provider_suppression"
  | "pending";

type SegmentCounts = Required<
  Omit<DeliverabilityCounts, "gmailDelivered" | "gmailSpamReported">
> & {
  providerSuppressed: number;
  pending: number;
};

export type DeliverabilitySegment = {
  key: string;
  label: string;
  counts: SegmentCounts;
  metrics: DeliverabilityMetrics;
  evaluation: DeliverabilityThresholdEvaluation;
  signals: DeliverabilitySignal[];
};

export type DeliverabilitySummary = {
  overall: DeliverabilitySegment;
  transports: DeliverabilitySegment[];
  providers: DeliverabilitySegment[];
  sendingDomains: DeliverabilitySegment[];
  sendingIps: DeliverabilitySegment[];
  trafficTypes: DeliverabilitySegment[];
  tags: DeliverabilitySegment[];
  dataQuality: {
    messages: number;
    events: number;
    providerUnknown: number;
    withoutTerminalTransport: number;
    latestEventAt: string | null;
    messagesWithTagTruncation: number;
    tagSegmentsTruncated: boolean;
  };
};

type ClassifiedMessage = {
  source: DeliverabilityTelemetryMessage;
  transportProvider: "mailgun" | "cakemail" | "unknown";
  provider: MailboxProvider;
  sendingDomain: string;
  sendingIp: string;
  tags: string[];
  tagsTruncated: boolean;
  counts: SegmentCounts;
};

type EventFacts = {
  provider: MailboxProvider | null;
  sendingDomain: string | null;
  sendingIp: string | null;
  eventTypes: Set<string>;
  eventClasses: Set<DeliverabilityEventClass>;
  reasons: Set<string>;
};

type MessageOutcomes = {
  delivered: boolean;
  hardBounced: boolean;
  complained: boolean;
  unsubscribed: boolean;
  temporarilyFailed: boolean;
  policyBlocked: boolean;
  authFailed: boolean;
  otherPermanent: boolean;
  providerSuppressed: boolean;
  pending: boolean;
};

type BoundedStrings = {
  values: string[];
  truncated: boolean;
};

type GroupedTagSegments = {
  segments: DeliverabilitySegment[];
  truncated: boolean;
};

const MAX_TAGS_PER_MESSAGE = 32;
const MAX_TAG_SEGMENTS = 256;
const DELIVERED_EVENT_TYPES = new Set([
  "delivered",
  "complained",
  "complaint",
  "unsubscribed",
  "unsubscribe",
]);
const COMPLAINT_EVENT_TYPES = new Set(["complained", "complaint"]);
const UNSUBSCRIBE_EVENT_TYPES = new Set(["unsubscribed", "unsubscribe"]);

const EMPTY_COUNTS: SegmentCounts = {
  attempted: 0,
  accepted: 0,
  delivered: 0,
  hardBounced: 0,
  complained: 0,
  unsubscribed: 0,
  temporarilyFailed: 0,
  policyBlocked: 0,
  authFailed: 0,
  otherPermanentFailed: 0,
  providerSuppressed: 0,
  pending: 0,
};

export function summarizeDeliverability(
  messages: readonly DeliverabilityTelemetryMessage[],
  options: { minimumSampleSize?: number } = {},
): DeliverabilitySummary {
  const classified = messages.map(classifyMessage);
  const allEvents = messages.flatMap((message) => message.events);
  const tagSegments = groupedTagSegments(classified, options);
  const latestEventAt = allEvents
    .map((event) => event.occurredAt)
    .filter(validTimestamp)
    .toSorted()
    .at(-1) ?? null;

  return {
    overall: segment("all", "Tous les fournisseurs", classified, options),
    transports: groupedSegments(
      classified,
      (message) => message.transportProvider,
      options,
    ).map((transport) => ({
      ...transport,
      label: transportLabel(transport.key),
    })),
    providers: MAILBOX_PROVIDERS.map((provider) =>
      segment(
        provider,
        providerLabel(provider),
        classified.filter((message) => message.provider === provider),
        options,
      ),
    ),
    sendingDomains: groupedSegments(
      classified,
      (message) => message.sendingDomain,
      options,
    ),
    sendingIps: groupedSegments(
      classified,
      (message) => message.sendingIp,
      options,
    ),
    trafficTypes: groupedSegments(
      classified,
      (message) => message.source.trafficType || "unclassified",
      options,
    ),
    tags: tagSegments.segments,
    dataQuality: {
      messages: classified.length,
      events: allEvents.length,
      providerUnknown: classified.filter((message) => message.provider === "other")
        .length,
      withoutTerminalTransport: classified.filter(
        (message) => message.counts.pending === 1,
      ).length,
      latestEventAt,
      messagesWithTagTruncation: classified.filter(
        (message) => message.tagsTruncated,
      ).length,
      tagSegmentsTruncated: tagSegments.truncated,
    },
  };
}

function classifyMessage(
  source: DeliverabilityTelemetryMessage,
): ClassifiedMessage {
  const transportProvider = normalizedTransportProvider(
    source.transportProvider,
  );
  const events = [...source.events].toSorted((left, right) =>
    left.occurredAt.localeCompare(right.occurredAt),
  );
  const facts = inspectEvents(events);
  const outcomes = classifyOutcomes(
    source.status,
    events.length,
    facts,
    transportProvider,
  );
  const tags = collectMessageTags(source.tags, events);

  return {
    source,
    transportProvider,
    provider: facts.provider ?? mailboxProviderForAddress(source.recipient),
    sendingDomain: facts.sendingDomain ?? "unknown",
    sendingIp: facts.sendingIp ?? "unknown",
    tags: tags.values,
    tagsTruncated: tags.truncated,
    counts: countsForOutcomes(outcomes),
  };
}

function inspectEvents(
  events: readonly DeliverabilityTelemetryEvent[],
): EventFacts {
  const facts: EventFacts = {
    provider: null,
    sendingDomain: null,
    sendingIp: null,
    eventTypes: new Set(),
    eventClasses: new Set(),
    reasons: new Set(),
  };
  for (const event of events) {
    updateEventDimensions(facts, event);
    facts.eventTypes.add(token(event.eventType));
    addEventClass(facts.eventClasses, event.eventClass);
    facts.reasons.add(token(event.reason));
  }
  return facts;
}

function updateEventDimensions(
  facts: EventFacts,
  event: DeliverabilityTelemetryEvent,
): void {
  if (isStrongProvider(event.mailboxProvider)) {
    facts.provider = event.mailboxProvider;
  }
  if (event.sendingDomain) facts.sendingDomain = event.sendingDomain;
  if (event.sendingIp) facts.sendingIp = event.sendingIp;
}

function addEventClass(
  eventClasses: Set<DeliverabilityEventClass>,
  eventClass: DeliverabilityEventClass | null,
): void {
  if (isEventClass(eventClass)) eventClasses.add(eventClass);
}

function isStrongProvider(
  provider: MailboxProvider | null,
): provider is Exclude<MailboxProvider, "other"> {
  return provider !== null && provider !== "other";
}

function classifyOutcomes(
  status: string,
  eventCount: number,
  facts: EventFacts,
  transportProvider: ClassifiedMessage["transportProvider"],
): MessageOutcomes {
  const delivered = isDeliveredMessage(status, facts.eventTypes);
  const hardBounced = isHardBouncedMessage(
    status,
    eventCount,
    facts,
    transportProvider,
  );
  const complained = hasAny(facts.eventTypes, COMPLAINT_EVENT_TYPES);
  const unsubscribed = hasAny(facts.eventTypes, UNSUBSCRIBE_EVENT_TYPES);
  const temporarilyFailed = facts.eventClasses.has("temporary");
  const policyBlocked = facts.eventClasses.has("policy_block");
  const authFailed = facts.eventClasses.has("auth_failure");
  const otherPermanent = isOtherPermanentMessage(status, eventCount, facts);
  const providerSuppressed =
    transportProvider === "mailgun" && hasProviderSuppression(facts.reasons);
  const terminal = [
    delivered,
    hardBounced,
    otherPermanent,
    policyBlocked,
    authFailed,
    status === "permanent-failure",
    providerSuppressed,
  ].includes(true);

  return {
    delivered,
    hardBounced,
    complained,
    unsubscribed,
    temporarilyFailed,
    policyBlocked,
    authFailed,
    otherPermanent,
    providerSuppressed,
    pending: !terminal,
  };
}

function isDeliveredMessage(status: string, eventTypes: Set<string>): boolean {
  return [hasAny(eventTypes, DELIVERED_EVENT_TYPES), status === "delivered"].includes(
    true,
  );
}

function isHardBouncedMessage(
  status: string,
  eventCount: number,
  facts: EventFacts,
  transportProvider: ClassifiedMessage["transportProvider"],
): boolean {
  return [
    hasUnsuppressedHardBounce(facts, transportProvider),
    isStatusWithoutEvents(status, eventCount, "bounced"),
  ].includes(true);
}

function hasUnsuppressedHardBounce(
  facts: EventFacts,
  transportProvider: ClassifiedMessage["transportProvider"],
): boolean {
  if (
    transportProvider === "mailgun" &&
    facts.reasons.has("suppress-bounce")
  ) {
    return false;
  }
  return facts.eventClasses.has("hard_bounce");
}

function isOtherPermanentMessage(
  status: string,
  eventCount: number,
  facts: EventFacts,
): boolean {
  return [
    facts.eventClasses.has("other_permanent"),
    isStatusWithoutEvents(status, eventCount, "permanent-failure"),
  ].includes(true);
}

function isStatusWithoutEvents(
  status: string,
  eventCount: number,
  expected: string,
): boolean {
  return eventCount === 0 && status === expected;
}

function hasProviderSuppression(reasons: Set<string>): boolean {
  return [...reasons].some((reason) => reason.startsWith("suppress-"));
}

function hasAny(values: Set<string>, candidates: Set<string>): boolean {
  return [...candidates].some((candidate) => values.has(candidate));
}

function countsForOutcomes(outcomes: MessageOutcomes): SegmentCounts {
  return {
    attempted: 1,
    accepted: 1,
    delivered: Number(outcomes.delivered),
    hardBounced: Number(outcomes.hardBounced),
    complained: Number(outcomes.complained),
    unsubscribed: Number(outcomes.unsubscribed),
    temporarilyFailed: Number(outcomes.temporarilyFailed),
    policyBlocked: Number(outcomes.policyBlocked),
    authFailed: Number(outcomes.authFailed),
    otherPermanentFailed: Number(outcomes.otherPermanent),
    providerSuppressed: Number(outcomes.providerSuppressed),
    pending: Number(outcomes.pending),
  };
}

function collectMessageTags(
  messageTags: readonly string[],
  events: readonly DeliverabilityTelemetryEvent[],
): BoundedStrings {
  const values: string[] = [];
  let truncated = addSafeTags(values, messageTags, MAX_TAGS_PER_MESSAGE);
  for (const event of events) {
    if (addSafeTags(values, event.tags, MAX_TAGS_PER_MESSAGE)) {
      truncated = true;
    }
  }
  return { values, truncated };
}

function addSafeTags(
  selected: string[],
  candidates: readonly string[],
  limit: number,
): boolean {
  let truncated = false;
  for (const candidate of candidates) {
    if (!safeTag(candidate)) continue;
    if (insertBoundedString(selected, candidate, limit)) truncated = true;
  }
  return truncated;
}

/** Keeps the lexicographically first values so truncation is order-independent. */
function insertBoundedString(
  selected: string[],
  value: string,
  limit: number,
): boolean {
  if (selected.includes(value)) return false;
  selected.push(value);
  selected.sort(compareStrings);
  const truncated = selected.length > limit;
  selected.splice(limit);
  return truncated;
}

function selectBoundedTags(
  messages: readonly ClassifiedMessage[],
  limit: number,
): BoundedStrings {
  const values: string[] = [];
  let truncated = false;
  for (const message of messages) {
    if (addSafeTags(values, message.tags, limit)) truncated = true;
  }
  return { values, truncated };
}

function segment(
  key: string,
  label: string,
  messages: readonly ClassifiedMessage[],
  options: { minimumSampleSize?: number },
): DeliverabilitySegment {
  const counts = messages.reduce(
    (total, message) => addCounts(total, message.counts),
    { ...EMPTY_COUNTS },
  );
  const metrics = buildDeliverabilityMetrics(counts);
  const baseEvaluation = evaluateDeliverabilityThresholds(metrics, options);
  const evaluation =
    counts.accepted > 0 && counts.pending === counts.accepted
      ? {
          ...baseEvaluation,
          overall: "insufficient_data" as const,
          delivery: {
            ...baseEvaluation.delivery,
            status: "insufficient_data" as const,
          },
        }
      : baseEvaluation;
  return {
    key,
    label,
    counts,
    metrics,
    evaluation,
    signals: attentionSignals(counts),
  };
}

function groupedSegments(
  messages: readonly ClassifiedMessage[],
  value: (message: ClassifiedMessage) => string,
  options: { minimumSampleSize?: number },
): DeliverabilitySegment[] {
  const groups = new Map<string, ClassifiedMessage[]>();
  for (const message of messages) {
    appendToGroup(groups, value(message), message);
  }
  return segmentsFromGroups(groups, options);
}

function groupedTagSegments(
  messages: readonly ClassifiedMessage[],
  options: { minimumSampleSize?: number },
): GroupedTagSegments {
  const selected = selectBoundedTags(messages, MAX_TAG_SEGMENTS);
  const groups = new Map<string, ClassifiedMessage[]>(
    selected.values.map((tag) => [tag, []]),
  );
  for (const message of messages) {
    for (const tag of message.tags) {
      const group = groups.get(tag);
      if (group) group.push(message);
    }
  }
  return {
    segments: segmentsFromGroups(groups, options),
    truncated: selected.truncated,
  };
}

function appendToGroup(
  groups: Map<string, ClassifiedMessage[]>,
  key: string,
  message: ClassifiedMessage,
): void {
  const group = groups.get(key);
  if (group) {
    group.push(message);
    return;
  }
  groups.set(key, [message]);
}

function segmentsFromGroups(
  groups: Map<string, ClassifiedMessage[]>,
  options: { minimumSampleSize?: number },
): DeliverabilitySegment[] {
  return [...groups.entries()]
    .toSorted(([left], [right]) => compareStrings(left, right))
    .map(([key, messages]) => segment(key, key, messages, options));
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function addCounts(
  left: SegmentCounts,
  right: SegmentCounts,
): SegmentCounts {
  return {
    attempted: left.attempted + right.attempted,
    accepted: left.accepted + right.accepted,
    delivered: left.delivered + right.delivered,
    hardBounced: left.hardBounced + right.hardBounced,
    complained: left.complained + right.complained,
    unsubscribed: left.unsubscribed + right.unsubscribed,
    temporarilyFailed: left.temporarilyFailed + right.temporarilyFailed,
    policyBlocked: left.policyBlocked + right.policyBlocked,
    authFailed: left.authFailed + right.authFailed,
    otherPermanentFailed:
      left.otherPermanentFailed + right.otherPermanentFailed,
    providerSuppressed: left.providerSuppressed + right.providerSuppressed,
    pending: left.pending + right.pending,
  };
}

function attentionSignals(
  counts: SegmentCounts,
): DeliverabilitySignal[] {
  const candidates: readonly (readonly [DeliverabilitySignal, number])[] = [
    ["complaint", counts.complained],
    ["hard_bounce", counts.hardBounced],
    ["policy_block", counts.policyBlocked],
    ["auth_failure", counts.authFailed],
    ["temporary_failure", counts.temporarilyFailed],
    ["provider_suppression", counts.providerSuppressed],
    ["pending", counts.pending],
  ];
  return candidates
    .filter((candidate) => candidate[1] > 0)
    .map((candidate) => candidate[0]);
}

function providerLabel(provider: MailboxProvider): string {
  return {
    google: "Google / Gmail",
    microsoft: "Microsoft / Outlook",
    yahoo: "Yahoo / AOL",
    other: "Autres / non attribués",
  }[provider];
}

function normalizedTransportProvider(
  provider: DeliverabilityTelemetryMessage["transportProvider"],
): "mailgun" | "cakemail" | "unknown" {
  return provider === "mailgun" || provider === "cakemail"
    ? provider
    : "unknown";
}

function transportLabel(provider: string): string {
  return {
    mailgun: "Mailgun",
    cakemail: "Cakemail",
    unknown: "Transport non attribué",
  }[provider] ?? "Transport non attribué";
}

function isEventClass(
  value: DeliverabilityEventClass | null,
): value is DeliverabilityEventClass {
  return value !== null;
}

function token(value: string | null): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-");
}

function safeTag(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value) && value.length <= 64;
}

function validTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}
