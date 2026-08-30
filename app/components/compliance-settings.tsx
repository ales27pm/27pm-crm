"use client";

import { useEffect, useState, type FormEvent } from "react";

type Configuration = Record<string, string | number | boolean | null>;

export function ComplianceSettings() {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [status, setStatus] = useState("Chargement des contrôles…");

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/compliance", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error();
        const body = await response.json() as { configuration: Configuration };
        setConfiguration(body.configuration); setStatus("");
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setStatus("Configuration de conformité indisponible.");
      });
    return () => controller.abort();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setStatus("Enregistrement…");
    const form = new FormData(event.currentTarget);
    const booleans = [
      "dnclRegistrationConfirmed", "businessNumberConfirmed", "automatedDialerDisabled",
      "prerecordedCallsDisabled", "sequentialDialingDisabled", "crossBorderEfvpConfirmed",
      "crossBorderContractConfirmed", "crossBorderLegalValidationConfirmed",
      "automatedQualificationLegalValidationConfirmed",
    ];
    const payload: Record<string, string | boolean | null> = {};
    for (const [key, value] of form.entries()) payload[key] = typeof value === "string" && value ? value : null;
    for (const key of booleans) payload[key] = form.get(key) === "on";
    try {
      const response = await fetch("/api/compliance", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await response.json() as { configuration?: Configuration; error?: string };
      if (!response.ok || !body.configuration) throw new Error(body.error ?? "update_failed");
      setConfiguration(body.configuration); setStatus("Contrôles enregistrés et journalisés.");
    } catch (error) { setStatus(`Échec : ${error instanceof Error ? error.message : "update_failed"}`); }
  }

  if (!configuration) return <section className="settings-section"><h2>Conformité des approches</h2><p role="status">{status}</p></section>;
  return <section className="settings-section"><h2>Conformité des approches</h2><p className="settings-warning">Tout contrôle incomplet bloque l’action. Une case ne remplace pas un avis juridique : inscrivez une référence de preuve vérifiable.</p><form className="form-grid" onSubmit={submit}>
    <label>Nom de l’expéditeur<input name="senderName" defaultValue={String(configuration.senderName ?? "")} /></label><label>Organisation<input name="organizationName" defaultValue={String(configuration.organizationName ?? "")} /></label><label className="form-span">Adresse postale<input name="postalAddress" defaultValue={String(configuration.postalAddress ?? "")} /></label><label className="form-span">Moyen de contact<input name="contactMethod" defaultValue={String(configuration.contactMethod ?? "")} /></label>
    <label>Identité valide jusqu’au<input type="date" name="identityValidUntil" defaultValue={dateValue(configuration.identityValidUntil)} /></label><label>Exclusion vérifiée le<input type="date" name="unsubscribeMechanismValidatedAt" defaultValue={dateValue(configuration.unsubscribeMechanismValidatedAt)} /></label><label>Exclusion valide jusqu’au<input type="date" name="unsubscribeMechanismValidUntil" defaultValue={dateValue(configuration.unsubscribeMechanismValidUntil)} /></label>
    <label className="check-label"><input type="checkbox" name="dnclRegistrationConfirmed" defaultChecked={Boolean(configuration.dnclRegistrationConfirmed)} /> Inscription LNNTE de 27PM confirmée</label><label>Date vérification LNNTE<input type="date" name="dnclRegistrationVerifiedAt" defaultValue={dateValue(configuration.dnclRegistrationVerifiedAt)} /></label><label>Preuve inscription LNNTE<input name="dnclRegistrationEvidenceRef" defaultValue={String(configuration.dnclRegistrationEvidenceRef ?? "")} /></label>
    <label className="check-label"><input type="checkbox" name="businessNumberConfirmed" defaultChecked={Boolean(configuration.businessNumberConfirmed)} /> Numéro d’affaires confirmé</label><label>Numéro d’affaires<input name="businessNumber" defaultValue={String(configuration.businessNumber ?? "")} /></label><label>Preuve numéro d’affaires<input name="businessNumberEvidenceRef" defaultValue={String(configuration.businessNumberEvidenceRef ?? "")} /></label><label>Identité d’appel<input name="callerIdentity" defaultValue={String(configuration.callerIdentity ?? "")} /></label><label>Numéro affiché<input name="callerDisplayNumber" defaultValue={String(configuration.callerDisplayNumber ?? "")} /></label>
    <label className="check-label"><input type="checkbox" name="automatedDialerDisabled" defaultChecked={Boolean(configuration.automatedDialerDisabled)} /> Aucun composeur automatique</label><label className="check-label"><input type="checkbox" name="prerecordedCallsDisabled" defaultChecked={Boolean(configuration.prerecordedCallsDisabled)} /> Aucun appel préenregistré</label><label className="check-label"><input type="checkbox" name="sequentialDialingDisabled" defaultChecked={Boolean(configuration.sequentialDialingDisabled)} /> Aucune numérotation séquentielle</label>
    <label className="check-label"><input type="checkbox" name="crossBorderEfvpConfirmed" defaultChecked={Boolean(configuration.crossBorderEfvpConfirmed)} /> EFVP hors Québec confirmée</label><label className="check-label"><input type="checkbox" name="crossBorderContractConfirmed" defaultChecked={Boolean(configuration.crossBorderContractConfirmed)} /> Contrat fournisseur confirmé</label><label className="check-label"><input type="checkbox" name="crossBorderLegalValidationConfirmed" defaultChecked={Boolean(configuration.crossBorderLegalValidationConfirmed)} /> Validation juridique transfert confirmée</label><label className="form-span">Preuve EFVP/contrat/validation<input name="crossBorderEvidenceRef" defaultValue={String(configuration.crossBorderEvidenceRef ?? "")} /></label>
    <label className="check-label"><input type="checkbox" name="automatedQualificationLegalValidationConfirmed" defaultChecked={Boolean(configuration.automatedQualificationLegalValidationConfirmed)} /> Qualification entièrement automatisée validée juridiquement</label><label className="form-span">Preuve automatisation<input name="automatedQualificationEvidenceRef" defaultValue={String(configuration.automatedQualificationEvidenceRef ?? "")} /></label>
    <div className="form-span"><button className="primary-action" type="submit">Enregistrer les contrôles</button></div><p className="form-span" role="status">{status}</p>
  </form></section>;
}

function dateValue(value: unknown) { return typeof value === "string" ? value.slice(0, 10) : ""; }
