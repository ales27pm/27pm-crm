"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { DashboardData, Deal } from "../crm-types";
import { buildTodayDashboard, type TodayFollowUp } from "../today-dashboard";
import { Icon } from "./icons";

type TodayViewProps = {
  data: DashboardData;
  operatorName: string;
  now?: Date;
  onOpenAccounts: (organizationId?: string, intakeId?: string) => void;
  onOpenConversation: (id: string) => void;
  onOpenDeal: (id: string) => void;
  onOpenTasks: () => void;
  onToggleTask: (id: string) => void;
};

export function TodayView({
  data,
  operatorName,
  now,
  onOpenAccounts,
  onOpenConversation,
  onOpenDeal,
  onOpenTasks,
  onToggleTask,
}: TodayViewProps) {
  const priorityTitleRef = useRef<HTMLHeadingElement>(null);
  const [announcement, setAnnouncement] = useState("");
  const [clock, setClock] = useState(() => new Date());
  const referenceTime = now ?? clock;
  useEffect(() => {
    if (now) return;
    const timer = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(timer);
  }, [now]);
  const snapshot = useMemo(
    () => buildTodayDashboard(data, referenceTime),
    [data, referenceTime],
  );
  const firstName = operatorName.trim().split(/\s+/u)[0] || "équipe";

  function completeTask(task: DashboardData["tasks"][number]) {
    setAnnouncement(`Tâche « ${task.title} » marquée terminée.`);
    onToggleTask(task.id);
    window.requestAnimationFrame(() => priorityTitleRef.current?.focus());
  }

  return (
    <section className="today-view" aria-label="Cockpit Aujourd’hui">
      <header className="today-intro">
        <div>
          <span className="today-eyebrow">Priorités opérationnelles</span>
          <h2>Bonjour {firstName}</h2>
          <p>
            {formatLongDate(referenceTime)} · Voici ce qui demande une décision humaine.
            Aucune action n’envoie de message.
          </p>
        </div>
        <button type="button" className="secondary-action" onClick={onOpenTasks}>
          <Icon name="tasks" /> Voir toutes les tâches
        </button>
      </header>

      <dl className="today-summary" aria-label="Résumé du jour">
        <div>
          <dt>À traiter</dt>
          <dd>{snapshot.actionCount}</dd>
          <small>décisions dans la file</small>
        </div>
        <div data-alert={snapshot.overdueTasks.length > 0 || undefined}>
          <dt>En retard</dt>
          <dd>{snapshot.overdueTasks.length}</dd>
          <small>tâches ouvertes</small>
        </div>
        <div>
          <dt>Non lus</dt>
          <dd>{snapshot.unreadConversations.length}</dd>
          <small>conversations entrantes</small>
        </div>
        <div data-alert={snapshot.atRiskDeals.length > 0 || undefined}>
          <dt>Pipeline à risque</dt>
          <dd>{snapshot.atRiskDeals.length}</dd>
          <small>retards ou suivi absent</small>
        </div>
      </dl>

      <div className="today-layout">
        <section className="today-priorities" aria-labelledby="today-priorities-title">
          <header className="today-section-header">
            <div>
              <span>À traiter</span>
              <h2 id="today-priorities-title" ref={priorityTitleRef} tabIndex={-1}>File du jour</h2>
            </div>
            <strong aria-label={`${snapshot.actionCount} décisions`}>
              {snapshot.actionCount}
            </strong>
          </header>
          <p className="sr-only" role="status">{announcement}</p>

          {snapshot.actionCount === 0 ? (
            <div className="today-empty">
              <Icon name="check" />
              <div>
                <h3>Tout est à jour</h3>
                <p>Les nouvelles demandes, les relances et les messages apparaîtront ici.</p>
              </div>
            </div>
          ) : (
            <ol className="today-priority-list">
              {snapshot.pendingIntakes.map((intake) => (
                <li className="today-priority-row" key={`intake-${intake.id}`}>
                  <span className="today-kind" data-kind="intake">Demande</span>
                  <span className="today-priority-copy">
                    <strong>{intake.organizationName}</strong>
                    <small>{intake.contactName} · {intake.createdLabel}</small>
                    <span>{intake.projectType || "Projet à qualifier"}</span>
                  </span>
                  <button
                    type="button"
                    className="today-row-action"
                    onClick={() => onOpenAccounts(undefined, intake.id)}
                  >
                    Qualifier <Icon name="chevron" />
                  </button>
                </li>
              ))}

              {snapshot.overdueTasks.map((task) => (
                <li className="today-priority-row" key={`task-${task.id}`}>
                  <button
                    type="button"
                    className="today-task-complete"
                    aria-label={`Marquer « ${task.title} » terminée`}
                    onClick={() => completeTask(task)}
                  >
                    <Icon name="check" />
                  </button>
                  <span className="today-priority-copy">
                    <strong>{task.title}</strong>
                    <small>{task.organization || "Entreprise à rattacher"} · En retard</small>
                    <time dateTime={task.dueAt ?? undefined}>{task.dueLabel}</time>
                  </span>
                  <button type="button" className="today-row-action" onClick={onOpenTasks}>
                    Voir <Icon name="chevron" />
                  </button>
                </li>
              ))}

              {snapshot.unreadConversations.map((conversation) => (
                <li className="today-priority-row" key={`conversation-${conversation.id}`}>
                  <span className="today-kind" data-kind="message">Non lu</span>
                  <span className="today-priority-copy">
                    <strong>{conversation.subject}</strong>
                    <small>{conversation.contactName} · {conversation.organization}</small>
                    <span>{conversation.preview}</span>
                  </span>
                  <button
                    type="button"
                    className="today-row-action"
                    onClick={() => onOpenConversation(conversation.id)}
                  >
                    Ouvrir <Icon name="chevron" />
                  </button>
                </li>
              ))}

              {snapshot.dueFollowUps.map((followUp) => (
                <TodayFollowUpRow
                  followUp={followUp}
                  key={`${followUp.kind}-${followUp.id}`}
                  onOpenAccounts={onOpenAccounts}
                  onOpenDeal={onOpenDeal}
                />
              ))}

              {snapshot.accountsToPlan.map((account) => (
                <li className="today-priority-row" key={`account-${account.id}`}>
                  <span className="today-kind" data-kind="planning">À planifier</span>
                  <span className="today-priority-copy">
                    <strong>{account.name}</strong>
                    <small>{priorityLabel(account.priority)} · Suivi interne</small>
                    <span>{account.nextStep?.trim() || "Définir la prochaine étape"}</span>
                  </span>
                  <button
                    type="button"
                    className="today-row-action"
                    onClick={() => onOpenAccounts(account.id)}
                  >
                    Planifier <Icon name="chevron" />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <aside className="today-aside" aria-label="Surveillance commerciale">
          <section className="today-watch" aria-labelledby="today-risk-title">
            <header className="today-section-header">
              <div>
                <span>Attention</span>
                <h2 id="today-risk-title">Pipeline à surveiller</h2>
              </div>
              <strong>{snapshot.atRiskDeals.length}</strong>
            </header>
            <div className="today-compact-list">
              {snapshot.atRiskDeals.map((deal) => (
                <button type="button" key={deal.id} onClick={() => onOpenDeal(deal.id)}>
                  <span>
                    <strong>{deal.title}</strong>
                    <small>{deal.organization} · {stageLabel(deal.stage)}</small>
                    <small>{deal.nextAction || "Prochaine action à définir"}</small>
                  </span>
                  <span className="today-risk-reason">{riskReason(deal, referenceTime)}</span>
                  <Icon name="chevron" />
                </button>
              ))}
              {snapshot.atRiskDeals.length === 0 ? (
                <p className="today-compact-empty">Aucune opportunité en retard ou sans plan.</p>
              ) : null}
            </div>
          </section>

          <section className="today-planning" aria-labelledby="today-upcoming-title">
            <header className="today-section-header">
              <div>
                <span>À venir</span>
                <h2 id="today-upcoming-title">Relances planifiées</h2>
              </div>
              <strong>{snapshot.upcomingDeals.length}</strong>
            </header>
            <div className="today-compact-list">
              {snapshot.upcomingDeals.slice(0, 6).map((deal) => (
                <button type="button" key={deal.id} onClick={() => onOpenDeal(deal.id)}>
                  <time dateTime={deal.nextActionDate}>{formatShortDate(deal.nextActionDate)}</time>
                  <span>
                    <strong>{deal.nextAction || "Prochaine action à définir"}</strong>
                    <small>{deal.title} · {deal.organization}</small>
                  </span>
                  <Icon name="chevron" />
                </button>
              ))}
              {snapshot.upcomingDeals.length === 0 ? (
                <p className="today-compact-empty">Aucune relance future planifiée.</p>
              ) : null}
            </div>
          </section>
        </aside>
      </div>
    </section>
  );
}

function TodayFollowUpRow({
  followUp,
  onOpenAccounts,
  onOpenDeal,
}: {
  followUp: TodayFollowUp;
  onOpenAccounts: (organizationId?: string) => void;
  onOpenDeal: (id: string) => void;
}) {
  return (
    <li className="today-priority-row">
      <span className="today-kind" data-kind="follow-up">Relance</span>
      <span className="today-priority-copy">
        <strong>{followUp.title}</strong>
        <small>{followUp.organization} · Échéance atteinte</small>
        <time dateTime={followUp.dueAt}>{formatShortDate(followUp.dueAt)}</time>
      </span>
      <button
        type="button"
        className="today-row-action"
        onClick={() =>
          followUp.kind === "deal"
            ? onOpenDeal(followUp.dealId)
            : onOpenAccounts(followUp.organizationId)
        }
      >
        Ouvrir <Icon name="chevron" />
      </button>
    </li>
  );
}

function riskReason(deal: Deal, now: Date) {
  if (!deal.nextAction.trim()) return "Action à définir";
  if (!deal.nextActionDate) return "Date à planifier";
  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Montreal",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return deal.nextActionDate < today
    ? `En retard · ${formatShortDate(deal.nextActionDate)}`
    : "À surveiller";
}

function stageLabel(stage: Deal["stage"]) {
  return {
    nouveau: "Nouveau",
    qualifie: "Qualifié",
    proposition: "Proposition",
    production: "En production",
    gagne: "Gagné",
  }[stage];
}

function priorityLabel(priority: DashboardData["organizations"][number]["priority"]) {
  return {
    very_high: "Priorité très élevée",
    high: "Priorité élevée",
    normal: "Priorité normale",
    low: "Priorité basse",
  }[priority];
}

function formatShortDate(value: string) {
  const date = new Date(`${value.slice(0, 10)}T12:00:00`);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "America/Montreal",
    day: "numeric",
    month: "short",
  }).format(date);
}

function formatLongDate(value: Date) {
  return new Intl.DateTimeFormat("fr-CA", {
    timeZone: "America/Montreal",
    weekday: "long",
    day: "numeric",
    month: "long",
  }).format(value);
}
