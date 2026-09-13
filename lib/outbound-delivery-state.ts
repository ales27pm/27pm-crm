import {
  mailgunDeliveryState,
  mailgunReasonFromPayloadJson,
  type OutboundDeliveryState,
} from "./mailgun-lifecycle";

export type EventTransportProvider = "mailgun" | "cakemail";

export type StoredProviderDeliveryEvent = {
  eventType: string;
  severity?: string | null;
  reason?: string | null;
  failureClass?: string | null;
  payloadJson?: string | null;
};

/**
 * Maps one normalized provider event onto the CRM delivery timeline. Mailgun's
 * legacy `suppress-*` reason vocabulary is deliberately unavailable to
 * Cakemail; Cakemail is classified from the normalized failure class instead.
 */
export function providerDeliveryState(
  provider: EventTransportProvider,
  event: StoredProviderDeliveryEvent,
): OutboundDeliveryState | null {
  if (provider === "cakemail") return cakemailDeliveryState(event);
  return mailgunDeliveryState({
    eventType: event.eventType,
    severity: event.severity,
    reason:
      event.reason ?? mailgunReasonFromPayloadJson(event.payloadJson),
  });
}

function cakemailDeliveryState(
  event: StoredProviderDeliveryEvent,
): OutboundDeliveryState | null {
  const eventType = token(event.eventType);
  const failureClass = token(event.failureClass);
  if (eventType === "accepted") return "accepted";
  if (eventType === "delivered") return "delivered";
  if (eventType === "complained" || failureClass === "complaint") {
    return "complained";
  }
  if (eventType === "unsubscribed" || failureClass === "unsubscribe") {
    return "permanent-failure";
  }
  if (failureClass === "hard_bounce") return "bounced";
  if (failureClass === "temporary") return "temporary-failure";
  if (
    eventType === "rejected" ||
    ["policy_block", "auth_failure", "other_permanent"].includes(failureClass)
  ) {
    return "permanent-failure";
  }
  return null;
}

function token(value: string | null | undefined): string {
  return value?.trim().toLowerCase().replaceAll("-", "_") ?? "";
}
