"use client";

import { useEffect, useState, type FormEvent } from "react";
import type { Contact } from "../crm-types";

type PrivacyRequest = {
  id: string; contactId: string | null; requestType: string; status: string;
  requesterReference: string; requestedAt: string; dueAt: string | null;
  resolutionNote: string;
};

export function PrivacyRequestsPanel({ contacts }: { contacts: Contact[] }) {
  const [requests, setRequests] = useState<PrivacyRequest[] | null>(null);
  const [status, setStatus] = useState("Chargement des demandes…");

  async function refresh(signal?: AbortSignal) {
    const loaded = await fetchPrivacyRequests(signal);
    setRequests(loaded); setStatus("");
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetchPrivacyRequests(controller.signal)
      .then((loaded) => { setRequests(loaded); setStatus(""); })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("Demandes de droits indisponibles.");
      });
    return () => controller.abort();
  }, []);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setStatus("Enregistrement…");
    const form = new FormData(event.currentTarget);
    const payload = { contactId: form.get("contactId"), requestType: form.get("requestType"), requesterReference: form.get("requesterReference"), dueAt: dateIso(form.get("dueAt")) };
    try {
      const response = await fetch("/api/privacy-requests", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "privacy_request_create_failed");
      event.currentTarget.reset(); await refresh();
    } catch (error) { setStatus(`Échec : ${error instanceof Error ? error.message : "privacy_request_create_failed"}`); }
  }

  async function update(event: FormEvent<HTMLFormElement>, id: string) {
    event.preventDefault(); setStatus("Mise à jour…");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch(`/api/privacy-requests/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status: form.get("status"), resolutionNote: form.get("resolutionNote") }) });
      if (!response.ok) throw new Error((await response.json().catch(() => ({})) as { error?: string }).error ?? "privacy_request_update_failed");
      await refresh();
    } catch (error) { setStatus(`Échec : ${error instanceof Error ? error.message : "privacy_request_update_failed"}`); }
  }

  return <div className="settings-section"><h2>Droits des personnes</h2><p className="settings-warning">Flux manuel journalisé. Vérifiez l’identité hors des notes; n’y inscrivez aucune donnée sensible. L’application n’exécute ni export ni destruction automatiquement.</p>
    <form className="form-grid" onSubmit={create}>
      <label>Contact associé (facultatif)<select name="contactId" defaultValue=""><option value="">Aucun dossier associé</option>{contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.name} · {contact.email}</option>)}</select></label>
      <label>Type<select name="requestType" defaultValue="access"><option value="access">Accès</option><option value="rectification">Rectification</option><option value="withdrawal">Retrait</option><option value="destruction">Destruction</option><option value="structured_export">Export structuré</option></select></label>
      <label>Échéance interne<input name="dueAt" type="date" /></label><label className="form-span">Référence non sensible du demandeur<input required name="requesterReference" maxLength={2000} /></label>
      <div className="form-span"><button className="primary-action" type="submit">Créer la demande</button></div>
    </form>
    {requests === null ? null : requests.length === 0 ? <p className="empty-state">Aucune demande enregistrée.</p> : <div>{requests.map((item) => <form className="form-grid" key={item.id} onSubmit={(event) => void update(event, item.id)}><p className="form-span"><strong>{item.requestType}</strong> · {item.requesterReference} · {item.requestedAt.slice(0, 10)}</p><label>État<select name="status" defaultValue={item.status} disabled={["completed", "refused"].includes(item.status)}><option value="received">Reçue</option><option value="identity_pending">Identité à vérifier</option><option value="in_progress">En traitement</option><option value="completed">Terminée</option><option value="refused">Refusée</option></select></label><label className="form-span">Résolution<textarea name="resolutionNote" defaultValue={item.resolutionNote} maxLength={10000} /></label>{["completed", "refused"].includes(item.status) ? null : <div className="form-span"><button className="secondary-action" type="submit">Mettre à jour</button></div>}</form>)}</div>}
    <p role="status">{status}</p>
  </div>;
}

async function fetchPrivacyRequests(signal?: AbortSignal): Promise<PrivacyRequest[]> {
  const response = await fetch("/api/privacy-requests", { signal });
  if (!response.ok) throw new Error("privacy_requests_unavailable");
  const body = await response.json() as { requests: PrivacyRequest[] };
  return body.requests;
}

function dateIso(value: FormDataEntryValue | null) { return typeof value === "string" && value ? `${value}T12:00:00.000Z` : null; }
