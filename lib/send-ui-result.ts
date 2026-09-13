import { shouldRetainSendAttempt } from "./send-attempt-registry";

export type SendUiOutcome =
  | "accepted"
  | "definitive_failure"
  | "outcome_unknown"
  | "local_repair";

export type SendUiResult = {
  outcome: SendUiOutcome;
  message: string;
};

export const UNKNOWN_SEND_MESSAGE =
  "Résultat d’envoi inconnu : ne modifiez pas le brouillon et ne le renvoyez pas. Vérifiez le journal du fournisseur, puis utilisez la résolution administrative.";

export const LOCAL_REPAIR_MESSAGE =
  "Courriel accepté par le transport; réessayez sans modifier le brouillon pour réparer son enregistrement CRM sans le renvoyer.";

export function classifyMessageSendHttpResponse(
  status: number,
  body: { accepted?: unknown; crmRecorded?: unknown; error?: unknown },
): SendUiOutcome {
  if (status >= 200 && status <= 299) {
    if (body.accepted !== true) return "outcome_unknown";
    if (body.crmRecorded === true) return "accepted";
    if (body.crmRecorded === false) return "local_repair";
    return "outcome_unknown";
  }
  return failureOutcome(status, body.error);
}

export function classifyCanarySendHttpResponse(
  status: number,
  body: { accepted?: unknown; error?: unknown },
): SendUiOutcome {
  if (status >= 200 && status <= 299) {
    return body.accepted === true ? "accepted" : "outcome_unknown";
  }
  return failureOutcome(status, body.error);
}

function failureOutcome(
  status: number,
  error: unknown,
): "definitive_failure" | "outcome_unknown" {
  return shouldRetainSendAttempt(
    status,
    typeof error === "string" ? error : null,
  )
    ? "outcome_unknown"
    : "definitive_failure";
}
