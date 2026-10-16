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
import type { SendUiOptions, SendUiResult } from "../../lib/send-ui-result";
import {
  defaultComposeMailbox,
  MAIL_SEND_DISABLED_REASON,
} from "../../lib/mail-ui-state";
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
  selectedMailboxAddress: string;
  sendEnabled: boolean;
  onClose: () => void;
  onSend: (
    payload: { from: string; to: string; subject: string; body: string; complianceConfirmed: boolean; controlledCanary: boolean },
    options?: SendUiOptions,
  ) => Promise<SendUiResult>;
};

type ComposePayload = {
  from: string;
  to: string;
  subject: string;
  body: string;
  complianceConfirmed: true;
  controlledCanary: boolean;
};

type ComposeFields = Omit<ComposePayload, "complianceConfirmed"> & {
  complianceConfirmed: boolean;
};

type ComposeDraftState = {
  ready: boolean;
  frozen: FrozenSendDraft | null;
};

type ComposeConfirmationState = {
  payload: ComposePayload;
  localRepair: boolean;
};

type ComposePresentation = {
  confirmationLabel: string;
  fieldsDisabled: boolean;
  isDeliverabilityCanary: boolean;
  localRepair: boolean;
  sendDisabledReason: string;
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
    confirmation: ComposeConfirmationState | null;
    status: string;
  };
  actions: {
    cancelConfirmation: () => void;
    close: () => void;
    confirm: () => void;
    setCompliance: (confirmed: boolean) => void;
    setControlledCanary: (controlled: boolean) => void;
    setText: (field: "from" | "to" | "subject" | "body", value: string) => void;
    submit: () => void;
  };
  sendButtonRef: RefObject<HTMLButtonElement | null>;
};

const COMPOSE_DRAFT_SLOT = "compose";

