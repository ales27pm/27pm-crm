"use client";

import { useRef, useState } from "react";
import type { Conversation } from "../crm-types";
import { Icon } from "./icons";

type ThreadViewProps = {
  conversation: Conversation | null;
  sendEnabled: boolean;
  onBack: () => void;
  onOpenContext: () => void;
  onSend: (body: string) => Promise<boolean>;
};

export function ThreadView({
  conversation,
  sendEnabled,
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
            <button type="button" aria-label="Répondre" onClick={() => textareaRef.current?.focus()}>
              <Icon name="reply" />
            </button>
            <button type="button" aria-label="Ouvrir le contexte" onClick={onOpenContext}>
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
                <time>{message.sentAt}</time>
                {message.direction === "inbound" ? (
                  <span className="unread-dot" aria-label="Message reçu" />
                ) : null}
              </header>
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
