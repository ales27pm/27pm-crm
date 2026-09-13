export type OutboundSendFailureKind = "rejected" | "outcome_unknown";

export class OutboundSendError extends Error {
  readonly provider: "mailgun" | "cakemail";
  readonly status: number;
  readonly kind: OutboundSendFailureKind;

  constructor(
    provider: "mailgun" | "cakemail",
    status: number,
    kind: OutboundSendFailureKind,
  ) {
    super(
      kind === "rejected"
        ? `${provider} rejected the send request.`
        : `The ${provider} send outcome is unknown.`,
    );
    this.name = "OutboundSendError";
    this.provider = provider;
    this.status = status;
    this.kind = kind;
  }
}

/**
 * Once a network dispatch begins, only an explicit provider rejection is safe
 * to classify as definitive. Every other failure remains non-retryable because
 * the provider may already have accepted the message.
 */
export function classifyOutboundFailure(
  providerDispatchStarted: boolean,
  cause: unknown,
): "definitive_failure" | "outcome_unknown" {
  if (!providerDispatchStarted) return "definitive_failure";
  if (cause instanceof OutboundSendError && cause.kind === "rejected") {
    return "definitive_failure";
  }
  return "outcome_unknown";
}
