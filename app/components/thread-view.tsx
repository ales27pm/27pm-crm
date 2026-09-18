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
import { mailboxForAddress } from "@/lib/mailboxes";
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
  operationalReplyConfirmed?: true;
};

type ReplyConfirmationState = {
  draftSlot: string;
  payload: ReplyPayload;
  localRepair: boolean;
  operationalReply: boolean;
};

type ThreadConversationProps = {
  view: {
    body: string;
    contextOpen: boolean;
    conversation: Conversation;
    draftReady: boolean;
    frozenDraft: FrozenSendDraft | null;
    replyConfirmation: ReplyConfirmationState | null;
    sendEnabled: boolean;
    sending: boolean;
    status: string;
  };
  actions: {
    back: () => void;
    cancelReply: () => void;
    confirmReply: () => void;
    openContext: () => void;
    setBody: (body: string) => void;
    submit: () => void;
  };
  contextTriggerRef: Ref<HTMLButtonElement>;
  sendButtonRef: RefObject<HTMLButtonElement | null>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
};

type ReplyComposerProps = Pick<ThreadConversationProps, "actions"> & {
  view: Pick<
    ThreadConversationProps["view"],
    | "body"
    | "conversation"
    | "draftReady"
    | "frozenDraft"
    | "replyConfirmation"
    | "sendEnabled"
    | "sending"
    | "status"
  >;
  sendButtonRef: RefObject<HTMLButtonElement | null>;
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
  const [replyConfirmation, setReplyConfirmation] =
    useState<ReplyConfirmationState | null>(null);
  const sendingRef = useRef(false);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
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
    if (
      !conversation ||
      !draftSlot ||
      !draftReady ||
      sendingRef.current ||
      replyConfirmation
    ) return;
    if (frozenDraft?.outcome === "outcome_unknown") return;
    const value = body.trim();
    if (!value) return;
    if (!sendEnabled) {
      setStatus("Le transport de courriel doit être configuré avant l’envoi.");
      return;
    }

    const operationalReply = mailboxForAddress(conversation.mailboxAddress)?.purpose === "operations";
    const payload = frozenDraft
      ? replyPayload(frozenDraft.payload)
      : replyPayload({
          conversationId: conversation.id,
          from: conversation.mailboxAddress,
          to: conversation.contactEmail,
          subject: conversation.subject,
          body: value,
          complianceConfirmed: true,
          ...(operationalReply ? { operationalReplyConfirmed: true } : {}),
        });
    if (!payload) {
      setStatus(FROZEN_DRAFT_UNAVAILABLE_MESSAGE);
      return;
    }

    confirmationReturnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : sendButtonRef.current;
    setReplyConfirmation({
      draftSlot,
      payload,
      localRepair: frozenDraft?.outcome === "local_repair",
      operationalReply,
    });
    setStatus("Vérifiez le destinataire et le message exact avant de confirmer.");
  }

  function cancelReply() {
    closeReplyConfirmation("Envoi annulé.");
  }

  function closeReplyConfirmation(message: string) {
    setReplyConfirmation(null);
    setStatus(message);
    const returnFocus = confirmationReturnFocusRef.current;
    confirmationReturnFocusRef.current = null;
    window.requestAnimationFrame(() => {
      if (returnFocus?.isConnected) returnFocus.focus();
      else sendButtonRef.current?.focus();
    });
  }

  function confirmReply() {
    const confirmation = replyConfirmation;
    if (!confirmation || sendingRef.current) return;
    if (confirmation.draftSlot !== draftSlot) {
      closeReplyConfirmation(
        "La conversation a changé pendant la vérification; rien n’a été transmis. Actualisez le CRM avant de réessayer.",
      );
      return;
    }
    if (
      !confirmation.localRepair &&
      (
        !sendEnabled ||
        !conversation ||
        confirmation.payload.conversationId !== conversation.id ||
        confirmation.payload.from !== conversation.mailboxAddress ||
        confirmation.payload.to !== conversation.contactEmail ||
        confirmation.payload.subject !== conversation.subject ||
        confirmation.payload.body !== body.trim()
      )
    ) {
      closeReplyConfirmation(
        "La conversation ou le transport a changé pendant la vérification; rien n’a été transmis. Actualisez le CRM avant de réessayer.",
      );
      return;
    }
    setReplyConfirmation(null);
    confirmationReturnFocusRef.current = null;
    void dispatchReply(confirmation.draftSlot, confirmation.payload);
  }

  async function dispatchReply(slot: string, payload: ReplyPayload) {
    if (sendingRef.current) return;

    sendingRef.current = true;
    setSending(true);
    setStatus("Envoi en cours…");
    try {
      const execution = await executeFrozenSend({
        slot,
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
      sendingRef.current = false;
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
      replyConfirmation,
      sendEnabled,
      sending,
      status,
    }}
    actions={{
      back: onBack,
      cancelReply,
      confirmReply,
      openContext: onOpenContext,
      setBody,
      submit: () => void submit(),
    }}
    contextTriggerRef={contextTriggerRef}
    sendButtonRef={sendButtonRef}
    textareaRef={textareaRef}
  />;
}

function ThreadConversation({
  view,
  actions,
  contextTriggerRef,
  sendButtonRef,
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
      <ReplyComposer
        view={view}
        actions={actions}
        sendButtonRef={sendButtonRef}
        textareaRef={textareaRef}
      />
      {view.replyConfirmation ? (
        <ReplyConfirmation
          view={{
            confirmation: view.replyConfirmation,
            sending: view.sending,
          }}
          actions={{
            cancel: actions.cancelReply,
            confirm: actions.confirmReply,
          }}
        />
      ) : null}
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

function ReplyComposer({
  view,
  actions,
  sendButtonRef,
  textareaRef,
}: ReplyComposerProps) {
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
          disabled={
            !view.draftReady ||
            view.frozenDraft !== null ||
            view.replyConfirmation !== null ||
            view.sending
          }
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
            ref={sendButtonRef}
            className="send-button"
            type="submit"
            disabled={
              !view.sendEnabled ||
              !view.draftReady ||
              !view.body.trim() ||
              view.replyConfirmation !== null ||
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

function ReplyConfirmation({
  view,
  actions,
}: {
  view: {
    confirmation: ReplyConfirmationState;
    sending: boolean;
  };
  actions: {
    cancel: () => void;
    confirm: () => void;
  };
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => {
      cancelButtonRef.current?.focus();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="reply-confirmation"
      aria-modal="true"
      aria-labelledby="reply-confirmation-title"
      aria-describedby="reply-confirmation-description"
      onCancel={(event) => {
        event.preventDefault();
        actions.cancel();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          actions.confirm();
        }}
      >
        <header>
          <p className="eyebrow">Étape 2 sur 2</p>
          <h2 id="reply-confirmation-title">
            {view.confirmation.localRepair
              ? "Réparer l’enregistrement CRM"
              : view.confirmation.operationalReply
                ? "Confirmer la réponse administrative"
                : "Confirmer la réponse"}
          </h2>
        </header>
        <div className="reply-confirmation-content">
          <p id="reply-confirmation-description">
            {view.confirmation.localRepair
              ? "Le transport a déjà accepté ce courriel. Cette action répare uniquement son enregistrement local avec le brouillon exact; elle ne le renvoie pas."
              : view.confirmation.operationalReply
                ? "Vérifiez cette réponse exacte. En confirmant, vous attestez que le dernier message entrant sollicite cette réponse administrative unique et que le destinataire n’a demandé aucun blocage."
                : "Vérifiez cette réponse exacte. En confirmant, vous attestez que ce destinataire unique est qualifié et que le fondement LCAP ainsi que les preuves sont à jour."}
          </p>
          <dl className="reply-confirmation-details">
            <div><dt>De</dt><dd>{view.confirmation.payload.from}</dd></div>
            <div><dt>À</dt><dd>{view.confirmation.payload.to}</dd></div>
            <div><dt>Objet</dt><dd>{view.confirmation.payload.subject}</dd></div>
          </dl>
          <section
            className="reply-confirmation-message"
            aria-labelledby="reply-confirmation-message-title"
          >
            <h3 id="reply-confirmation-message-title">Message exact</h3>
            <pre>{view.confirmation.payload.body}</pre>
          </section>
        </div>
        <footer>
          <button
            ref={cancelButtonRef}
            className="secondary-action"
            type="button"
            disabled={view.sending}
            onClick={actions.cancel}
          >
            Annuler
          </button>
          <button className="primary-action" disabled={view.sending} type="submit">
            {view.confirmation.localRepair
              ? "Confirmer la réparation"
              : "Confirmer et envoyer"}
          </button>
        </footer>
      </form>
    </dialog>
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
        ...(payload.operationalReplyConfirmed === true
          ? { operationalReplyConfirmed: true }
          : {}),
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
