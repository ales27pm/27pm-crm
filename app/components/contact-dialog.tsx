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
  const locked = Boolean(contact?.doNotContact || contact?.unsubscribed);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      organizationId: account!.id, name: form.get("name"), email: form.get("email"),
      phone: form.get("phone"), role: form.get("role"), sourceLabel: form.get("sourceLabel"),
      sourceUrl: form.get("sourceUrl"), sourceDate: form.get("sourceDate"),
      provenanceType: form.get("provenanceType"), evidenceRef: form.get("evidenceRef"),
      lawfulBasis: form.get("lawfulBasis"), basisEvidenceRef: form.get("basisEvidenceRef"),
      basisExpiresAt: dateIso(form.get("basisExpiresAt")),
      publicationByRecipient: form.get("publicationByRecipient") === "on",
      publicationNoRestriction: form.get("publicationNoRestriction") === "on",
      publicationRoleRelevance: form.get("publicationRoleRelevance"),
      directDisclosureNoRestriction: form.get("directDisclosureNoRestriction") === "on",
      b2bRelationshipEvidence: form.get("b2bRelationshipEvidence"),
      b2bMessageRelevance: form.get("b2bMessageRelevance"),
      roleRelevance: form.get("roleRelevance"), roleRelevanceDetail: form.get("roleRelevanceDetail"),
      personalDataCategory: form.get("personalDataCategory"), qualificationMode: form.get("qualificationMode"),
      dnclStatus: form.get("dnclStatus"), emailStatus: form.get("emailStatus"),
      dnclCheckedAt: dateIso(form.get("dnclCheckedAt")), dnclEvidenceRef: form.get("dnclEvidenceRef"),
      phoneEvidenceRef: form.get("phoneEvidenceRef"), recipientTimezone: form.get("recipientTimezone"),
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
    <p className="form-span settings-warning">Saisissez uniquement des coordonnées professionnelles nécessaires. N’inscrivez aucune donnée sensible, personnelle non pertinente ou commentaire subjectif.</p>
    <label>Nom validé<input ref={firstField} required name="name" maxLength={200} defaultValue={contact?.name ?? ""} /></label><label>Courriel validé<input required name="email" type="email" defaultValue={contact?.email ?? ""} readOnly={contact?.doNotContact || contact?.unsubscribed} /></label><label>Téléphone (facultatif)<input name="phone" type="tel" defaultValue={contact?.phone ?? ""} readOnly={contact?.doNotCall} /></label><label>Rôle professionnel<input required name="role" defaultValue={contact?.role ?? ""} /></label>
    <label>Catégorie de renseignement<select required name="personalDataCategory" defaultValue={contact?.personalDataCategory ?? "work_contact"}><option value="work_contact">Coordonnée professionnelle</option><option value="other_personal">Autre renseignement personnel — contact bloqué</option></select></label><label>Qualification<select required name="qualificationMode" defaultValue={contact?.qualificationMode ?? "manual"}><option value="manual">Manuelle</option><option value="assisted">Assistée, décision humaine</option><option value="fully_automated">Entièrement automatisée — bloquée par défaut</option></select></label>
    <label>Source<input required name="sourceLabel" defaultValue={contact?.source ?? ""} /></label><label>URL de source<input required name="sourceUrl" type="url" defaultValue={contact?.sourceUrl ?? ""} /></label><label>Date de capture<input required name="sourceDate" type="date" defaultValue={contact?.sourceDate ?? ""} /></label><label>Référence de preuve<input required name="evidenceRef" defaultValue={contact?.evidenceRef ?? ""} placeholder="Capture, dossier ou référence vérifiable" /></label>
    <label>Type de provenance<select required name="provenanceType" defaultValue={contact?.provenanceType ?? "unknown"}><option value="unknown">Inconnue — bloquée</option><option value="first_party_inbound">Demande entrante directe</option><option value="recipient_published">Publiée par le destinataire</option><option value="authorized_publication">Publication autorisée</option><option value="direct_disclosure">Divulgation directe</option><option value="existing_relationship">Relation existante</option><option value="third_party">Liste ou tiers — insuffisant seul</option></select></label><label>Prochaine relance<input name="nextFollowUpAt" type="date" defaultValue={contact?.nextFollowUpAt?.slice(0, 10) ?? ""} /></label>
    <label>Fondement LCAP<select required name="lawfulBasis" defaultValue={contact?.lawfulBasis ?? "none"}><option value="none">Aucun — tout courriel bloqué</option><option value="explicit_consent">Consentement exprès</option><option value="existing_business_relationship">Relation d’affaires existante</option><option value="conspicuous_publication">Publication bien en vue</option><option value="direct_disclosure">Divulgation directe</option><option value="b2b_exemption">Exemption interentreprises prouvée</option><option value="requested_response">Réponse demandée</option></select></label><label>Preuve du fondement<input name="basisEvidenceRef" defaultValue={contact?.basisEvidenceRef ?? ""} /></label><label>Échéance calculée<input name="basisExpiresAt" type="date" defaultValue={contact?.basisExpiresAt?.slice(0, 10) ?? ""} /></label>
    {contact?.basisVerifiedBy ? <p className="form-span settings-warning">Dernière vérification du fondement : {contact.basisVerifiedBy}, {contact.basisVerifiedAt?.slice(0, 10) ?? "date inconnue"}.</p> : null}
    <label>Pertinence du rôle<select required name="roleRelevance" defaultValue={contact?.roleRelevance ?? "not_relevant"}><option value="relevant">Pertinent, preuve ci-dessous</option><option value="not_relevant">Non pertinent — bloqué</option></select></label><label className="form-span">Lien précis avec les fonctions<textarea required name="roleRelevanceDetail" maxLength={2000} defaultValue={contact?.roleRelevanceDetail ?? ""} /></label>
    <label className="check-label"><input name="publicationByRecipient" type="checkbox" defaultChecked={contact?.publicationByRecipient} /> Publiée par le destinataire ou avec autorisation</label><label className="check-label"><input name="publicationNoRestriction" type="checkbox" defaultChecked={contact?.publicationNoRestriction} /> Aucune mention de refus</label><label>Justification publication/rôle<input name="publicationRoleRelevance" defaultValue={contact?.publicationRoleRelevance ?? ""} /></label><label className="check-label"><input name="directDisclosureNoRestriction" type="checkbox" defaultChecked={contact?.directDisclosureNoRestriction} /> Divulgation directe sans restriction</label>
    <label>Preuve relation organisations<input name="b2bRelationshipEvidence" defaultValue={contact?.b2bRelationshipEvidence ?? ""} /></label><label>Pertinence du message B2B<input name="b2bMessageRelevance" defaultValue={contact?.b2bMessageRelevance ?? ""} /></label>
    <label>Statut courriel<select required name="emailStatus" defaultValue={contact?.emailStatus ?? "unknown"} disabled={contact?.unsubscribed}><option value="unknown">Inconnu — bloqué</option><option value="valid">Valide</option><option value="bounced">Rebond</option><option value="invalid">Invalide</option><option value="unsubscribed">Désabonné</option></select>{contact?.unsubscribed ? <input type="hidden" name="emailStatus" value="unsubscribed" /> : null}</label><label>Contrôle LNNTE<select required name="dnclStatus" defaultValue={contact?.dnclStatus ?? "not_checked"}><option value="not_checked">Non contrôlé</option><option value="not_listed">Non inscrit</option><option value="listed">Inscrit</option><option value="not_applicable">Non applicable — appel bloqué</option></select></label>
    <label>Preuve provenance téléphone<input name="phoneEvidenceRef" defaultValue={contact?.phoneEvidenceRef ?? ""} /></label><label>Fuseau du destinataire<input name="recipientTimezone" defaultValue={contact?.recipientTimezone ?? ""} placeholder="America/Toronto" /></label><label>Date contrôle LNNTE<input name="dnclCheckedAt" type="date" defaultValue={contact?.dnclCheckedAt?.slice(0, 10) ?? ""} /></label><label>Preuve contrôle LNNTE<input name="dnclEvidenceRef" defaultValue={contact?.dnclEvidenceRef ?? ""} /></label>
    <label className="check-label"><input name="doNotCall" type="checkbox" defaultChecked={contact?.doNotCall} disabled={contact?.doNotCall} /> Ne pas appeler (irréversible)</label><label className="check-label"><input name="unsubscribed" type="checkbox" defaultChecked={contact?.unsubscribed} disabled={contact?.unsubscribed} /> Désabonné (irréversible)</label><label className="check-label"><input name="doNotContact" type="checkbox" defaultChecked={contact?.doNotContact} disabled={contact?.doNotContact} /> Ne pas contacter (irréversible)</label><label className="check-label form-span"><input required name="validated" type="checkbox" defaultChecked={contact?.validated} /> Je confirme avoir vérifié l’identité, les coordonnées, la source et la pertinence professionnelle.</label>
  </div>{contact?.doNotCall && !locked ? <p className="settings-warning" role="status">Le numéro et l’opposition téléphonique sont verrouillés; les données professionnelles et le canal courriel restent modifiables sous leurs propres règles.</p> : null}{locked ? <p className="form-error" role="status">Ce dossier est verrouillé par une suppression globale ou un désabonnement. Il ne peut pas être réactivé ni modifié.</p> : null}{error ? <p className="form-error" role="alert">Impossible d’enregistrer : {error}</p> : null}<footer>{contact ? <button type="button" className="danger-action" disabled={busy} onClick={() => void remove()}>Supprimer</button> : null}<span className="dialog-spacer" /><button type="button" className="secondary-action" onClick={onClose}>Annuler</button><button className="primary-action" disabled={busy || locked}>{busy ? "Enregistrement…" : "Enregistrer"}</button></footer></form></section></div>;
}

function dateIso(value: FormDataEntryValue | null) {
  return typeof value === "string" && value ? `${value}T12:00:00.000Z` : null;
}
