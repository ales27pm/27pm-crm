"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import type { Mailbox } from "../crm-types";
import {
  DELIVERABILITY_CANARY_RECIPIENT,
  DELIVERABILITY_CANARY_SENDER,
} from "../../lib/deliverability-canary";
import {
  type FrozenSendDraft,
} from "../../lib/frozen-send-draft";
import type { SendAttemptPayload } from "../../lib/send-attempt-registry";
import type { SendUiResult } from "../../lib/send-ui-result";
import {
  executeFrozenSend,
  FROZEN_DRAFT_UNAVAILABLE_MESSAGE,
  frozenDraftMessage,
  restoreFrozenDraft,
} from "./frozen-send-ui";
import { Icon } from "./icons";

type ComposeDialogProps = {
  open: boolean;
  mailboxes: Mailbox[];
  sendEnabled: boolean;
  onClose: () => void;
  onSend: (payload: { from: string; to: string; subject: string; body: string; complianceConfirmed: boolean }) => Promise<SendUiResult>;
};

type ComposePayload = {
  from: string;
  to: string;
  subject: string;
  body: string;
  complianceConfirmed: true;
};

type ComposeFields = Omit<ComposePayload, "complianceConfirmed"> & {
  complianceConfirmed: boolean;
};

type ComposeDraftState = {
  ready: boolean;
  frozen: FrozenSendDraft | null;
};

type ComposePresentation = {
  confirmationLabel: string;
  fieldsDisabled: boolean;
  isDeliverabilityCanary: boolean;
  submitDisabled: boolean;
  submitLabel: string;
  title: string;
  unknownFrozen: boolean;
};

type ComposeDialogViewProps = {
  view: {
    dialogRef: RefObject<HTMLDialogElement | null>;
    fields: ComposeFields;
    mailboxes: Mailbox[];
    presentation: ComposePresentation;
    status: string;
  };
  actions: {
    close: () => void;
    setCompliance: (confirmed: boolean) => void;
    setText: (field: "from" | "to" | "subject" | "body", value: string) => void;
    submit: () => void;
  };
};

const COMPOSE_DRAFT_SLOT = "compose";

