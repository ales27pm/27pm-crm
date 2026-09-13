import { normalizeMessageId } from "./mailgun";
import {
  classifyOutboundFailure,
  OutboundSendError,
  type OutboundSendFailureKind,
} from "./outbound-send-outcome";

export type MailgunSendFailureKind = OutboundSendFailureKind;

export function mailgunFailureKindForStatus(
  status: number,
): MailgunSendFailureKind {
  return status === 408 || status === 429 || status >= 500
    ? "outcome_unknown"
    : "rejected";
}

export class MailgunSendError extends OutboundSendError {
  constructor(status: number, kind: MailgunSendFailureKind) {
    super("mailgun", status, kind);
    this.name = "MailgunSendError";
  }
}

export function normalizeAcceptedMailgunMessageId(value: string): string {
  const trimmed = value.trim();
  const exactAngleMatch = trimmed.match(/^<([^<>]+)>$/u);
  if (
    ((trimmed.includes("<") || trimmed.includes(">")) && !exactAngleMatch) ||
    /[\u0000-\u001f\u007f]/u.test(trimmed)
  ) {
    throw new MailgunSendError(502, "outcome_unknown");
  }
  const candidate = exactAngleMatch?.[1] ?? trimmed;
  const normalized = normalizeMessageId(candidate);
  if (
    !normalized ||
    !/^[^<>\s@]+@[^<>\s@]+$/u.test(candidate) ||
    normalized !== candidate.toLowerCase()
  ) {
    throw new MailgunSendError(502, "outcome_unknown");
  }
  return normalized;
}

export function classifyMailgunFailure(
  providerDispatchStarted: boolean,
  cause: unknown,
): "definitive_failure" | "outcome_unknown" {
  return classifyOutboundFailure(providerDispatchStarted, cause);
}
