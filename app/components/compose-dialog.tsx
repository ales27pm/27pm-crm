"use client";

import { useEffect, useRef, useState } from "react";
import type { Mailbox } from "../crm-types";
import { Icon } from "./icons";

type ComposeDialogProps = {
  open: boolean;
  mailboxes: Mailbox[];
  sendEnabled: boolean;
  onClose: () => void;
  onSend: (payload: { from: string; to: string; subject: string; body: string }) => Promise<boolean>;
};

export function ComposeDialog({ open, mailboxes, sendEnabled, onClose, onSend }: ComposeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sendingRef = useRef(false);
  const [from, setFrom] = useState(mailboxes[0]?.address ?? "bonjour@27pm.org");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      className="compose-dialog"
      onClose={onClose}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          if (sendingRef.current) return;
          if (!sendEnabled) {
            setStatus("Connectez Mailgun avant l’envoi.");
            return;
          }
          sendingRef.current = true;
          setSending(true);
          setStatus("Envoi en cours…");
          void onSend({ from, to, subject, body }).then((sent) => {
            if (sent) {
              setTo(""); setSubject(""); setBody(""); setStatus(""); onClose();
            } else {
              setStatus("L’envoi n’a pas été confirmé.");
            }
          }).finally(() => {
            sendingRef.current = false;
            setSending(false);
          });
        }}
      >
        <header><h2>Nouveau courriel</h2><button type="button" onClick={onClose} aria-label="Fermer"><Icon name="close" /></button></header>
        <label><span>De</span><select value={from} onChange={(event) => setFrom(event.target.value)}>{mailboxes.map((mailbox) => <option key={mailbox.address}>{mailbox.address}</option>)}</select></label>
        <label><span>À</span><input type="email" required value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label><span>Objet</span><input required value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <textarea aria-label="Message" required rows={12} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Écrivez votre message…" />
        <footer>
          <p role="status">{status}</p>
          <button className="send-button" type="submit" disabled={sending}>
            <Icon name="send" /> {sending ? "Envoi…" : "Envoyer"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