export function ComposeDialog({
  open,
  mailboxes,
  selectedMailboxAddress,
  sendEnabled,
  onClose,
  onSend,
}: ComposeDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationReturnFocusRef = useRef<HTMLElement | null>(null);
  const sendingRef = useRef(false);
  const salesMailboxes = mailboxes.filter((mailbox) => mailbox.kind === "sales");
  const [fields, setFields] = useState<ComposeFields>({
    from: defaultComposeMailbox(mailboxes, selectedMailboxAddress),
    to: "",
    subject: "",
    body: "",
    complianceConfirmed: false,
    controlledCanary: false,
  });
  const [status, setStatus] = useState("");
  const [sending, setSending] = useState(false);
  const [senderExplicitlySelected, setSenderExplicitlySelected] = useState(false);
  const [confirmation, setConfirmation] =
    useState<ComposeConfirmationState | null>(null);
  const [draftState, setDraftState] = useState<ComposeDraftState>({
    ready: false,
    frozen: null,
  });
  const { ready: draftReady, frozen: frozenDraft } = draftState;
  const selectedDefaultMailbox = defaultComposeMailbox(
    mailboxes,
    selectedMailboxAddress,
  );
  const effectiveFields = !senderExplicitlySelected && composeFieldsAreEmpty(fields)
    ? { ...fields, from: selectedDefaultMailbox }
    : fields;
  const { from, to, subject, body, complianceConfirmed, controlledCanary } = effectiveFields;
  const presentation = composePresentation(
    effectiveFields,
    draftState,
    sending,
    sendEnabled,
    confirmation !== null,
  );

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
    if (
      !draftReady ||
      sendingRef.current ||
      presentation.unknownFrozen ||
      confirmation
    ) return;
    if (
      !sendEnabled &&
      !presentation.isDeliverabilityCanary &&
      !presentation.localRepair
    ) {
      setStatus("Configurez le transport de courriel avant l’envoi.");
      return;
    }
    const payload = frozenDraft
      ? composePayload(frozenDraft.payload)
      : composePayload({ from, to, subject, body, complianceConfirmed, controlledCanary });
    if (!payload) {
      setStatus(
        presentation.isDeliverabilityCanary
          ? "Confirmez l’envoi du test interne."
          : "Confirmez la qualification et la conformité avant l’envoi.",
      );
      return;
    }

    confirmationReturnFocusRef.current = sendButtonRef.current;
    setConfirmation({ payload, localRepair: presentation.localRepair });
  }

  function cancelConfirmation(message = "") {
    setConfirmation(null);
    setStatus(message);
    const returnFocus = confirmationReturnFocusRef.current;
    confirmationReturnFocusRef.current = null;
    window.requestAnimationFrame(() => returnFocus?.focus());
  }

  function confirm() {
    if (!confirmation || sendingRef.current) return;
    const currentPayload = frozenDraft
      ? composePayload(frozenDraft.payload)
      : composePayload(effectiveFields);
    const currentIsCanary = composeIsDeliverabilityCanary(effectiveFields);
    const currentIsLocalRepair = frozenDraft?.outcome === "local_repair";
    if (
      !currentPayload ||
      !sameComposePayload(currentPayload, confirmation.payload) ||
      currentIsLocalRepair !== confirmation.localRepair ||
      (!sendEnabled && !currentIsCanary && !currentIsLocalRepair)
    ) {
      cancelConfirmation(
        "Le brouillon ou le transport a changé pendant la vérification; rien n’a été transmis.",
      );
      return;
    }
    setConfirmation(null);
    confirmationReturnFocusRef.current = null;
    void dispatch(currentPayload, confirmation.localRepair);
  }

  async function dispatch(payload: ComposePayload, repairOnly: boolean) {
    sendingRef.current = true;
    setSending(true);
    setStatus("Envoi en cours…");
    try {
      const execution = await executeFrozenSend({
        slot: COMPOSE_DRAFT_SLOT,
        payload,
        send: (exactPayload) => onSend(exactPayload as ComposePayload, { repairOnly }),
        onReserved: (draft) => setDraftState({ ready: true, frozen: draft }),
      });
      setDraftState({ ready: true, frozen: execution.draft });
      setStatus(execution.message);
      if (execution.acceptedAndSettled) {
        setFields((current) => ({
          ...current,
          from: defaultComposeMailbox(mailboxes, selectedMailboxAddress),
          to: "",
          subject: "",
          body: "",
          complianceConfirmed: false,
          controlledCanary: false,
        }));
        setSenderExplicitlySelected(false);
        setStatus("");
        setConfirmation(null);
        onClose();
      }
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  function close() {
    setConfirmation(null);
    confirmationReturnFocusRef.current = null;
    onClose();
  }

  return <ComposeDialogView
    view={{
      dialogRef,
      fields: effectiveFields,
      mailboxes: salesMailboxes,
      presentation,
      confirmation,
      status,
    }}
    actions={{
      cancelConfirmation,
      close,
      confirm,
      setCompliance: (confirmed) => setFields((current) => ({
        ...current,
        from: !senderExplicitlySelected && composeFieldsAreEmpty(current)
          ? selectedDefaultMailbox
          : current.from,
        complianceConfirmed: confirmed,
      })),
      setControlledCanary: (controlled) => setFields((current) => ({
        ...current,
        from: !senderExplicitlySelected && composeFieldsAreEmpty(current)
          ? selectedDefaultMailbox
          : current.from,
        controlledCanary: controlled,
        complianceConfirmed: false,
      })),
      setText: (field, value) => {
        if (field === "from") setSenderExplicitlySelected(true);
        setFields((current) => ({
          ...current,
          from: field !== "from" && !senderExplicitlySelected && composeFieldsAreEmpty(current)
            ? selectedDefaultMailbox
            : current.from,
          [field]: value,
          ...(current[field] !== value ? { complianceConfirmed: false } : {}),
          ...(field === "from" && value !== DELIVERABILITY_CANARY_SENDER
            ? { controlledCanary: false }
            : {}),
          ...(field === "to" ? { controlledCanary: false } : {}),
        }));
      },
      submit: () => void submit(),
    }}
    sendButtonRef={sendButtonRef}
  />;
}

function ComposeDialogView({ view, actions, sendButtonRef }: ComposeDialogViewProps) {
  const { dialogRef, fields, mailboxes, presentation, status } = view;
  return <>
    <dialog
      ref={dialogRef}
      className="compose-dialog"
      aria-labelledby="compose-dialog-title"
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
        <header><h2 id="compose-dialog-title">{presentation.title}</h2><button type="button" onClick={actions.close} aria-label="Fermer"><Icon name="close" /></button></header>
        <label><span>De</span><select disabled={presentation.fieldsDisabled} value={fields.from} onChange={(event) => actions.setText("from", event.target.value)}>{mailboxes.map((mailbox) => <option key={mailbox.address}>{mailbox.address}</option>)}</select></label>
        <label><span>À</span><input disabled={presentation.fieldsDisabled} type="email" required value={fields.to} onChange={(event) => actions.setText("to", event.target.value)} /></label>
        {fields.from === DELIVERABILITY_CANARY_SENDER ? (
          <details className="compose-admin-tools">
            <summary>Outils administratifs de délivrabilité</summary>
            <label className="check-label"><input disabled={presentation.fieldsDisabled} type="checkbox" checked={fields.controlledCanary} onChange={(event) => actions.setControlledCanary(event.target.checked)} /> Cette adresse est une boîte témoin que je contrôle; envoyer un test administratif, sans dossier prospect.</label>
          </details>
        ) : null}
        <label><span>Objet</span><input disabled={presentation.fieldsDisabled} required value={fields.subject} onChange={(event) => actions.setText("subject", event.target.value)} /></label>
        <textarea disabled={presentation.fieldsDisabled} aria-label="Message" required rows={12} value={fields.body} onChange={(event) => actions.setText("body", event.target.value)} placeholder="Écrivez votre message…" />
        <label className="check-label"><input disabled={presentation.fieldsDisabled} type="checkbox" checked={fields.complianceConfirmed} onChange={(event) => actions.setCompliance(event.target.checked)} /> {presentation.confirmationLabel}</label>
        {presentation.sendDisabledReason ? (
          <p className="send-capability-notice" role="note">
            {presentation.sendDisabledReason}
          </p>
        ) : null}
        <footer>
          <p role="status">{status}</p>
          <button ref={sendButtonRef} className="send-button" type="submit" disabled={presentation.submitDisabled}>
            <Icon name="send" /> {presentation.submitLabel}
          </button>
        </footer>
      </form>
    </dialog>
    {view.confirmation ? (
      <ComposeConfirmation
        payload={view.confirmation.payload}
        isDeliverabilityCanary={presentation.isDeliverabilityCanary}
        localRepair={view.confirmation.localRepair}
        sending={presentation.fieldsDisabled && presentation.submitLabel === "Envoi…"}
        onCancel={actions.cancelConfirmation}
        onConfirm={actions.confirm}
      />
    ) : null}
  </>;
}

function composePresentation(
  fields: ComposeFields,
  draftState: ComposeDraftState,
  sending: boolean,
  sendEnabled: boolean,
  confirmationOpen: boolean,
): ComposePresentation {
  const isDeliverabilityCanary = composeIsDeliverabilityCanary(fields);
  const localRepair = draftState.frozen?.outcome === "local_repair";
  const unknownFrozen = draftState.frozen?.outcome === "outcome_unknown";
  let submitLabel = "Envoyer";
  if (isDeliverabilityCanary) submitLabel = "Envoyer le test";
  if (localRepair) submitLabel = "Réparer le CRM";
  if (sending) submitLabel = "Envoi…";
  return {
    confirmationLabel: isDeliverabilityCanary
      ? "Je confirme un seul test interne vers la boîte témoin indiquée, sans envoi à un prospect."
      : "Je confirme qu’il s’agit d’un seul destinataire qualifié, que le fondement et les preuves sont à jour et que le message concerne précisément ses fonctions.",
    fieldsDisabled: [!draftState.ready, draftState.frozen !== null, sending, confirmationOpen].includes(true),
    isDeliverabilityCanary,
    localRepair,
    sendDisabledReason: !sendEnabled && !isDeliverabilityCanary && !localRepair
      ? MAIL_SEND_DISABLED_REASON
      : "",
    submitDisabled: [
      !draftState.ready,
      sending,
      unknownFrozen,
      confirmationOpen,
      !sendEnabled && !isDeliverabilityCanary && !localRepair,
    ].includes(true),
    submitLabel,
    title: isDeliverabilityCanary ? "Test de délivrabilité 27PM" : "Nouveau courriel",
    unknownFrozen,
  };
}

function ComposeConfirmation({
  payload,
  isDeliverabilityCanary,
  localRepair,
  sending,
  onCancel,
  onConfirm,
}: {
  payload: ComposePayload;
  isDeliverabilityCanary: boolean;
  localRepair: boolean;
  sending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!dialog.open) dialog.showModal();
    const frame = window.requestAnimationFrame(() => cancelButtonRef.current?.focus());
    return () => {
      window.cancelAnimationFrame(frame);
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      className="reply-confirmation compose-confirmation"
      aria-modal="true"
      aria-labelledby="compose-confirmation-title"
      aria-describedby="compose-confirmation-description"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <form onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
        <header>
          <p className="eyebrow">Étape 2 sur 2</p>
          <h2 id="compose-confirmation-title">
            {localRepair
              ? "Réparer l’enregistrement CRM"
              : isDeliverabilityCanary
                ? "Confirmer le test administratif"
                : "Confirmer le courriel"}
          </h2>
        </header>
        <div className="reply-confirmation-content">
          <p id="compose-confirmation-description">
            {localRepair
              ? "Le transport a déjà accepté ce courriel. Cette action réutilise uniquement la tentative originale pour réparer son enregistrement CRM; elle ne crée aucun nouvel envoi."
              : isDeliverabilityCanary
              ? "Vérifiez ce test exact. En confirmant, vous autorisez un seul envoi vers la boîte témoin indiquée."
              : "Vérifiez ce courriel exact. En confirmant, vous attestez que le destinataire unique est qualifié et que le fondement ainsi que les preuves sont à jour."}
          </p>
          <dl className="reply-confirmation-details">
            <div><dt>De</dt><dd>{payload.from}</dd></div>
            <div><dt>À</dt><dd>{payload.to}</dd></div>
            <div><dt>Objet</dt><dd>{payload.subject}</dd></div>
          </dl>
          <section className="reply-confirmation-message" aria-labelledby="compose-confirmation-message-title">
            <h3 id="compose-confirmation-message-title">Message exact</h3>
            <pre>{payload.body}</pre>
          </section>
        </div>
        <footer>
          <button ref={cancelButtonRef} className="secondary-action" type="button" disabled={sending} onClick={onCancel}>Annuler</button>
          <button className="primary-action" type="submit" disabled={sending}>
            {localRepair
              ? "Confirmer la réparation"
              : isDeliverabilityCanary
                ? "Confirmer et envoyer le test"
                : "Confirmer et envoyer"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}

function composeIsDeliverabilityCanary(fields: ComposeFields): boolean {
  return fields.from === DELIVERABILITY_CANARY_SENDER &&
    (fields.to.trim().toLowerCase() === DELIVERABILITY_CANARY_RECIPIENT ||
      fields.controlledCanary);
}

function sameComposePayload(left: ComposePayload, right: ComposePayload): boolean {
  return left.from === right.from &&
    left.to === right.to &&
    left.subject === right.subject &&
    left.body === right.body &&
    left.complianceConfirmed === right.complianceConfirmed &&
    left.controlledCanary === right.controlledCanary;
}

function composeFieldsAreEmpty(fields: ComposeFields): boolean {
  return !fields.to &&
    !fields.subject &&
    !fields.body &&
    !fields.complianceConfirmed &&
    !fields.controlledCanary;
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
        controlledCanary: payload.controlledCanary === true,
      }
    : null;
}
