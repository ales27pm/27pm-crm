"use client";

import { useEffect, useRef, useState } from "react";
import type { Contact, CrmInteraction, Deal, PipelineStage } from "../crm-types";
import { Icon } from "./icons";

type ContextRailProps = {
  id?: string;
  contact: Contact | null;
  deal: Deal | null;
  open: boolean;
  mobileSheet: boolean;
  onClose: () => void;
  onDealChange: (patch: Partial<Deal>) => void;
  onAddTask: () => void;
  onAddInteraction: (
    kind: CrmInteraction["kind"],
    summary: string,
  ) => Promise<boolean>;
  onOpenConversation?: () => void;
};

const stages: Array<{ value: PipelineStage; label: string }> = [
  { value: "nouveau", label: "Nouveau" },
  { value: "qualifie", label: "Qualifié" },
  { value: "proposition", label: "Proposition" },
  { value: "production", label: "En production" },
  { value: "gagne", label: "Gagné" },
];

export function ContextRail({
  id,
  contact,
  deal,
  open,
  mobileSheet,
  onClose,
  onDealChange,
  onAddTask,
  onAddInteraction,
  onOpenConversation,
}: ContextRailProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const [interactionKind, setInteractionKind] = useState<CrmInteraction["kind"]>("call");
  const [interactionSummary, setInteractionSummary] = useState("");
  const [interactionStatus, setInteractionStatus] = useState("");

  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 1040px)").matches) return;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [open]);

  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 1040px)").matches) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, open]);

  if (!contact && !deal) return null;

  const contextName = contact?.name ?? deal?.organization ?? deal?.title ?? "Compte";
  const contextOrganization = contact?.organization ?? deal?.organization ?? "";
  const initials = contextName
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const dealInteractions = deal?.interactions ?? [];

  return (
    <aside
      id={id}
      className="context-rail"
      data-open={open || undefined}
      data-mobile-sheet={mobileSheet || undefined}
      aria-label={`Contexte de ${contextName}`}
    >
      <button
        ref={closeButtonRef}
        className="context-close"
        type="button"
        onClick={onClose}
        aria-label="Fermer le contexte"
      >
        <Icon name="close" />
      </button>
      <header className="contact-heading">
        <span className="avatar">{initials}</span>
        <div>
          <h3>{contextName}</h3>
          <p>{contact ? contextOrganization : "Aucun contact vérifié"}</p>
        </div>
      </header>

      <dl className="context-list">
        <div>
          <dt><Icon name="contacts" /> Statut</dt>
          <dd>{contact?.status ?? "Compte à qualifier"}</dd>
        </div>
        <div>
          <dt><Icon name="globe" /> Source</dt>
          <dd>{contact?.source ?? deal?.source ?? "Source du compte"}</dd>
        </div>
      </dl>

      {onOpenConversation ? (
        <button className="secondary-action context-conversation" type="button" onClick={onOpenConversation}>
          <Icon name="mail" />
          Ouvrir la conversation
        </button>
      ) : null}

      {deal ? (
        <div className="deal-fields">
          <label>
            <span><Icon name="pipeline" /> Étape du pipeline</span>
            <span className="select-control">
              <select
                value={deal.stage}
                onChange={(event) => onDealChange({ stage: event.target.value as PipelineStage })}
              >
                {stages.map((stage) => (
                  <option key={stage.value} value={stage.value}>{stage.label}</option>
                ))}
              </select>
              <Icon name="chevron" />
            </span>
          </label>
          <label>
            <span><Icon name="calendar" /> Prochaine action</span>
            <input
              key={`${deal.id}:${deal.nextAction}`}
              defaultValue={deal.nextAction}
              onBlur={(event) => {
                if (event.target.value !== deal.nextAction) {
                  onDealChange({ nextAction: event.target.value });
                }
              }}
            />
          </label>
          <label>
            <span><Icon name="clock" /> Date de relance</span>
            <input
              type="date"
              value={deal.nextActionDate}
              onChange={(event) => onDealChange({ nextActionDate: event.target.value })}
            />
          </label>
          <label>
            <span><Icon name="folder" /> Type de projet</span>
            <span className="select-control">
              <select
                value={deal.projectType}
                onChange={(event) => onDealChange({ projectType: event.target.value as Deal["projectType"] })}
              >
                <option>Site web</option>
                <option>Application</option>
                <option>Produit numérique</option>
              </select>
              <Icon name="chevron" />
            </span>
          </label>
          <div className="context-action">
            <span><Icon name="tasks" /> Tâches</span>
            <button type="button" onClick={onAddTask}><Icon name="plus" /> Ajouter une tâche</button>
          </div>
          <div className="context-note">
            <span><Icon name="note" /> Notes — aucune donnée sensible ou non nécessaire</span>
            <textarea
              key={`${deal.id}:${deal.note}`}
              aria-label="Notes du dossier"
              defaultValue={deal.note}
              onBlur={(event) => {
                if (event.target.value !== deal.note) {
                  onDealChange({ note: event.target.value });
                }
              }}
              placeholder="Conserver uniquement l’information professionnelle nécessaire…"
              rows={4}
            />
          </div>
          <div className="context-interactions">
            <span><Icon name="clock" /> Historique des interactions</span>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const summary = interactionSummary.trim();
                if (!summary) return;
                setInteractionStatus("Enregistrement…");
                void onAddInteraction(interactionKind, summary).then((created) => {
                  setInteractionStatus(created ? "Interaction enregistrée." : "L’interaction n’a pas été enregistrée.");
                  if (created) setInteractionSummary("");
                });
              }}
            >
              <select
                aria-label="Type d’interaction"
                value={interactionKind}
                onChange={(event) => setInteractionKind(event.target.value as CrmInteraction["kind"])}
              >
                <option value="call">Appel</option>
                <option value="meeting">Rencontre</option>
                <option value="email">Courriel consigné</option>
                <option value="note">Note</option>
                <option value="other">Autre</option>
              </select>
              <textarea
                aria-label="Résumé de l’interaction"
                rows={3}
                value={interactionSummary}
                onChange={(event) => setInteractionSummary(event.target.value)}
                placeholder="Résultat, décision et prochaine étape — aucune donnée sensible…"
              />
              <button type="submit" disabled={!interactionSummary.trim()}>
                <Icon name="plus" /> Consigner
              </button>
              <p role="status">{interactionStatus}</p>
            </form>
            <ol className="interaction-history">
              {dealInteractions.map((interaction) => (
                <li key={interaction.id}>
                  <strong>{interactionLabel(interaction.kind)}</strong>
                  <time dateTime={interaction.occurredAt}>{interaction.occurredLabel}</time>
                  <p>{interaction.summary}</p>
                </li>
              ))}
            </ol>
            {dealInteractions.length === 0 ? (
              <p className="interaction-empty">Aucune interaction consignée.</p>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="operations-context">
          <Icon name="settings" />
          <p>Cette conversation appartient aux opérations et ne crée pas de dossier commercial.</p>
        </div>
      )}
    </aside>
  );
}

function interactionLabel(kind: CrmInteraction["kind"]) {
  return {
    call: "Appel",
    email: "Courriel consigné",
    meeting: "Rencontre",
    note: "Note",
    other: "Autre",
  }[kind];
}
