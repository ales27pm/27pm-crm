"use client";

import { useState, type FormEvent } from "react";
import type { Organization } from "../crm-types";

export function AccountDialog({ account, open, onClose, onSaved }: { account: Organization | null; open: boolean; onClose: () => void; onSaved: () => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!open) return null;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const dollars = (name: string) => form.get(name) ? Math.round(Number(form.get(name)) * 100) : null;
    const payload = {
      name: form.get("name"), website: form.get("website"), sourceLabel: form.get("sourceLabel"), sourceUrl: form.get("sourceUrl"), sourceDate: form.get("sourceDate"),
      score: form.get("score"), priority: form.get("priority"), budgetMinCents: dollars("budgetMin"), budgetMaxCents: dollars("budgetMax"), ownerEmail: form.get("ownerEmail"),
      nextFollowUpAt: dateIso(form.get("nextFollowUpAt")), nextStep: form.get("nextStep"), notes: form.get("notes"), doNotContact: form.get("doNotContact") === "on",
    };
    try {
      const response = await fetch(account ? `/api/organizations/${encodeURIComponent(account.id)}` : "/api/organizations", { method: account ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) { const body = await response.json().catch(() => ({})) as { error?: string }; throw new Error(body.error ?? "account_save_failed"); }
      await onSaved(); onClose();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "account_save_failed"); } finally { setBusy(false); }
  }
  async function remove() {
    if (!account || !window.confirm("Supprimer cette entreprise et bloquer définitivement toute action de contact?")) return;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/organizations/${encodeURIComponent(account.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("account_delete_failed");
      await onSaved(); onClose();
    } catch { setError("account_delete_failed"); } finally { setBusy(false); }
  }
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="crm-dialog account-dialog" role="dialog" aria-modal="true" aria-labelledby="account-dialog-title" onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
      <header><div><p className="eyebrow">Compte</p><h2 id="account-dialog-title">{account ? "Modifier l’entreprise" : "Nouvelle entreprise"}</h2></div><button type="button" className="icon-button" aria-label="Fermer" onClick={onClose}>×</button></header>
      <form onSubmit={submit}>
        <div className="form-grid">
          <label>Entreprise<input autoFocus required name="name" defaultValue={account?.name ?? ""} maxLength={200} /></label>
          <label>Site web<input name="website" type="url" defaultValue={account?.website ?? ""} /></label>
          <label>Source<input required name="sourceLabel" defaultValue={account?.sourceLabel ?? "Recherche opérateur"} maxLength={200} /></label>
          <label>URL de source<input name="sourceUrl" type="url" defaultValue={account?.sourceUrl ?? ""} /></label>
          <label>Date de source<input name="sourceDate" type="date" defaultValue={account?.sourceDate ?? ""} /></label>
          <label>Score / 100<input name="score" type="number" min="0" max="100" defaultValue={account?.score ?? ""} /></label>
          <label>Priorité<select name="priority" defaultValue={account?.priority ?? "normal"}><option value="very_high">Très élevée</option><option value="high">Élevée</option><option value="normal">Normale</option><option value="low">Basse</option></select></label>
          <label>Propriétaire<input name="ownerEmail" type="email" defaultValue={account?.ownerEmail ?? ""} placeholder="Non assigné" /></label>
          <label>Budget indicatif min. (CAD)<input name="budgetMin" type="number" min="0" step="1" defaultValue={account?.budgetMinCents == null ? "" : account.budgetMinCents / 100} /></label>
          <label>Budget indicatif max. (CAD)<input name="budgetMax" type="number" min="0" step="1" defaultValue={account?.budgetMaxCents == null ? "" : account.budgetMaxCents / 100} /></label>
          <label>Prochaine relance<input name="nextFollowUpAt" type="date" defaultValue={account?.nextFollowUpAt?.slice(0, 10) ?? ""} /></label>
          <label className="form-span">Prochaine étape<input name="nextStep" defaultValue={account?.nextStep ?? ""} maxLength={500} /></label>
          <label className="form-span">Notes<textarea name="notes" defaultValue={account?.notes ?? ""} maxLength={10000} rows={3} /></label>
          <label className="check-label form-span"><input name="doNotContact" type="checkbox" defaultChecked={account?.doNotContact} disabled={account?.doNotContact} /> Bloquer définitivement toute action de contact pour cette entreprise</label>
        </div>
        {error ? <p className="form-error" role="alert">Impossible d’enregistrer : {error}</p> : null}
        <footer>{account ? <button type="button" className="danger-action" disabled={busy} onClick={() => void remove()}>Supprimer</button> : null}<span className="dialog-spacer" /><button type="button" className="secondary-action" onClick={onClose}>Annuler</button><button className="primary-action" disabled={busy}>{busy ? "Enregistrement…" : "Enregistrer"}</button></footer>
      </form>
    </section>
  </div>;
}

function dateIso(value: FormDataEntryValue | null) { return typeof value === "string" && value ? `${value}T12:00:00.000Z` : null; }
