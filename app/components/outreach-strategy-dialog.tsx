"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Contact, Organization, OutreachStrategy } from "../crm-types";
import {
  zonedDateTimeParts,
  zonedDateTimeValue,
  zonedLocalDateTimeIso,
} from "../../lib/zoned-date-time";
import { outreachErrorMessage } from "../../lib/outreach-errors";

type Props = {
  account: Organization | null;
  contacts: Contact[];
  strategy: OutreachStrategy | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
};

export function OutreachStrategyDialog({ account, contacts, strategy, open, onClose, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstField = useRef<HTMLInputElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const busyRef = useRef(busy);
  const closeRef = useRef(onClose);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    closeRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => firstField.current?.focus());
    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) {
        event.preventDefault();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(
        "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]",
      ) ?? []);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleDialogKeys);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", handleDialogKeys);
      previousFocus.current?.focus();
    };
  }, [open]);

  if (!open || !account) return null;
  const currentAccount = account;
  const relatedContacts = contacts.filter((contact) => contact.organizationId === currentAccount.id);
  const strategyTimezone = strategy?.recipientTimezone ?? "America/Toronto";
  const completed = strategy?.status === "completed";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const start = String(form.get("recommendedStartAt") ?? "");
    const captured = String(form.get("researchCapturedAt") ?? "");
    const recipientTimezone = String(form.get("recipientTimezone") ?? "");
    const payload = {
      version: strategy?.version ?? null,
      status: form.get("status"),
      contactId: form.get("contactId") || null,
      objective: form.get("objective"),
      targetName: form.get("targetName"),
      targetRole: form.get("targetRole"),
      valueProposition: form.get("valueProposition"),
      openingAngle: form.get("openingAngle"),
      timingRationale: form.get("timingRationale"),
      contactResearchNotes: form.get("contactResearchNotes"),
      recommendedStartAt: zonedLocalDateTimeIso(start, recipientTimezone),
      recipientTimezone,
      researchSource: form.get("researchSource"),
      researchSourceUrl: form.get("researchSourceUrl") || null,
      researchCapturedAt: captured ? `${captured}T12:00:00.000Z` : null,
    };
    try {
      const response = await fetch(`/api/strategies/${encodeURIComponent(currentAccount.id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; detail?: string };
      if (!response.ok) throw new Error(body.detail || body.error || "strategy_save_failed");
      try {
        await onSaved();
      } finally {
        onClose();
      }
    } catch (cause) {
      setError(outreachErrorMessage(cause instanceof Error ? cause.message : "strategy_save_failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="crm-dialog outreach-dialog" role="dialog" aria-modal="true" aria-labelledby="outreach-dialog-title">
        <header>
          <div><p className="eyebrow">{currentAccount.name}</p><h2 id="outreach-dialog-title">Préparer la stratégie d’approche</h2></div>
          <button type="button" className="icon-button" aria-label="Fermer" disabled={busy} onClick={onClose}>×</button>
        </header>
        <form onSubmit={submit}>
          <fieldset className="form-grid" disabled={busy || completed}>
            <p className="form-span settings-warning">
              Une stratégie peut être planifiée sans autoriser le contact. Aucun courriel n’est envoyé par ce formulaire.
            </p>
            <label>Objectif<input ref={firstField} required name="objective" maxLength={2000} defaultValue={strategy?.objective ?? `Obtenir une discussion exploratoire avec ${currentAccount.name}.`} /></label>
            <label>
              État
              {strategy?.status === "completed" ? (
                <select name="status" defaultValue="completed"><option value="completed">Terminée — historique verrouillé</option></select>
              ) : (
                <select name="status" defaultValue={strategy?.status ?? "draft"}><option value="draft">Brouillon</option><option value="ready">Prête</option><option value="active">Active</option><option value="paused">En pause</option><option value="completed">Terminée</option><option value="archived">Archivée</option></select>
              )}
            </label>
            <label>Personne ciblée<input name="targetName" maxLength={300} defaultValue={strategy?.targetName ?? ""} placeholder="Nom public vérifié, sinon laisser vide" /></label>
            <label>Rôle ciblé<input required name="targetRole" maxLength={500} defaultValue={strategy?.targetRole ?? "Direction générale, ventes ou marketing"} /></label>
            <label>Contact lié<select name="contactId" defaultValue={strategy?.contactId ?? ""}><option value="">Aucun — étapes courriel bloquées</option>{relatedContacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name} · {contact.email}</option>)}</select></label>
            <label>Date et heure du premier courriel<input required name="recommendedStartAt" type="datetime-local" defaultValue={strategy ? zonedDateTimeValue(strategy.recommendedStartAt, strategyTimezone) : nextBusinessMorningValue(strategyTimezone)} /></label>
            <label>Fuseau du destinataire<input required name="recipientTimezone" defaultValue={strategyTimezone} placeholder="America/Toronto" /></label>
            <label className="form-span">Valeur proposée<textarea required name="valueProposition" maxLength={4000} defaultValue={strategy?.valueProposition ?? "Audit ciblé et aperçu concret d’une amélioration commerciale du site."} /></label>
            <label className="form-span">Angle d’ouverture<textarea required name="openingAngle" maxLength={4000} defaultValue={strategy?.openingAngle ?? "Relier un constat Web observable à une occasion commerciale précise."} /></label>
            <label className="form-span">Pourquoi maintenant<textarea required name="timingRationale" maxLength={4000} defaultValue={strategy?.timingRationale ?? "Valider un signal commercial actuel avant de lancer la séquence."} /></label>
            <label className="form-span">Notes de recherche contact<textarea name="contactResearchNotes" maxLength={8000} defaultValue={strategy?.contactResearchNotes ?? ""} /></label>
            <label>Source de recherche<input name="researchSource" maxLength={500} defaultValue={strategy?.researchSource ?? "Recherche publique manuelle"} /></label>
            <label>URL de recherche<input name="researchSourceUrl" type="url" defaultValue={strategy?.researchSourceUrl ?? currentAccount.sourceUrl ?? ""} /></label>
            <label>Date de recherche<input name="researchCapturedAt" type="date" defaultValue={strategy?.researchCapturedAt?.slice(0, 10) ?? new Date().toISOString().slice(0, 10)} /></label>
          </fieldset>
          {error ? <p className="form-error" role="alert">Impossible d’enregistrer : {error}</p> : null}
          <footer>
            <span className="dialog-spacer" />
            <button type="button" className="secondary-action" disabled={busy} onClick={onClose}>{completed ? "Fermer" : "Annuler"}</button>
            {!completed ? <button className="primary-action" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer le plan"}</button> : null}
          </footer>
        </form>
      </section>
    </div>
  );
}

function nextBusinessMorningValue(timeZone: string): string {
  const now = zonedDateTimeParts(new Date(), timeZone);
  const date = new Date(Date.UTC(Number(now.year), Number(now.month) - 1, Number(now.day)));
  do {
    date.setUTCDate(date.getUTCDate() + 1);
  } while (date.getUTCDay() === 0 || date.getUTCDay() === 6);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}T09:30`;
}
