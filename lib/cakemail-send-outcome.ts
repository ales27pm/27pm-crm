import {
  classifyOutboundFailure,
  OutboundSendError,
  type OutboundSendFailureKind,
} from "./outbound-send-outcome";

export type CakemailSendFailureKind = OutboundSendFailureKind;

export function cakemailFailureKindForStatus(
  status: number,
): CakemailSendFailureKind {
  return status >= 400 &&
    status < 500 &&
    status !== 408 &&
    status !== 429
    ? "rejected"
    : "outcome_unknown";
}

export class CakemailSendError extends OutboundSendError {
  constructor(status: number, kind: CakemailSendFailureKind) {
    super("cakemail", status, kind);
    this.name = "CakemailSendError";
  }
}

export function classifyCakemailFailure(
  providerDispatchStarted: boolean,
  cause: unknown,
): "definitive_failure" | "outcome_unknown" {
  return classifyOutboundFailure(providerDispatchStarted, cause);
}
