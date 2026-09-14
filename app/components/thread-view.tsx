"use client";

import { useEffect, useRef, useState, type Ref, type RefObject } from "react";
import {
  DELIVERY_PRESENTATION,
  type OutboundDeliveryState,
} from "@/lib/mailgun-lifecycle";
import {
  replyFrozenDraftSlot,
  type FrozenSendDraft,
} from "@/lib/frozen-send-draft";
import type { SendAttemptPayload } from "@/lib/send-attempt-registry";
import type { SendUiResult } from "@/lib/send-ui-result";
import type { Conversation, CrmMessage } from "../crm-types";
import {
  executeFrozenSend,
  FROZEN_DRAFT_UNAVAILABLE_MESSAGE,
  frozenDraftMessage,
  restoreFrozenDraft,
} from "./frozen-send-ui";
import { Icon } from "./icons";
import { Illustration } from "./visual-assets";

type ThreadViewProps = {
  conversation: Conversation | null;
  sendEnabled: boolean;
  contextOpen: boolean;
  contextTriggerRef: Ref<HTMLButtonElement>;
  onBack: () => void;
  onOpenContext: () => void;
  onSend: (payload: SendAttemptPayload) => Promise<SendUiResult>;
};

type ReplyPayload = {
  conversationId: string;
  from: string;
  to: string;
  subject: string;
  body: string;
  complianceConfirmed: true;
};

type ThreadConversationProps = {
  view: {
    body: string;
    contextOpen: boolean;
    conversation: Conversation;
    draftReady: boolean;
    frozenDraft: FrozenSendDraft | null;
    sendEnabled: boolean;
    sending: boolean;
    status: string;
  };
  actions: {
    back: () => void;
    openContext: () => void;
    setBody: (body: string) => void;
    submit: () => void;
  };
  contextTriggerRef: Ref<HTMLButtonElement>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

type ReplyComposerProps = Pick<ThreadConversationProps, "actions"> & {
  view: Pick<
    ThreadConversationProps["view"],
    | "body"
    | "conversation"
    | "draftReady"
    | "frozenDraft"
    | "sendEnabled"
    | "sending"
    | "status"
  >;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

export function ThreadView({
  conversation,
  sendEnabled,
  contextOpen,
  contextTriggerRef,
  onBack,
  onOpenContext,
  onSend,
}: ThreadViewProps) {
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [readyDraftSlot, setReadyDraftSlot] = useState<string | null>(null);
  const [frozenDraft, setFrozenDraft] = useState<FrozenSendDraft | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftSlot = conversation
    ? replyFrozenDraftSlot(conversation.id)
    : null;
  const draftReady = !draftSlot || readyDraftSlot === draftSlot;

  useEffect(() => {
    let active = true;
    if (!draftSlot) {
      return () => {
        active = false;
      };
    }
    void restoreFrozenDraft(draftSlot)
      .then((restored) => {
        if (!active) return;
        if (restored) {
          const payload = replyPayload(restored.payload);
          if (!payload || payload.conversationId !== conversation?.id) {
            throw new Error("reply_frozen_draft_invalid");
          }
          setBody(payload.body);
          setFrozenDraft(restored);
          setStatus(frozenDraftMessage(restored));
        } else {
          setBody("");
          setFrozenDraft(null);
          setStatus("");
        }
        setReadyDraftSlot(draftSlot);
      })
      .catch(() => {
        if (!active) return;
        setStatus(FROZEN_DRAFT_UNAVAILABLE_MESSAGE);
        setReadyDraftSlot(null);
      });
    return () => {
      active = false;
    };
  }, [conversation?.id, draftSlot]);

  if (!conversation) {
    return (
      <section className="thread-view thread-empty" aria-label="Conversation">
        <Illustration className="crm-empty-art" name="thread-select" />
        <h2>Sélectionnez une conversation.</h2>
        <p>Le message et son contexte client s’ouvriront ici.</p>
      </section>
    );
  }

  async function submit() {
    if (!conversation || !draftSlot || !draftReady || sending) return;
    if (frozenDraft?.outcome === "outcome_unknown") return;
    const value = body.trim();
    if (!value) return;
    if (!sendEnabled) {
      setStatus("Le transport de courriel doit être configuré avant l’envoi.");
      return;
    }

    const payload = frozenDraft
      ? replyPayload(frozenDraft.payload)
      : replyPayload({
          conversationId: conversation.id,
          from: conversation.mailboxAddress,
          to: conversation.contactEmail,
          subject: conversation.subject,
          body: value,
          complianceConfirmed: true,
        });
    if (!payload) {
      setStatus(FROZEN_DRAFT_UNAVAILABLE_MESSAGE);
      return;
    }
    if (
      !window.confirm(
        "Confirmer la qualification, le fondement LCAP et les preuves à jour pour ce destinataire unique?",
      )
    ) {
      setStatus("Envoi annulé.");
      return;
    }

    setSending(true);
    setStatus("Envoi en cours…");
    try {
      const execution = await executeFrozenSend({
        slot: draftSlot,
        payload,
        send: onSend,
        onReserved: setFrozenDraft,
      });
      setFrozenDraft(execution.draft);
      setStatus(execution.message);
      if (execution.acceptedAndSettled) {
        setBody("");
      }
    } finally {
      setSending(false);
    }
  }

  return <ThreadConversation
    view={{
      body,
      contextOpen,
      conversation,
      draftReady,
      frozenDraft,
      sendEnabled,
      sending,
      status,
    }}
    actions={{
      back: onBack,
      openContext: onOpenContext,
      setBody,
      submit: () => void submit(),
    }}
    contextTriggerRef={contextTriggerRef}
    textareaRef={textareaRef}
  />;
}

function ThreadConversation({
  view,
  actions,
  contextTriggerRef,
  textareaRef,
}: ThreadConversationProps) {
  return (
    <section className="thread-view" aria-labelledby="thread-title">
      <header className="thread-header">
        <button className="mobile-back" type="button" onClick={actions.back}>
          <Icon name="back" />
          <span>Réception</span>
        </button>
        <div className="thread-title-line">
          <h2 id="thread-title">{view.conversation.subject}</h2>
          <div className="thread-actions">
            <button
              className="thread-reply-action"
              type="button"
              aria-label="Répondre"
              onClick={() => textareaRef.current?.focus()}
            >
              <Icon name="reply" />
            </button>
            <button
              ref={contextTriggerRef}
              className="thread-context-action"
              type="button"
              aria-label="Ouvrir le contexte"
              aria-controls="conversation-context"
              aria-expanded={view.contextOpen}
              onClick={actions.openContext}
            >
              <Icon name="more" />
            </button>
          </div>
        </div>
      </header>

      <MessageStream conversation={view.conversation} />
      <ReplyComposer view={view} actions={actions} textareaRef={textareaRef} />
    </section>
  );
}

function MessageStream({ conversation }: { conversation: Conversation }) {
  const initials = contactInitials(conversation.contactName);
  return <div className="message-stream">
    {conversation.messages.map((message) => {
      const outbound = message.direction === "outbound";
      return (
        <article className="message" key={message.id} data-direction={message.direction}>
          <header>
            <span className="avatar" data-studio={outbound || undefined}>
              {outbound ? "27" : initials}
            </span>
            <span className="message-identity">
              <strong>{message.senderName}</strong>
              <span>À : {message.recipientLabel}</span>
            </span>
            <time dateTime={message.sentAtIso}>{message.sentAt}</time>
            {message.direction === "inbound" ? (
              <span className="unread-dot" aria-label="Message reçu" />
            ) : null}
          </header>
          <DeliveryStatus message={message} />
          <p>{message.body}</p>
        </article>
      );
    })}
  </div>;
}

function ReplyComposer({ view, actions, textareaRef }: ReplyComposerProps) {
  return (
    <form
        className="reply-composer"
        onSubmit={(event) => {
          event.preventDefault();
          actions.submit();
        }}
      >
        <div className="composer-heading">
          <Icon name="reply" />
          <label htmlFor="reply-body">Répondre à {view.conversation.contactName.split(" ")[0]}</label>
          <span>{view.sendEnabled ? "Prêt à envoyer" : "Transport à configurer"}</span>
        </div>
        <textarea
          id="reply-body"
          ref={textareaRef}
          disabled={!view.draftReady || view.frozenDraft !== null || view.sending}
          value={view.body}
          onChange={(event) => actions.setBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              actions.submit();
            }
          }}
          placeholder="Écrivez votre réponse…"
          rows={5}
        />
        <div className="composer-toolbar">
          <span className="composer-hint">⌘↵ pour envoyer</span>
          <button
            className="send-button"
            type="submit"
            disabled={
              !view.sendEnabled ||
              !view.draftReady ||
              !view.body.trim() ||
              view.sending ||
              view.frozenDraft?.outcome === "outcome_unknown"
            }
          >
            {view.sending
              ? "Envoi…"
              : view.frozenDraft?.outcome === "local_repair"
                ? "Réparer le CRM"
                : "Envoyer"}
          </button>
        </div>
        <p className="composer-status" role="status" aria-live="polite">
          {view.status}
        </p>
      </form>
  );
}

