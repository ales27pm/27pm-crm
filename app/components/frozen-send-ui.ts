import {
  browserFrozenSendDraftRegistry,
  type FrozenSendDraft,
  type FrozenSendDraftRegistry,
  type FrozenSendDraftReservation,
} from "../../lib/frozen-send-draft";
import type { SendAttemptPayload } from "../../lib/send-attempt-registry";
import {
  LOCAL_REPAIR_MESSAGE,
  type SendUiResult,
  UNKNOWN_SEND_MESSAGE,
} from "../../lib/send-ui-result";

export const FROZEN_DRAFT_UNAVAILABLE_MESSAGE =
  "Le brouillon ne peut pas être protégé durablement; rien n’a été transmis.";

export type FrozenSendExecution = {
  acceptedAndSettled: boolean;
  draft: FrozenSendDraft | null;
  message: string;
};

type ExecuteFrozenSendOptions<Payload extends SendAttemptPayload> = {
  slot: string;
  payload: Payload;
  send: (payload: Payload) => Promise<SendUiResult>;
  onReserved: (draft: FrozenSendDraft) => void;
  registry?: FrozenSendDraftRegistry;
};

export function frozenDraftMessage(
  draft: FrozenSendDraft | null,
  emptyMessage = FROZEN_DRAFT_UNAVAILABLE_MESSAGE,
): string {
  if (!draft) return emptyMessage;
  if (draft.outcome === "local_repair") return LOCAL_REPAIR_MESSAGE;
  return UNKNOWN_SEND_MESSAGE;
}

export async function restoreFrozenDraft(
  slot: string,
  registry = browserFrozenSendDraftRegistry(),
): Promise<FrozenSendDraft | null> {
  try {
    return await registry.restore(slot);
  } catch {
    return null;
  }
}

export async function executeFrozenSend<Payload extends SendAttemptPayload>({
  slot,
  payload,
  send,
  onReserved,
  registry = browserFrozenSendDraftRegistry(),
}: ExecuteFrozenSendOptions<Payload>): Promise<FrozenSendExecution> {
  let reservation: FrozenSendDraftReservation;
  try {
    reservation = await registry.reserve(slot, payload);
    onReserved(draftFromReservation(reservation));
  } catch {
    const draft = await restoreFrozenDraft(slot, registry);
    return failedExecution(draft);
  }

  try {
    const result = await send(payload);
    const draft = await settleBestEffort(registry, reservation, result.outcome);
    return {
      acceptedAndSettled: result.outcome === "accepted" && draft === null,
      draft,
      message: frozenDraftMessage(draft, result.message),
    };
  } catch {
    const draft = await settleUnknownBestEffort(registry, reservation);
    return {
      acceptedAndSettled: false,
      draft,
      message: frozenDraftMessage(draft),
    };
  }
}

function failedExecution(draft: FrozenSendDraft | null): FrozenSendExecution {
  return {
    acceptedAndSettled: false,
    draft,
    message: frozenDraftMessage(draft),
  };
}

function draftFromReservation(
  reservation: FrozenSendDraftReservation,
): FrozenSendDraft {
  return {
    outcome: reservation.knownAccepted ? "local_repair" : "outcome_unknown",
    payload: reservation.payload,
  };
}

async function settleBestEffort(
  registry: FrozenSendDraftRegistry,
  reservation: FrozenSendDraftReservation,
  outcome: SendUiResult["outcome"],
): Promise<FrozenSendDraft | null> {
  try {
    return await registry.settle(reservation, outcome);
  } catch {
    return conservativeDraftAfterFailure(reservation, outcome);
  }
}

async function settleUnknownBestEffort(
  registry: FrozenSendDraftRegistry,
  reservation: FrozenSendDraftReservation,
): Promise<FrozenSendDraft> {
  try {
    const draft = await registry.settle(reservation, "outcome_unknown");
    return draft ?? conservativeDraftAfterFailure(reservation, "outcome_unknown");
  } catch {
    return conservativeDraftAfterFailure(reservation, "outcome_unknown");
  }
}

function conservativeDraftAfterFailure(
  reservation: FrozenSendDraftReservation,
  outcome: SendUiResult["outcome"],
): FrozenSendDraft {
  const locallyAccepted =
    reservation.knownAccepted || outcome === "local_repair";
  return {
    outcome: locallyAccepted ? "local_repair" : "outcome_unknown",
    payload: reservation.payload,
  };
}
