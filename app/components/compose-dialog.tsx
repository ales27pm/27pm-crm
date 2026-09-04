"use client";

import { useEffect, useRef, useState } from "react";
import type { Mailbox } from "../crm-types";
import {
  DELIVERABILITY_CANARY_RECIPIENT,
  DELIVERABILITY_CANARY_SENDER,
} from "../../lib/deliverability-canary";
import { Icon } from "./icons";

type ComposeDialogProps = {
  open: boolean;
  mailboxes: Mailbox[];
  sendEnabled: boolean;
  onClose: () => void;
  onSend: (payload: { from: string; to: string; subject: string; body: string; complianceConfirmed: boolean }) => Promise<boolean>;
};

export function ComposeDialog({ open, mailboxes, sendEnabled, onClose, onSend }: ComposeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sendingRef = useRef(false);
  const salesMailboxes = mailboxes.filter((mailbox) => mailbox.kind === "sales");
  const [from, setFrom] = useState(salesMailboxes[0]?.address ?? "bonjour@27pm.org");
  const [to, setTo] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [complianceConfirmed, setComplianceConfirmed] = useState(false);
  const isDeliverabilityCanary =
    from === DELIVERABILITY_CANARY_SENDER &&
    to.trim().toLowerCase() === DELIVERABILITY_CANARY_RECIPIENT;

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
          if (!complianceConfirmed) {
            setStatus(
              isDeliverabilityCanary
                ? "Confirmez l’envoi du test interne."
                : "Confirmez la qualification et la conformité avant l’envoi.",
            );
            sendingRef.current = false;
            setSending(false);
            return;
          }
          void onSend({ from, to, subject, body, complianceConfirmed }).then((sent) => {
            if (sent) {
              setTo(""); setSubject(""); setBody(""); setComplianceConfirmed(false); setStatus(""); onClose();
            } else {
              setStatus(
                isDeliverabilityCanary
                  ? "Le test n’a pas été confirmé."
                  : "L’envoi n’a pas été confirmé.",
              );
            }
          }).finally(() => {
            sendingRef.current = false;
            setSending(false);
          });
        }}
      >
        <header><h2>{isDeliverabilityCanary ? "Test de délivrabilité 27PM" : "Nouveau courriel"}</h2><button type="button" onClick={onClose} aria-label="Fermer"><Icon name="close" /></button></header>
        <label><span>De</span><select value={from} onChange={(event) => setFrom(event.target.value)}>{salesMailboxes.map((mailbox) => <option key={mailbox.address}>{mailbox.address}</option>)}</select></label>
        <label><span>À</span><input type="email" required value={to} onChange={(event) => setTo(event.target.value)} /></label>
        <label><span>Objet</span><input required value={subject} onChange={(event) => setSubject(event.target.value)} /></label>
        <textarea aria-label="Message" required rows={12} value={body} onChange={(event) => setBody(event.target.value)} placeholder="Écrivez votre message…" />
        <label className="check-label"><input type="checkbox" checked={complianceConfirmed} onChange={(event) => setComplianceConfirmed(event.target.checked)} /> {isDeliverabilityCanary ? "Je confirme qu’il s’agit d’un test interne envoyé uniquement à votre boîte Gmail 27PM." : "Je confirme qu’il s’agit d’un seul destinataire qualifié, que le fondement et les preuves sont à jour et que le message concerne précisément ses fonctions."}</label>
        <footer>
          <p role="status">{status}</p>
          <button className="send-button" type="submit" disabled={sending}>
            <Icon name="send" /> {sending ? "Envoi…" : isDeliverabilityCanary ? "Envoyer le test" : "Envoyer"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