function contactInitials(contactName: string): string {
  return contactName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function replyPayload(payload: SendAttemptPayload): ReplyPayload | null {
  return typeof payload.conversationId === "string" &&
    typeof payload.from === "string" &&
    typeof payload.to === "string" &&
    typeof payload.subject === "string" &&
    typeof payload.body === "string" &&
    payload.complianceConfirmed === true
    ? {
        conversationId: payload.conversationId,
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
        complianceConfirmed: true,
      }
    : null;
}

function DeliveryStatus({ message }: { message: CrmMessage }) {
  if (message.direction !== "outbound") return null;

  const fallbackState: OutboundDeliveryState =
    message.deliveryState === "received" ? "accepted" : message.deliveryState;
  const events =
    message.deliveryEvents.length > 0
      ? message.deliveryEvents
      : [
          {
            state: fallbackState,
            occurredAt: message.sentAtIso,
            occurredLabel: message.sentAt,
          },
        ];
  const current = events.at(-1)!;
  const presentation = DELIVERY_PRESENTATION[current.state];

  return (
    <div
      className="delivery-status"
      data-state={current.state}
      data-tone={presentation.tone}
    >
      <p className="delivery-current" aria-live="polite" aria-atomic="true">
        <strong>{presentation.label}</strong>
        <time dateTime={current.occurredAt}>{current.occurredLabel}</time>
      </p>
      <p className="delivery-guidance">{presentation.guidance}</p>
      {events.length > 1 ? (
        <details className="delivery-history-details">
          <summary>Voir l’historique de livraison ({events.length})</summary>
          <ol aria-label="Historique de livraison">
            {events.map((event, index) => (
              <li
                key={`${event.state}:${event.occurredAt}:${index}`}
                data-state={event.state}
              >
                <strong>{DELIVERY_PRESENTATION[event.state].label}</strong>
                <time dateTime={event.occurredAt}>{event.occurredLabel}</time>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </div>
  );
}
