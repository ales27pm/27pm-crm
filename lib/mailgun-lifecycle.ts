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
    label: "Accepté par Mailgun",
    guidance: "Mailgun a accepté le message et l’a placé en file d’attente.",
    tone: "pending",
  },
  delivered: {
    label: "Livré",
    guidance:
      "Le serveur du destinataire a accepté le message. Aucune action n’est requise.",
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
      "Suspendez tout nouvel envoi à cette adresse et vérifiez le consentement dans Mailgun.",
    tone: "danger",
  },
  "temporary-failure": {
    label: "Échec temporaire",
    guidance:
      "Mailgun réessaiera automatiquement. Surveillez le prochain événement avant de renvoyer.",
    tone: "warning",
  },
  "permanent-failure": {
    label: "Échec permanent",
    guidance:
      "Mailgun ne réessaiera pas. Vérifiez l’adresse, le domaine et le journal Mailgun avant un nouvel envoi.",
    tone: "danger",
  },
};

export function mailgunDeliveryState(input: {
  eventType: string;
  severity?: string | null;
  reason?: string | null;
}): OutboundDeliveryState | null {
  const eventType = normalizeToken(input.eventType);
  const severity = normalizeToken(input.severity);
  const reason = normalizeToken(input.reason);

  switch (eventType) {
    case "accepted":
      return "accepted";
    case "delivered":
      return "delivered";
    case "bounce":
    case "bounced":
      return "bounced";
    case "complaint":
    case "complained":
      return "complained";
    case "temporary-fail":
    case "temporary-failure":
      return "temporary-failure";
    case "permanent-fail":
    case "permanent-failure":
    case "rejected":
      return isBounceReason(reason) ? "bounced" : "permanent-failure";
    case "failed":
      if (severity === "temporary") return "temporary-failure";
      if (severity === "permanent") {
        return isBounceReason(reason) ? "bounced" : "permanent-failure";
      }
      return null;
    default:
      return null;
  }
}

export function storedMessageDeliveryState(
  status: string,
  direction: "inbound" | "outbound",
): MessageDeliveryState {
  if (direction === "inbound") return "received";

  const normalized = normalizeToken(status);
  if (isOutboundDeliveryState(normalized)) return normalized;
  if (normalized === "queued") return "accepted";
  if (normalized === "failed") return "permanent-failure";
  return "accepted";
}

export function mailgunReasonFromPayloadJson(
  payloadJson: string | null | undefined,
): string | null {
  if (!payloadJson) return null;
  try {
    const payload: unknown = JSON.parse(payloadJson);
    if (!payload || typeof payload !== "object") return null;
    const reason = (payload as Record<string, unknown>).reason;
    return typeof reason === "string" ? reason : null;
  } catch {
    return null;
  }
}

export function buildDeliveryTimeline(input: {
  messageOccurredAt: string;
  storedState: OutboundDeliveryState;
  providerEvents: readonly DeliveryTimelineEvent[];
}): DeliveryTimelineEvent[] {
  const timeline: Array<{
    event: DeliveryTimelineEvent;
    inputIndex: number;
    synthetic: boolean;
  }> = [];
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

  timeline.sort((left, right) => {
    const timestampOrder =
      timestampValue(left.event.occurredAt) -
      timestampValue(right.event.occurredAt);
    if (timestampOrder !== 0) return timestampOrder;
    if (left.synthetic !== right.synthetic) return left.synthetic ? -1 : 1;

    const leftSequence = left.event.sequence;
    const rightSequence = right.event.sequence;
    if (
      Number.isFinite(leftSequence) &&
      Number.isFinite(rightSequence) &&
      leftSequence !== rightSequence
    ) {
      return leftSequence! - rightSequence!;
    }

    const stateOrder =
      deliveryStateTieBreakRank(left.event.state) -
      deliveryStateTieBreakRank(right.event.state);
    return stateOrder || left.inputIndex - right.inputIndex;
  });

  return timeline.map(({ event }) => event).filter(
    (event, index, events) =>
      !events
        .slice(0, index)
        .some(
          (candidate) =>
            candidate.state === event.state &&
            candidate.occurredAt === event.occurredAt,
        ),
  );
}

function deliveryStateTieBreakRank(state: OutboundDeliveryState): number {
  switch (state) {
    case "accepted":
      return 0;
    case "temporary-failure":
      return 1;
    case "delivered":
      return 2;
    case "bounced":
      return 3;
    case "permanent-failure":
      return 4;
    case "complained":
      return 5;
  }
}

function isOutboundDeliveryState(
  value: string,
): value is OutboundDeliveryState {
  return (OUTBOUND_DELIVERY_STATES as readonly string[]).includes(value);
}

function isBounceReason(reason: string): boolean {
  return reason === "bounce" || reason === "suppress-bounce";
}

function normalizeToken(value: string | null | undefined): string {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[_\s]+/gu, "-");
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