export function ComposeDialog({ open, mailboxes, sendEnabled, onClose, onSend }: ComposeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sendingRef = useRef(false);
  const salesMailboxes = mailboxes.filter((mailbox) => mailbox.kind === "sales");
  const [fields, setFields] = useState<ComposeFields>({
    from: salesMailboxes[0]?.address ?? "bonjour@27pm.org",
    to: "",
    subject: "",
    body: "",
    complianceConfirmed: false,
  });
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [draftState, setDraftState] = useState<ComposeDraftState>({
    ready: false,
    frozen: null,
  });
  const { from, to, subject, body, complianceConfirmed } = fields;
  const { ready: draftReady, frozen: frozenDraft } = draftState;
  const presentation = composePresentation(fields, draftState, sending);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    let active = true;
    void restoreFrozenDraft(COMPOSE_DRAFT_SLOT)
      .then((restored) => {
        if (!active) return;
        if (restored) {
          const payload = composePayload(restored.payload);
          if (!payload) throw new Error("compose_frozen_draft_invalid");
          setFields(payload);
          setStatus(frozenDraftMessage(restored));
        }
        setDraftState({ ready: true, frozen: restored });
      })
      .catch(() => {
        if (!active) return;
        setStatus(FROZEN_DRAFT_UNAVAILABLE_MESSAGE);
        setDraftState({ ready: false, frozen: null });
      });
    return () => {
      active = false;
    };
  }, []);

  async function submit() {
    if (!draftReady || sendingRef.current || presentation.unknownFrozen) return;
    if (!sendEnabled) {
      setStatus("Configurez le transport de courriel avant l’envoi.");
      return;
    }
    const payload = frozenDraft
      ? composePayload(frozenDraft.payload)
      : composePayload({ from, to, subject, body, complianceConfirmed });
    if (!payload) {
      setStatus(
        presentation.isDeliverabilityCanary
          ? "Confirmez l’envoi du test interne."
          : "Confirmez la qualification et la conformité avant l’envoi.",
      );
      return;
    }

    sendingRef.current = true;
    setSending(true);
    setStatus("Envoi en cours…");
    try {
      const execution = await executeFrozenSend({
        slot: COMPOSE_DRAFT_SLOT,
        payload,
        send: onSend,
        onReserved: (draft) => setDraftState({ ready: true, frozen: draft }),
      });
      setDraftState({ ready: true, frozen: execution.draft });
      setStatus(execution.message);
      if (execution.acceptedAndSettled) {
        setFields((current) => ({
          ...current,
          to: "",
          subject: "",
          body: "",
          complianceConfirmed: false,
        }));
        setStatus("");
        onClose();
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  return <ComposeDialogView
    view={{ dialogRef, fields, mailboxes: salesMailboxes, presentation, status }}
    actions={{
      close: onClose,
      setCompliance: (confirmed) => setFields((current) => ({
        ...current,
        complianceConfirmed: confirmed,
      })),
      setText: (field, value) => setFields((current) => ({
        ...current,
        [field]: value,
      })),
      submit: () => void submit(),
    }}
  />;
}

function ComposeDialogView({ view, actions }: ComposeDialogViewProps) {
  const { dialogRef, fields, mailboxes, presentation, status } = view;
  return (
    <dialog
      ref={dialogRef}
      className="compose-dialog"
      onClose={actions.close}
      onCancel={(event) => {
        event.preventDefault();
        actions.close();
      }}
    >
      <form
        method="dialog"
        onSubmit={(event) => {
          event.preventDefault();
          actions.submit();
        }}
      >
        <header><h2>{presentation.title}</h2><button type="button" onClick={actions.close} aria-label="Fermer"><Icon name="close" /></button></header>
        <label><span>De</span><select disabled={presentation.fieldsDisabled} value={fields.from} onChange={(event) => actions.setText("from", event.target.value)}>{mailboxes.map((mailbox) => <option key={mailbox.address}>{mailbox.address}</option>)}</select></label>
        <label><span>À</span><input disabled={presentation.fieldsDisabled} type="email" required value={fields.to} onChange={(event) => actions.setText("to", event.target.value)} /></label>
        <label><span>Objet</span><input disabled={presentation.fieldsDisabled} required value={fields.subject} onChange={(event) => actions.setText("subject", event.target.value)} /></label>
        <textarea disabled={presentation.fieldsDisabled} aria-label="Message" required rows={12} value={fields.body} onChange={(event) => actions.setText("body", event.target.value)} placeholder="Écrivez votre message…" />
        <label className="check-label"><input disabled={presentation.fieldsDisabled} type="checkbox" checked={fields.complianceConfirmed} onChange={(event) => actions.setCompliance(event.target.checked)} /> {presentation.confirmationLabel}</label>
        <footer>
          <p role="status">{status}</p>
          <button className="send-button" type="submit" disabled={presentation.submitDisabled}>
            <Icon name="send" /> {presentation.submitLabel}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function composePresentation(
  fields: ComposeFields,
  draftState: ComposeDraftState,
  sending: boolean,
): ComposePresentation {
  const isDeliverabilityCanary =
    fields.from === DELIVERABILITY_CANARY_SENDER &&
    fields.to.trim().toLowerCase() === DELIVERABILITY_CANARY_RECIPIENT;
  const locallyAccepted = draftState.frozen?.outcome === "local_repair";
  const unknownFrozen = draftState.frozen?.outcome === "outcome_unknown";
  let submitLabel = "Envoyer";
  if (isDeliverabilityCanary) submitLabel = "Envoyer le test";
  if (locallyAccepted) submitLabel = "Réparer le CRM";
  if (sending) submitLabel = "Envoi…";
  return {
    confirmationLabel: isDeliverabilityCanary
      ? "Je confirme qu’il s’agit d’un test interne envoyé uniquement à votre boîte Gmail 27PM."
      : "Je confirme qu’il s’agit d’un seul destinataire qualifié, que le fondement et les preuves sont à jour et que le message concerne précisément ses fonctions.",
    fieldsDisabled: [!draftState.ready, draftState.frozen !== null, sending].includes(true),
    isDeliverabilityCanary,
    submitDisabled: [!draftState.ready, sending, unknownFrozen].includes(true),
    submitLabel,
    title: isDeliverabilityCanary ? "Test de délivrabilité 27PM" : "Nouveau courriel",
    unknownFrozen,
  };
}

function composePayload(payload: SendAttemptPayload): ComposePayload | null {
  return typeof payload.from === "string" &&
    typeof payload.to === "string" &&
    typeof payload.subject === "string" &&
    typeof payload.body === "string" &&
    payload.complianceConfirmed === true
    ? {
        from: payload.from,
        to: payload.to,
        subject: payload.subject,
        body: payload.body,
        complianceConfirmed: true,
      }
    : null;
}
