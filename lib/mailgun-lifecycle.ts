export const OUTBOUND_DELIVERY_STATES = [
  "accepted",
  "delivered",
  "bounced",
  "complained",
  "temporary-failure",
  "permanent-failure",
] as const;

export type OutboundDeliveryState =
  (typeof OUTBOUND_DELIVERY_STATES)[number];

export type MessageDeliveryState = "received" | OutboundDeliveryState;

export type MailgunRecipientSuppression =
  | "bounce"
  | "complaint"
  | "unsubscribe";

export type DeliveryTimelineEvent = {
  state: OutboundDeliveryState;
  occurredAt: string;
  sequence?: number;
};

export type DeliveryPresentation = {
  label: string;
  guidance: string;
  tone: "pending" | "success" | "warning" | "danger";
};

export const DELIVERY_PRESENTATION: Record<
  OutboundDeliveryState,
  DeliveryPresentation
> = {
  accepted: {
    label: "Accepté par le transport",
    guidance:
      "Le fournisseur d’envoi a accepté le message et l’a placé en file d’attente.",
    tone: "pending",
  },
  delivered: {
    label: "Livré",
    guidance:
      "Le serveur du destinataire a accepté la remise SMTP. Cela confirme uniquement le transfert au serveur et ne confirme pas le placement dans la boîte de réception.",
    tone: "success",
  },
  bounced: {
    label: "Rebond",
    guidance:
      "Vérifiez et corrigez l’adresse du destinataire avant tout nouvel envoi.",
    tone: "danger",
  },
  complained: {
    label: "Plainte pour indésirable",
    guidance:
      "Suspendez tout nouvel envoi à cette adresse et vérifiez le consentement dans le journal fournisseur.",
    tone: "danger",
  },
  "temporary-failure": {
    label: "Échec temporaire",
    guidance:
      "Le fournisseur peut réessayer automatiquement. Surveillez le prochain événement avant de renvoyer.",
    tone: "warning",
  },
  "permanent-failure": {
    label: "Échec permanent",
    guidance:
      "Le fournisseur ne réessaiera pas. Vérifiez l’adresse, le domaine et son journal avant un nouvel envoi.",
    tone: "danger",
  },
};

const DIRECT_DELIVERY_STATES = new Map<string, OutboundDeliveryState>([
  ["accepted", "accepted"],
  ["delivered", "delivered"],
  ["bounce", "bounced"],
  ["bounced", "bounced"],
  ["complaint", "complained"],
  ["complained", "complained"],
  ["temporary-fail", "temporary-failure"],
  ["temporary-failure", "temporary-failure"],
]);

const DIRECT_RECIPIENT_SUPPRESSIONS = new Map<
  string,
  MailgunRecipientSuppression
>([
  ["bounce", "bounce"],
  ["bounced", "bounce"],
  ["complaint", "complaint"],
  ["complained", "complaint"],
  ["unsubscribe", "unsubscribe"],
  ["unsubscribed", "unsubscribe"],
]);

const PERMANENT_FAILURE_EVENT_TYPES = new Set([
  "permanent-fail",
  "permanent-failure",
  "rejected",
]);

const PERMANENT_REASON_SUPPRESSIONS = new Map<
  string,
  MailgunRecipientSuppression
>([
  ["bounce", "bounce"],
  ["suppress-bounce", "bounce"],
  ["suppress-complaint", "complaint"],
  ["suppress-unsubscribe", "unsubscribe"],
]);

const PERMANENT_DELIVERY_STATES: Record<
  MailgunRecipientSuppression,
  OutboundDeliveryState
> = {
  bounce: "bounced",
  complaint: "complained",
  unsubscribe: "permanent-failure",
};

const DELIVERY_STATE_TIE_BREAK_RANK: Record<OutboundDeliveryState, number> = {
  accepted: 0,
  "temporary-failure": 1,
  delivered: 2,
  bounced: 3,
  "permanent-failure": 4,
  complained: 5,
};

const STORED_STATE_ALIASES = new Map<string, OutboundDeliveryState>([
  ["queued", "accepted"],
  ["failed", "permanent-failure"],
]);

export function mailgunDeliveryState(input: {
  eventType: string;
  severity?: string | null;
  reason?: string | null;
}): OutboundDeliveryState | null {
  const eventType = normalizeToken(input.eventType);
  const severity = normalizeToken(input.severity);
  const recipientSuppression = mailgunRecipientSuppression(input);
  const directState = DIRECT_DELIVERY_STATES.get(eventType);
  if (directState) return directState;
  if (PERMANENT_FAILURE_EVENT_TYPES.has(eventType)) {
    return permanentDeliveryState(recipientSuppression);
  }
  return failedDeliveryState(eventType, severity, recipientSuppression);
}

function failedDeliveryState(
  eventType: string,
  severity: string,
  recipientSuppression: MailgunRecipientSuppression | null,
): OutboundDeliveryState | null {
  if (eventType !== "failed") return null;
  if (severity === "temporary") return "temporary-failure";
  if (severity !== "permanent") return null;
  return permanentDeliveryState(recipientSuppression);
}

/**
 * Returns only Mailgun signals that prove a recipient-level suppression.
 * Provider policy, reputation, and generic permanent failures deliberately do
 * not qualify: those require operational investigation, not identity blocking.
 */
