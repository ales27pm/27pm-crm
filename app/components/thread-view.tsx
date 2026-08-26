"use client";

import { useRef, useState, type Ref } from "react";
import {
  DELIVERY_PRESENTATION,
  type OutboundDeliveryState,
} from "@/lib/mailgun-lifecycle";
import type { Conversation, CrmMessage } from "../crm-types";
import { Icon } from "./icons";

type ThreadViewProps = {
  conversation: Conversation | null;
  sendEnabled: boolean;
  contextOpen: boolean;
  contextTriggerRef: Ref<HTMLButtonElement>;
  onBack: () => void;
  onOpenContext: () => void;
  onSend: (body: string) => Promise<boolean>;
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  if (!conversation) {
    return (
      <section className="thread-view thread-empty" aria-label="Conversation">
        <Icon name="mail" />
        <h2>Sélectionnez une conversation.</h2>
        <p>Le message et son contexte client s’ouvriront ici.</p>
      </section>
    );
  }

  const initials = conversation.contactName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  async function submit() {
    const value = body.trim();
    if (!value || sending) return;
    if (!sendEnabled) {
      setStatus("Le transport Mailgun doit être connecté avant l’envoi.");
      return;
    }

    setSending(true);
    setStatus("Envoi en cours…");
    try {
      const sent = await onSend(value);
      if (sent) {
        setBody("");
        setStatus("Courriel envoyé.");
      } else {
        setStatus("L’envoi n’a pas été confirmé. Le brouillon est conservé.");
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="thread-view" aria-labelledby="thread-title">
      <header className="thread-header">
        <button className="mobile-back" type="button" onClick={onBack}>
          <Icon name="back" />
          <span>Réception</span>
        </button>
        <div className="thread-title-line">
          <h2 id="thread-title">{conversation.subject}</h2>
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
              aria-expanded={contextOpen}
              onClick={onOpenContext}
            >
              <Icon name="more" />
            </button>
          </div>
        </div>
      </header>

      <div className="message-stream">
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
      </div>

      <form
        className="reply-composer"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="composer-heading">
          <Icon name="reply" />
          <label htmlFor="reply-body">Répondre à {conversation.contactName.split(" ")[0]}</label>
          <span>{sendEnabled ? "Prêt à envoyer" : "Connexion Mailgun requise"}</span>
        </div>
        <textarea
          id="reply-body"
          ref={textareaRef}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              void submit();
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
            disabled={!sendEnabled || !body.trim() || sending}
          >
            {sending ? "Envoi…" : "Envoyer"}
          </button>
        </div>
        <p className="composer-status" role="status" aria-live="polite">
          {status}
        </p>
      </form>
    </section>
  );
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
