import { normalizeMessageId } from "./mailgun";

export type MailgunSendFailureKind = "rejected" | "outcome_unknown";

export function mailgunFailureKindForStatus(
  status: number,
): MailgunSendFailureKind {
  return status >= 500 ? "outcome_unknown" : "rejected";
}

export class MailgunSendError extends Error {
  readonly status: number;
  readonly kind: MailgunSendFailureKind;

  constructor(status: number, kind: MailgunSendFailureKind) {
    super(
      kind === "rejected"
        ? "Mailgun rejected the send request."
        : "The Mailgun send outcome is unknown.",
    );
    this.name = "MailgunSendError";
    this.status = status;
    this.kind = kind;
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
  if (!providerDispatchStarted) return "definitive_failure";
  if (cause instanceof MailgunSendError && cause.kind === "rejected") {
    return "definitive_failure";
  }
  return "outcome_unknown";
}
