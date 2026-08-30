"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Contact, Organization } from "../crm-types";

type Props = {
  account: Organization | null; contact: Contact | null; open: boolean;
  onClose: () => void; onSaved: () => Promise<void>;
};

export function ContactDialog({ account, contact, open, onClose, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => firstField.current?.focus());
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("keydown", closeOnEscape); };
  }, [onClose, open]);

  if (!open || !account) return null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      organizationId: account!.id, name: form.get("name"), email: form.get("email"),
      phone: form.get("phone"), role: form.get("role"), sourceLabel: form.get("sourceLabel"),
      sourceUrl: form.get("sourceUrl"), sourceDate: form.get("sourceDate"),
      contactBasis: form.get("contactBasis"), roleRelevance: form.get("roleRelevance"),
      dnclStatus: form.get("dnclStatus"), emailStatus: form.get("emailStatus"),
      doNotCall: form.get("doNotCall") === "on", doNotContact: form.get("doNotContact") === "on",
      unsubscribed: form.get("unsubscribed") === "on", validated: form.get("validated") === "on",
      nextFollowUpAt: dateIso(form.get("nextFollowUpAt")),
    };
    try {
      const response = await fetch(contact ? `/api/contacts/${encodeURIComponent(contact.id)}` : "/api/contacts", {
        method: contact ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(body.error ?? "contact_save_failed");
      }
      await onSaved(); onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "contact_save_failed");
    } finally { setBusy(false); }
  }

  async function remove() {
    if (!contact || !window.confirm("Supprimer ce contact et bloquer définitivement toute action de contact?")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(contact.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("contact_delete_failed");
      await onSaved(); onClose();
    } catch { setError("contact_delete_failed"); } finally { setBusy(false); }
  }

  return <div className="dialog-backdrop" role="presentation"><section className="crm-dialog account-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-dialog-title"><header><div><p className="eyebrow">{account.name}</p><h2 id="contact-dialog-title">{contact ? "Modifier le contact" : "Ajouter un contact vérifié"}</h2></div><button type="button" className="icon-button" aria-label="Fermer" onClick={onClose}>×</button></header><form onSubmit={submit}><div className="form-grid">
    <label>Nom validé<input ref={firstField} required name="name" maxLength={200} defaultValue={contact?.name ?? ""} /></label><label>Courriel validé<input required name="email" type="email" defaultValue={contact?.email ?? ""} readOnly={contact?.doNotContact || contact?.unsubscribed} /></label><label>Téléphone (facultatif)<input name="phone" type="tel" defaultValue={contact?.phone ?? ""} /></label><label>Rôle professionnel<input required name="role" defaultValue={contact?.role ?? ""} /></label>
    <label>Source<input required name="sourceLabel" defaultValue={contact?.source ?? ""} /></label><label>URL de source<input required name="sourceUrl" type="url" defaultValue={contact?.sourceUrl ?? ""} /></label><label>Date de source<input required name="sourceDate" type="date" defaultValue={contact?.sourceDate ?? ""} /></label><label>Prochaine relance<input name="nextFollowUpAt" type="date" defaultValue={contact?.nextFollowUpAt?.slice(0, 10) ?? ""} /></label>
    <label>Fondement<select required name="contactBasis" defaultValue={contact?.contactBasis ?? ""}><option value="" disabled>Choisir…</option><option value="inbound_request">Demande entrante</option><option value="explicit_consent">Consentement explicite</option><option value="legitimate_interest">Intérêt légitime documenté</option><option value="existing_client">Client existant</option></select></label>
    <label>Pertinence du rôle<select required name="roleRelevance" defaultValue={contact?.roleRelevance ?? "relevant"}><option value="relevant">Pertinent</option><option value="not_relevant">Non pertinent</option></select></label><label>Statut courriel<select required name="emailStatus" defaultValue={contact?.emailStatus ?? "valid"} disabled={contact?.unsubscribed}><option value="valid">Valide</option><option value="bounced">Rebond</option><option value="invalid">Invalide</option><option value="unsubscribed">Désabonné</option></select>{contact?.unsubscribed ? <input type="hidden" name="emailStatus" value="unsubscribed" /> : null}</label><label>Contrôle LNNTE<select required name="dnclStatus" defaultValue={contact?.dnclStatus ?? "not_checked"}><option value="not_checked">Non contrôlé</option><option value="not_listed">Non inscrit</option><option value="listed">Inscrit</option><option value="not_applicable">Non applicable</option></select></label>
    <label className="check-label"><input name="doNotCall" type="checkbox" defaultChecked={contact?.doNotCall} /> Ne pas appeler</label><label className="check-label"><input name="unsubscribed" type="checkbox" defaultChecked={contact?.unsubscribed} disabled={contact?.unsubscribed} /> Désabonné (irréversible)</label><label className="check-label"><input name="doNotContact" type="checkbox" defaultChecked={contact?.doNotContact} disabled={contact?.doNotContact} /> Ne pas contacter (irréversible)</label><label className="check-label form-span"><input required name="validated" type="checkbox" defaultChecked={contact?.validated} /> Je confirme avoir vérifié l’identité, les coordonnées, la source et la pertinence professionnelle.</label>
  </div>{error ? <p className="form-error" role="alert">Impossible d’enregistrer : {error}</p> : null}<footer>{contact ? <button type="button" className="danger-action" disabled={busy} onClick={() => void remove()}>Supprimer</button> : null}<span className="dialog-spacer" /><button type="button" className="secondary-action" onClick={onClose}>Annuler</button><button className="primary-action" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</button></footer></form></section></div>;
}

function dateIso(value: FormDataEntryValue | null) {
  return typeof value === "string" && value ? `${value}T12:00:00.000Z` : null;
}
