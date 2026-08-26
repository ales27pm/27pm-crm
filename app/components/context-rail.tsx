"use client";

import { useEffect, useRef } from "react";
import type { Contact, Deal, PipelineStage } from "../crm-types";
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
  onOpenConversation,
}: ContextRailProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);

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

  if (!contact) return null;

  const initials = contact.name
    .split(/\s+/)
    .map((part) => part[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  return (
    <aside
      id={id}
      className="context-rail"
      data-open={open || undefined}
      data-mobile-sheet={mobileSheet || undefined}
      aria-label={`Contexte de ${contact.name}`}
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
          <h3>{contact.name}</h3>
          <p>{contact.organization}</p>
        </div>
      </header>

      <dl className="context-list">
        <div>
          <dt><Icon name="contacts" /> Statut</dt>
          <dd>{contact.status}</dd>
        </div>
        <div>
          <dt><Icon name="globe" /> Source</dt>
          <dd>{contact.source}</dd>
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
            <span><Icon name="note" /> Notes</span>
            <textarea
              key={`${deal.id}:${deal.note}`}
              aria-label="Notes du dossier"
              defaultValue={deal.note}
              onBlur={(event) => {
                if (event.target.value !== deal.note) {
                  onDealChange({ note: event.target.value });
                }
              }}
              placeholder="Ajouter une note…"
              rows={4}
            />
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
