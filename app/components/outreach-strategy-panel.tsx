"use client";

import type { OutreachStep, OutreachStrategy, Organization } from "../crm-types";
import { isGlobalComplianceReason, outreachErrorMessage } from "../../lib/outreach-errors";
import { replaceZonedDate, zonedDateValue } from "../../lib/zoned-date-time";

type Props = {
  account: Organization;
  strategy: OutreachStrategy | null;
  onEdit: () => void;
  onResolveContact?: () => void;
  onOpenComplianceSettings?: () => void;
  onUpdateStep: (
    strategyId: string,
    stepId: string,
    patch: { status?: OutreachStep["status"]; scheduledAt?: string },
  ) => void;
  updatingStepIds?: ReadonlySet<string>;
};

export function OutreachStrategyPanel({
  account,
  strategy,
  onEdit,
  onResolveContact = () => undefined,
  onOpenComplianceSettings = () => undefined,
  onUpdateStep,
  updatingStepIds = new Set<string>(),
}: Props) {
  const strategyFrozen = strategy
    ? ["paused", "completed", "archived"].includes(strategy.status)
    : false;
  const contactBlockers = strategy?.emailBlockReasons.filter((reason) => !isGlobalComplianceReason(reason)) ?? [];
  const globalBlockers = strategy?.emailBlockReasons.filter(isGlobalComplianceReason) ?? [];
  const missingContact = strategy?.emailBlockReasons.includes("strategy_contact_missing") || !strategy?.contactId;
  return (
    <section
      className="account-section outreach-strategy-panel"
      data-outreach-strategy-account-id={account.id}
      aria-labelledby={`outreach-strategy-title-${account.id}`}
      tabIndex={-1}
    >
      <header>
        <div><span>Prospection</span><h3 id={`outreach-strategy-title-${account.id}`}>Stratégie d’approche</h3></div>
        <button type="button" className="secondary-action" onClick={onEdit}>
          {strategy ? "Modifier" : "Préparer"}
        </button>
      </header>
      {!strategy ? (
        <div className="outreach-empty">
          <strong>Aucun plan préparé</strong>
          <p>Définissez la cible, l’angle, la date du premier courriel et les relances avant toute action.</p>
        </div>
      ) : (
        <div className="outreach-plan">
          <div className="outreach-plan-summary">
            <div>
              <span className="outreach-status" data-status={strategy.status}>{strategyStatus(strategy.status)}</span>
              <h4>{strategy.objective}</h4>
              <p>{strategy.openingAngle}</p>
            </div>
            <dl>
              <div><dt>Cible</dt><dd>{strategy.targetName || strategy.targetRole}</dd></div>
              <div><dt>Rôle</dt><dd>{strategy.targetRole}</dd></div>
              <div><dt>Route publique</dt><dd>{strategy.contactEmail ?? "À trouver"}</dd></div>
              <div>
                <dt>Preuve consultée</dt>
                <dd>
                  {strategy.researchSourceUrl ? (
                    <a href={strategy.researchSourceUrl} target="_blank" rel="noreferrer">
                      {strategy.researchSource}
                    </a>
                  ) : strategy.researchSource}
                  {strategy.researchCapturedAt ? ` · ${formatDate(strategy.researchCapturedAt, strategy.recipientTimezone)}` : ""}
                </dd>
              </div>
              <div><dt>Premier courriel proposé</dt><dd>{formatDateTime(strategy.recommendedStartAt, strategy.recipientTimezone)}</dd></div>
            </dl>
          </div>

          <div className="outreach-readiness" data-ready={strategy.emailReady || undefined} role="status">
            <strong>{strategy.emailReady ? "Courriel admissible à la préparation" : "Courriel bloqué"}</strong>
            {strategy.emailReady ? (
              <p>Le dossier est documenté; la conformité sera revérifiée au moment de chaque action.</p>
            ) : (
              <>
                <ul>
                  {strategy.emailBlockReasons.map((reason) => (
                    <li key={reason}>{outreachErrorMessage(reason)}</li>
                  ))}
                </ul>
                <div className="outreach-readiness-actions">
                  {missingContact ? (
                    <button type="button" className="secondary-action" onClick={onEdit}>
                      Choisir un contact
                    </button>
                  ) : contactBlockers.length > 0 ? (
                    <button type="button" className="secondary-action" onClick={onResolveContact}>
                      Réviser ce contact
                    </button>
                  ) : null}
                  {globalBlockers.length > 0 ? (
                    <button type="button" className="secondary-action" onClick={onOpenComplianceSettings}>
                      Ouvrir les paramètres de conformité
                    </button>
                  ) : null}
                </div>
              </>
            )}
          </div>

          <div className="outreach-strategy-copy">
            <div><span>Valeur proposée</span><p>{strategy.valueProposition}</p></div>
            <div><span>Pourquoi maintenant</span><p>{strategy.timingRationale}</p></div>
            <div><span>Recherche contacts</span><p>{strategy.contactResearchNotes || "À compléter"}</p></div>
          </div>

          <ol className="outreach-steps" aria-label={`Séquence planifiée pour ${account.name}`}>
            {strategy.steps.map((step) => (
              <li key={step.id} data-status={step.status}>
                <span className="outreach-step-index">{step.sequenceIndex + 1}</span>
                <div className="outreach-step-copy">
                  <span>{actionLabel(step.actionType)} · {stepStatus(step.status)}</span>
                  <strong>{step.title}</strong>
                  <p>{step.purpose}</p>
                </div>
                <label className="outreach-step-date">
                  <span className="sr-only">Date de {step.title}</span>
                  <input
                    type="date"
                    value={zonedDateValue(step.scheduledAt, strategy.recipientTimezone)}
                    disabled={strategyFrozen || updatingStepIds.has(step.id) || step.status === "done" || step.status === "skipped"}
                    onChange={(event) => {
                      const scheduledAt = replaceZonedDate(
                        step.scheduledAt,
                        event.target.value,
                        strategy.recipientTimezone,
                      );
                      if (scheduledAt) onUpdateStep(strategy.id, step.id, { scheduledAt });
                    }}
                  />
                </label>
                {updatingStepIds.has(step.id) ? (
                  <span className="outreach-step-blocked" role="status">Enregistrement…</span>
                ) : !strategyFrozen && (step.status === "planned" || step.status === "ready") ? (
                  <button
                    type="button"
                    className="secondary-action outreach-step-action"
                    onClick={() => {
                      if (window.confirm(`Marquer « ${step.title} » comme terminée? Cette action verrouille l’historique.`)) {
                        onUpdateStep(strategy.id, step.id, { status: "done" });
                      }
                    }}
                  >
                    Marquer faite
                  </button>
                ) : !strategyFrozen && step.status === "blocked" ? (
                  <button
                    type="button"
                    className="secondary-action outreach-step-action"
                    onClick={missingContact ? onEdit : contactBlockers.length > 0 ? onResolveContact : onOpenComplianceSettings}
                  >
                    Résoudre les contrôles
                  </button>
                ) : strategyFrozen && step.status !== "done" && step.status !== "skipped" ? (
                  <span className="outreach-step-blocked">Plan en {strategy.status === "paused" ? "pause" : "lecture seule"}</span>
                ) : null}
              </li>
            ))}
          </ol>
          <p className="outreach-no-send">
            Ce plan ne déclenche aucun envoi. Les étapes courriel exigent une décision humaine et une nouvelle validation LCAP.
          </p>
        </div>
      )}
    </section>
  );
}

function actionLabel(type: OutreachStep["actionType"]): string {
  return ({ research: "Recherche", review: "Validation", email: "Courriel", call: "Appel", nurture: "Décision" })[type];
}

function stepStatus(status: OutreachStep["status"]): string {
  return ({ planned: "Planifiée", ready: "Prête", blocked: "Bloquée", done: "Terminée", skipped: "Ignorée" })[status];
}

function strategyStatus(status: OutreachStrategy["status"]): string {
  return ({ draft: "Brouillon", ready: "Prête", active: "Active", paused: "En pause", completed: "Terminée", archived: "Archivée" })[status];
}

function formatDateTime(value: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("fr-CA", {
      dateStyle: "long",
      timeStyle: "short",
      timeZone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatDate(value: string, timeZone = "America/Toronto"): string {
  try {
    return new Intl.DateTimeFormat("fr-CA", {
      dateStyle: "long",
      timeZone,
    }).format(new Date(value));
  } catch {
    return value;
  }
}
