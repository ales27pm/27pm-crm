"use client";

import { Fragment, useEffect, useRef, useState, type FormEvent } from "react";
import { outreachErrorMessage } from "../../lib/outreach-errors";
import type { Contact, Organization } from "../crm-types";

type Props = {
  account: Organization | null;
  contact: Contact | null;
  open: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
};

export function ContactDialog({ account, contact, open, onClose, onSaved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [lawfulBasis, setLawfulBasis] = useState(contact?.lawfulBasis ?? "none");
  const firstField = useRef<HTMLInputElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
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
    const frame = window.requestAnimationFrame(() => {
      if (firstField.current && !firstField.current.disabled) firstField.current.focus();
      else closeButton.current?.focus();
    });
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
  const locked = Boolean(contact?.doNotContact || contact?.unsubscribed);
  const reasons = contact?.emailBlockReasons?.length
    ? contact.emailBlockReasons
    : contact?.emailReady
      ? []
      : ["contact_compliance_missing"];

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    const form = new FormData(event.currentTarget);
    const payload = {
      organizationId: currentAccount.id,
      name: form.get("name"),
      email: form.get("email"),
      phone: form.get("phone"),
      role: form.get("role"),
      sourceLabel: form.get("sourceLabel"),
      sourceUrl: form.get("sourceUrl"),
      sourceDate: form.get("sourceDate"),
      provenanceType: form.get("provenanceType"),
      evidenceRef: form.get("evidenceRef"),
      lawfulBasis: form.get("lawfulBasis"),
      basisEvidenceRef: form.get("basisEvidenceRef"),
      basisExpiresAt: dateIso(form.get("basisExpiresAt")),
      publicationByRecipient: form.get("publicationByRecipient") === "on",
      publicationNoRestriction: form.get("publicationNoRestriction") === "on",
      publicationRoleRelevance: form.get("publicationRoleRelevance"),
      directDisclosureNoRestriction: form.get("directDisclosureNoRestriction") === "on",
      b2bRelationshipEvidence: form.get("b2bRelationshipEvidence"),
      b2bMessageRelevance: form.get("b2bMessageRelevance"),
      roleRelevance: form.get("roleRelevance"),
      roleRelevanceDetail: form.get("roleRelevanceDetail"),
      personalDataCategory: form.get("personalDataCategory"),
      qualificationMode: form.get("qualificationMode"),
      dnclStatus: form.get("dnclStatus"),
      emailStatus: form.get("emailStatus"),
      dnclCheckedAt: dateIso(form.get("dnclCheckedAt")),
      dnclEvidenceRef: form.get("dnclEvidenceRef"),
      phoneEvidenceRef: form.get("phoneEvidenceRef"),
      recipientTimezone: form.get("recipientTimezone"),
      doNotCall: form.get("doNotCall") === "on",
      doNotContact: form.get("doNotContact") === "on",
      unsubscribed: form.get("unsubscribed") === "on",
      validated: form.get("validated") === "on",
      nextFollowUpAt: dateIso(form.get("nextFollowUpAt")),
    };
    try {
      const response = await fetch(contact ? `/api/contacts/${encodeURIComponent(contact.id)}` : "/api/contacts", {
        method: contact ? "PATCH" : "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json().catch(() => ({})) as { error?: string; detail?: string };
      if (!response.ok) throw new Error(body.detail || body.error || "contact_update_failed");
      try {
        await onSaved();
      } finally {
        onClose();
      }
    } catch (cause) {
      setError(outreachErrorMessage(cause instanceof Error ? cause.message : "contact_update_failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function remove() {
    if (!contact || !window.confirm("Supprimer ce contact et bloquer définitivement toute action de contact?")) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/contacts/${encodeURIComponent(contact.id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error("contact_delete_failed");
      try {
        await onSaved();
      } finally {
        onClose();
      }
    } catch (cause) {
      setError(outreachErrorMessage(cause instanceof Error ? cause.message : "contact_delete_failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="dialog-backdrop" role="presentation">
      <section ref={dialogRef} className="crm-dialog account-dialog contact-dialog" role="dialog" aria-modal="true" aria-labelledby="contact-dialog-title">
        <header>
          <div><p className="eyebrow">{currentAccount.name}</p><h2 id="contact-dialog-title">{contact ? "Réviser le dossier contact" : "Ajouter un contact vérifié"}</h2></div>
          <button ref={closeButton} type="button" className="icon-button" aria-label="Fermer" disabled={busy} onClick={onClose}>×</button>
        </header>
        <form onSubmit={submit}>
          <fieldset className="form-grid" disabled={busy || locked}>
            <div className="contact-dialog-readiness form-span" data-ready={contact?.emailReady || undefined} role="status">
              <strong>{contact?.emailReady ? "Dossier LCAP documenté" : "Dossier LCAP à compléter"}</strong>
              {contact?.emailReady ? (
                <p>Le serveur autorise la préparation seulement. Il revérifiera toutes les preuves avant une action; ce formulaire n’envoie rien.</p>
              ) : (
                <ul>{reasons.map((reason) => <li key={reason}>{outreachErrorMessage(reason)}</li>)}</ul>
              )}
              {contact?.emailEvaluatedAt ? <small>Dernière décision serveur : {formatDateTime(contact.emailEvaluatedAt)}.</small> : null}
            </div>

            <p className="form-span settings-warning">Saisissez uniquement des coordonnées professionnelles nécessaires. Enregistrer documente le dossier; cela n’autorise jamais un envoi.</p>

            <fieldset className="contact-form-section form-span">
              <legend>Identité et canal</legend>
              <div className="contact-form-section-grid">
                <label>Nom validé<input ref={firstField} required name="name" maxLength={200} defaultValue={contact?.name ?? ""} /></label>
                <label>Courriel professionnel<input required name="email" type="email" defaultValue={contact?.email ?? ""} readOnly={contact?.doNotContact || contact?.unsubscribed} /></label>
                <label>Téléphone (facultatif)<input name="phone" type="tel" defaultValue={contact?.phone ?? ""} readOnly={contact?.doNotCall} /></label>
                <label>Rôle professionnel<input required name="role" defaultValue={contact?.role ?? ""} /></label>
                <label>Catégorie de renseignement<select required name="personalDataCategory" defaultValue={contact?.personalDataCategory ?? "work_contact"}><option value="work_contact">Coordonnée professionnelle</option><option value="other_personal">Autre renseignement personnel — contact bloqué</option></select></label>
                <label>Qualification<select required name="qualificationMode" defaultValue={contact?.qualificationMode ?? "manual"}><option value="manual">Manuelle</option><option value="assisted">Assistée, décision humaine</option><option value="fully_automated">Entièrement automatisée — bloquée par défaut</option></select></label>
                <label>Statut courriel<select required name="emailStatus" defaultValue={contact?.emailStatus ?? "unknown"} disabled={contact?.unsubscribed}><option value="unknown">Inconnu — bloqué</option><option value="valid">Valide</option><option value="bounced">Rebond</option><option value="invalid">Invalide</option><option value="unsubscribed">Désabonné</option></select>{contact?.unsubscribed ? <input type="hidden" name="emailStatus" value="unsubscribed" /> : null}</label>
                <label>Prochaine relance<input name="nextFollowUpAt" type="date" defaultValue={contact?.nextFollowUpAt?.slice(0, 10) ?? ""} /></label>
              </div>
            </fieldset>

            <fieldset className="contact-form-section form-span">
              <legend>Source et preuve</legend>
              <div className="contact-form-section-grid">
                <label>Source<input required name="sourceLabel" defaultValue={contact?.source ?? ""} /></label>
                <label>URL de source<input required name="sourceUrl" type="url" defaultValue={contact?.sourceUrl ?? ""} /></label>
                <label>Date de capture<input required name="sourceDate" type="date" defaultValue={contact?.sourceDate ?? ""} /></label>
                <label>Référence de preuve<input required name="evidenceRef" defaultValue={contact?.evidenceRef ?? ""} placeholder="Capture, dossier ou référence vérifiable" /></label>
                <label>Type de provenance<select required name="provenanceType" defaultValue={contact?.provenanceType ?? "unknown"}><option value="unknown">Inconnue — bloquée</option><option value="first_party_inbound">Demande entrante directe</option><option value="recipient_published">Publiée par le destinataire</option><option value="authorized_publication">Publication autorisée</option><option value="direct_disclosure">Divulgation directe</option><option value="existing_relationship">Relation existante</option><option value="third_party">Liste ou tiers — insuffisant seul</option></select></label>
              </div>
            </fieldset>

            <fieldset className="contact-form-section form-span">
              <legend>Fondement déclaré</legend>
              <p className="contact-form-guidance">Le CRM vérifie les preuves; la pertinence juridique reste une décision humaine. Une adresse trouvée en ligne n’est jamais admissible par elle-même.</p>
              <div className="contact-form-section-grid">
                <label>Fondement LCAP<select required name="lawfulBasis" value={lawfulBasis} onChange={(event) => setLawfulBasis(event.target.value)}><option value="none">Aucun — tout courriel bloqué</option><option value="explicit_consent">Consentement exprès</option><option value="existing_business_relationship">Relation d’affaires existante</option><option value="conspicuous_publication">Publication bien en vue</option><option value="direct_disclosure">Divulgation directe</option><option value="b2b_exemption">Exemption interentreprises prouvée</option><option value="requested_response">Demande de renseignements — fenêtre limitée</option></select></label>
                <label>Preuve du fondement<input name="basisEvidenceRef" required={lawfulBasis !== "none"} defaultValue={contact?.basisEvidenceRef ?? ""} /></label>
                <label>Date d’expiration documentée<input name="basisExpiresAt" type="date" required={lawfulBasis === "existing_business_relationship" || lawfulBasis === "requested_response"} defaultValue={contact?.basisExpiresAt?.slice(0, 10) ?? ""} /></label>
                <label>Pertinence du rôle<select required name="roleRelevance" defaultValue={contact?.roleRelevance ?? "not_relevant"}><option value="relevant">Pertinent, preuve ci-dessous</option><option value="not_relevant">Non pertinent — bloqué</option></select></label>
                <label className="form-span">Lien précis avec les fonctions<textarea required name="roleRelevanceDetail" maxLength={2000} defaultValue={contact?.roleRelevanceDetail ?? ""} /></label>
                <Fragment key={lawfulBasis}>
                  {lawfulBasis === "conspicuous_publication" ? (
                    <>
                      <label className="check-label"><input name="publicationByRecipient" type="checkbox" defaultChecked={contact?.publicationByRecipient} /> Publication attribuable au destinataire ou autorisée</label>
                      <label className="check-label"><input name="publicationNoRestriction" type="checkbox" defaultChecked={contact?.publicationNoRestriction} /> Aucune mention refusant les messages commerciaux</label>
                      <label className="form-span">Lien entre le rôle et l’approche<input name="publicationRoleRelevance" required defaultValue={contact?.publicationRoleRelevance ?? ""} /></label>
                    </>
                  ) : null}
                  {lawfulBasis === "direct_disclosure" ? (
                    <>
                      <label className="check-label"><input name="directDisclosureNoRestriction" type="checkbox" defaultChecked={contact?.directDisclosureNoRestriction} /> Divulgation directe sans restriction</label>
                      <label>Lien entre le rôle et l’approche<input name="publicationRoleRelevance" required defaultValue={contact?.publicationRoleRelevance ?? ""} /></label>
                    </>
                  ) : null}
                  {lawfulBasis === "b2b_exemption" ? (
                    <>
                      <label>Preuve de relation entre organisations<input name="b2bRelationshipEvidence" required defaultValue={contact?.b2bRelationshipEvidence ?? ""} /></label>
                      <label>Pertinence du message pour les activités<input name="b2bMessageRelevance" required defaultValue={contact?.b2bMessageRelevance ?? ""} /></label>
                    </>
                  ) : null}
                </Fragment>
              </div>
              {contact?.basisVerifiedBy ? <p className="contact-form-guidance">Dernière vérification du fondement : {contact.basisVerifiedBy}, {contact.basisVerifiedAt?.slice(0, 10) ?? "date inconnue"}.</p> : null}
            </fieldset>

            <fieldset className="contact-form-section form-span">
              <legend>Téléphone et oppositions</legend>
              <div className="contact-form-section-grid">
                <label>Contrôle LNNTE<select required name="dnclStatus" defaultValue={contact?.dnclStatus ?? "not_checked"}><option value="not_checked">Non contrôlé</option><option value="not_listed">Non inscrit</option><option value="listed">Inscrit</option><option value="not_applicable">Non applicable — appel bloqué</option></select></label>
                <label>Preuve provenance téléphone<input name="phoneEvidenceRef" defaultValue={contact?.phoneEvidenceRef ?? ""} /></label>
                <label>Fuseau du destinataire<input name="recipientTimezone" defaultValue={contact?.recipientTimezone ?? ""} placeholder="America/Toronto" /></label>
                <label>Date contrôle LNNTE<input name="dnclCheckedAt" type="date" defaultValue={contact?.dnclCheckedAt?.slice(0, 10) ?? ""} /></label>
                <label>Preuve contrôle LNNTE<input name="dnclEvidenceRef" defaultValue={contact?.dnclEvidenceRef ?? ""} /></label>
                <label className="check-label"><input name="doNotCall" type="checkbox" defaultChecked={contact?.doNotCall} disabled={contact?.doNotCall} /> Ne pas appeler (irréversible)</label>
                <label className="check-label"><input name="unsubscribed" type="checkbox" defaultChecked={contact?.unsubscribed} disabled={contact?.unsubscribed} /> Désabonné (irréversible)</label>
                <label className="check-label"><input name="doNotContact" type="checkbox" defaultChecked={contact?.doNotContact} disabled={contact?.doNotContact} /> Ne pas contacter (irréversible)</label>
              </div>
            </fieldset>

            <label className="check-label form-span"><input required name="validated" type="checkbox" /> Je confirme, pour cette sauvegarde, avoir vérifié l’identité, les coordonnées, la source et la pertinence professionnelle. Cette confirmation n’autorise aucun envoi.</label>
          </fieldset>
          {contact?.doNotCall && !locked ? <p className="settings-warning" role="status">Le numéro et l’opposition téléphonique sont verrouillés; le canal courriel conserve ses propres règles.</p> : null}
          {locked ? <p className="form-error" role="status">Ce dossier est verrouillé par une suppression globale ou un désabonnement. Il ne peut pas être réactivé ni modifié.</p> : null}
          {error ? <p className="form-error" role="alert">Impossible d’enregistrer : {error}</p> : null}
          <footer>
            {contact ? <button type="button" className="danger-action" disabled={busy} onClick={() => void remove()}>Supprimer</button> : null}
            <span className="dialog-spacer" />
            <button type="button" className="secondary-action" disabled={busy} onClick={onClose}>Annuler</button>
            <button className="primary-action" disabled={busy || locked}>{busy ? "Enregistrement…" : "Enregistrer sans autoriser d’envoi"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function dateIso(value: FormDataEntryValue | null) {
  return typeof value === "string" && value ? `${value}T12:00:00.000Z` : null;
}

function formatDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return value;
  return new Intl.DateTimeFormat("fr-CA", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "America/Toronto",
  }).format(date);
}
