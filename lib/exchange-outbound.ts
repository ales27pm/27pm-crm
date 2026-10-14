import "server-only";

import type { CrmDatabase } from "./d1";
import {
  withExchangeAccess,
  type ExchangeAccess,
  type ExchangeServiceContext,
} from "./exchange-connection-service";
import {
  createExchangeDraft,
  ExchangeGraphError,
  submitExchangeDraft,
} from "./exchange-graph";
import {
  createExchangeSendState,
  getExchangeSendState,
  transitionExchangeSendState,
  type ExchangeSendState,
} from "./exchange-mail-store";
import { OutboundSendError } from "./outbound-send-outcome";

export type ExchangeOutboundMessage = {
  commandId: string;
  fromAddress: string;
  fromName: string;
  to: string[];
  subject: string;
  text: string;
  replyTo: string;
  inReplyTo?: string;
  references?: string[];
};

export type ExchangeOutboundResult = {
  provider: "exchange";
  providerMessageId: string;
  providerConversationId: string;
  externalMessageId: null;
  message: string;
  responseStatus: 202;
};

/**
 * One approved command creates one correlated draft, stores its immutable ID,
 * then submits that exact draft once. Ambiguous provider outcomes are fenced
 * for read-only reconciliation and are never retried here.
 */
export async function sendApprovedExchangeMessage(
  db: CrmDatabase,
  context: ExchangeServiceContext,
  message: ExchangeOutboundMessage,
  options: { onDispatchStart?: () => void } = {},
): Promise<ExchangeOutboundResult> {
  return withExchangeAccess(context, async (access) => {
    let state = await createExchangeSendState(db, {
      scope: access.scope,
      guard: access.guard,
      commandId: message.commandId,
      correlationId: message.commandId,
    });
    if (!state) {
      const observed = await getExchangeSendState(db, access.scope, message.commandId);
      if (observed) throw new Error("exchange_send_already_started");
      throw new Error("exchange_send_state_unavailable");
    }

    options.onDispatchStart?.();
    let draftId: string;
    let providerConversationId: string;
    try {
      const draft = await createExchangeDraft(access, {
        commandId: message.commandId,
        fromAddress: message.fromAddress,
        fromName: message.fromName,
        to: message.to,
        subject: message.subject,
        text: message.text,
        replyTo: message.replyTo,
        inReplyTo: message.inReplyTo,
        references: message.references,
      });
      draftId = draft.id;
      providerConversationId = draft.conversationId!;
    } catch (error) {
      await settleCreateFailure(db, access, state, error);
      throw outboundError(error);
    }

    const drafted = await transitionExchangeSendState(db, {
      scope: access.scope,
      guard: access.guard,
      commandId: message.commandId,
      expectedVersion: state.version,
      from: "prepared",
      to: "drafted",
      graphMessageId: draftId,
    });
    if (!drafted) {
      // The draft may exist even if D1 did not acknowledge the transition.
      // Preserve the no-redispatch invariant and let correlation reconciliation
      // recover its immutable ID later.
      throw new OutboundSendError("exchange", 503, "outcome_unknown");
    }
    state = drafted;

    const sendRequested = await transitionExchangeSendState(db, {
      scope: access.scope,
      guard: access.guard,
      commandId: message.commandId,
      expectedVersion: state.version,
      from: "drafted",
      to: "send_requested",
      graphMessageId: draftId,
    });
    if (!sendRequested) {
      // No submission request has occurred. Still fail closed because the
      // durable state is insufficient to prove that a future caller may send.
      throw new OutboundSendError("exchange", 503, "outcome_unknown");
    }
    state = sendRequested;

    try {
      await submitExchangeDraft(access, draftId);
    } catch (error) {
      await settleSubmitFailure(db, access, state, draftId, error);
      throw outboundError(error);
    }

    const accepted = await transitionExchangeSendState(db, {
      scope: access.scope,
      guard: access.guard,
      commandId: message.commandId,
      expectedVersion: state.version,
      from: "send_requested",
      to: "accepted",
      graphMessageId: draftId,
    });
    if (!accepted) {
      // Graph returned 202. A local acknowledgement failure must never become
      // permission to submit the draft a second time.
      throw new OutboundSendError("exchange", 503, "outcome_unknown");
    }

    return {
      provider: "exchange",
      providerMessageId: draftId,
      providerConversationId,
      externalMessageId: null,
      message: "Accepted by Microsoft Graph for submission.",
      responseStatus: 202,
    };
  });
}

async function settleCreateFailure(
  db: CrmDatabase,
  access: ExchangeAccess,
  state: ExchangeSendState,
  error: unknown,
) {
  try {
    await transitionExchangeSendState(db, {
      scope: access.scope,
      guard: access.guard,
      commandId: state.commandId,
      expectedVersion: state.version,
      from: "prepared",
      to: uncertain(error) ? "unknown" : "rejected",
    });
  } catch {
    // The original fixed error category remains authoritative. A failed local
    // transition never authorizes a new provider attempt.
  }
}

async function settleSubmitFailure(
  db: CrmDatabase,
  access: ExchangeAccess,
  state: ExchangeSendState,
  draftId: string,
  error: unknown,
) {
  try {
    await transitionExchangeSendState(db, {
      scope: access.scope,
      guard: access.guard,
      commandId: state.commandId,
      expectedVersion: state.version,
      from: "send_requested",
      to: uncertain(error) ? "unknown" : "rejected",
      graphMessageId: draftId,
    });
  } catch {
    // Never retry the provider because a local outcome marker failed.
  }
}

function uncertain(error: unknown): boolean {
  return error instanceof ExchangeGraphError && error.outcomeUnknown;
}

function outboundError(error: unknown): OutboundSendError {
  if (error instanceof ExchangeGraphError && error.outcomeUnknown) {
    return new OutboundSendError("exchange", error.status ?? 503, "outcome_unknown");
  }
  return new OutboundSendError(
    "exchange",
    error instanceof ExchangeGraphError ? error.status ?? 502 : 502,
    "rejected",
  );
}