export function mailgunRecipientSuppression(input: {
  eventType: string;
  severity?: string | null;
  reason?: string | null;
}): MailgunRecipientSuppression | null {
  const eventType = normalizeToken(input.eventType);
  const severity = normalizeToken(input.severity);
  const reason = normalizeToken(input.reason);
  const directSuppression = DIRECT_RECIPIENT_SUPPRESSIONS.get(eventType);
  if (directSuppression) return directSuppression;
  if (!isPermanentFailure(eventType, severity)) return null;
  return PERMANENT_REASON_SUPPRESSIONS.get(reason) ?? null;
}

function isPermanentFailure(eventType: string, severity: string): boolean {
  return (
    PERMANENT_FAILURE_EVENT_TYPES.has(eventType) ||
    (eventType === "failed" && severity === "permanent")
  );
}

function permanentDeliveryState(
  suppression: MailgunRecipientSuppression | null,
): OutboundDeliveryState {
  return suppression
    ? PERMANENT_DELIVERY_STATES[suppression]
    : "permanent-failure";
}

export function storedMessageDeliveryState(
  status: string,
  direction: "inbound" | "outbound",
): MessageDeliveryState {
  if (direction === "inbound") return "received";
  return outboundStoredState(status);
}

function outboundStoredState(status: string): OutboundDeliveryState {
  const normalized = normalizeToken(status);
  if (isOutboundDeliveryState(normalized)) return normalized;
  return STORED_STATE_ALIASES.get(normalized) ?? "accepted";
}

export function mailgunReasonFromPayloadJson(
  payloadJson: string | null | undefined,
): string | null {
  return stringProperty(parsedJsonRecord(payloadJson), "reason");
}

function parsedJsonRecord(
  payloadJson: string | null | undefined,
): Record<string, unknown> | null {
  if (!payloadJson) return null;
  try {
    const payload: unknown = JSON.parse(payloadJson);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

function stringProperty(
  record: Record<string, unknown> | null,
  property: string,
): string | null {
  if (!record) return null;
  const value = record[property];
  return typeof value === "string" ? value : null;
}

export function buildDeliveryTimeline(input: {
  messageOccurredAt: string;
  storedState: OutboundDeliveryState;
  providerEvents: readonly DeliveryTimelineEvent[];
}): DeliveryTimelineEvent[] {
  const timeline: TimelineEntry[] = [];
  if (input.providerEvents.length > 0) {
    if (!input.providerEvents.some((event) => event.state === "accepted")) {
      timeline.push({
        event: {
          state: "accepted",
          occurredAt: earliestTimestamp([
            input.messageOccurredAt,
            ...input.providerEvents.map((event) => event.occurredAt),
          ]),
        },
        inputIndex: -1,
        synthetic: true,
      });
    }
    timeline.push(
      ...input.providerEvents.map((event, inputIndex) => ({
        event,
        inputIndex,
        synthetic: false,
      })),
    );
  } else {
    timeline.push({
      event: { state: "accepted", occurredAt: input.messageOccurredAt },
      inputIndex: -1,
      synthetic: true,
    });
    if (input.storedState !== "accepted") {
      timeline.push({
        event: {
          state: input.storedState,
          occurredAt: input.messageOccurredAt,
        },
        inputIndex: 0,
        synthetic: false,
      });
    }
  }

  timeline.sort(compareTimelineEntries);
  return uniqueTimelineEvents(timeline.map(({ event }) => event));
}

type TimelineEntry = {
  event: DeliveryTimelineEvent;
  inputIndex: number;
  synthetic: boolean;
};

function compareTimelineEntries(
  left: TimelineEntry,
  right: TimelineEntry,
): number {
  const structuralOrder = firstComparison([
    compareTimestamps(left.event.occurredAt, right.event.occurredAt),
    compareSyntheticState(left.synthetic, right.synthetic),
    compareSequences(left.event.sequence, right.event.sequence),
  ]);
  if (structuralOrder !== null) return structuralOrder;

  const stateOrder =
    DELIVERY_STATE_TIE_BREAK_RANK[left.event.state] -
    DELIVERY_STATE_TIE_BREAK_RANK[right.event.state];
  return stateOrder || left.inputIndex - right.inputIndex;
}

function compareTimestamps(left: string, right: string): number | null {
  const order = timestampValue(left) - timestampValue(right);
  return order !== 0 ? order : null;
}

function compareSyntheticState(left: boolean, right: boolean): number | null {
  if (left === right) return null;
  return left ? -1 : 1;
}

function firstComparison(comparisons: readonly (number | null)[]): number | null {
  for (const comparison of comparisons) {
    if (comparison !== null) return comparison;
  }
  return null;
}

function compareSequences(
  left: number | undefined,
  right: number | undefined,
): number | null {
  if (!Number.isFinite(left) || !Number.isFinite(right) || left === right) {
    return null;
  }
  return left! - right!;
}

function uniqueTimelineEvents(
  events: readonly DeliveryTimelineEvent[],
): DeliveryTimelineEvent[] {
  const seen = new Set<string>();
  const unique: DeliveryTimelineEvent[] = [];
  for (const event of events) {
    const key = JSON.stringify([event.state, event.occurredAt]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(event);
  }
  return unique;
}

function isOutboundDeliveryState(
  value: string,
): value is OutboundDeliveryState {
  return (OUTBOUND_DELIVERY_STATES as readonly string[]).includes(value);
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function timestampValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? Number.POSITIVE_INFINITY : timestamp;
}

function earliestTimestamp(values: readonly string[]): string {
  return values.reduce((earliest, value) =>
    timestampValue(value) < timestampValue(earliest) ? value : earliest,
  );
}
