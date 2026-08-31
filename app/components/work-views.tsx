"use client";

import type { ActivityEntry, Contact, CrmTask, Deal, Mailbox, TransportState } from "../crm-types";
import { Icon } from "./icons";
import { ComplianceSettings } from "./compliance-settings";
import { PrivacyRequestsPanel } from "./privacy-requests-panel";

export function ProjectsView({ deals }: { deals: Deal[] }) {
  return (
    <section className="list-view" aria-label="Projets">
      <header className="list-header projects-columns">
        <span>Projet</span><span>Client</span><span>Type</span><span>Étape</span><span>Prochaine action</span>
      </header>
      {deals.map((deal) => (
        <article className="list-row projects-columns" key={deal.id}>
          <span className="list-primary"><strong>{deal.title}</strong><small>{deal.source}</small></span>
          <span>{deal.contactName}</span>
          <span>{deal.projectType}</span>
          <span>{stageLabel(deal.stage)}</span>
          <span>{deal.nextAction}</span>
        </article>
      ))}
    </section>
  );
}

export function TasksView({
  tasks,
  onToggle,
}: {
  tasks: CrmTask[];
  onToggle: (id: string) => void;
}) {
  const openTasks = tasks.filter((task) => !task.completed);
  const overdueCount = openTasks.filter((task) => task.overdue).length;
  return (
    <section className="task-view" aria-label="Tâches">
      <header className="task-summary">
        <div><strong>{openTasks.length}</strong><span>actions ouvertes</span></div>
        <div data-alert={overdueCount > 0 || undefined}><strong>{overdueCount}</strong><span>en retard</span></div>
      </header>
      {tasks.map((task) => (
        <label
          className="task-row"
          data-overdue={task.overdue || undefined}
          key={task.id}
        >
          <input type="checkbox" checked={task.completed} onChange={() => onToggle(task.id)} />
          <span className="task-check"><Icon name="check" /></span>
          <span><strong>{task.title}</strong><small>{task.dueLabel}</small></span>
        </label>
      ))}
      {tasks.length === 0 ? (
        <p className="empty-state">Aucune action. Ajoutez une relance depuis un dossier du pipeline.</p>
      ) : null}
    </section>
  );
}

export function SettingsView({
  mailboxes,
  transportState,
  operatorEmail,
  activities,
  contacts,
}: {
  mailboxes: Mailbox[];
  transportState: TransportState;
  operatorEmail: string;
  activities: ActivityEntry[];
  contacts: Contact[];
}) {
  return (
    <section className="settings-view" aria-label="Paramètres">
      <div className="settings-section">
        <h2>Identités courriel</h2>
        {mailboxes.map((mailbox) => (
          <article className="mailbox-setting" key={mailbox.address}>
            <Icon name="mail" />
            <div><strong>{mailbox.address}</strong><p>{mailbox.label}</p></div>
            <span>{mailbox.kind === "sales" ? "Ventes" : "Administration"}</span>
          </article>
        ))}
      </div>
      <div className="settings-section">
        <h2>Journal d’activité immuable</h2>
        {activities.length === 0 ? <p className="empty-state">Aucune activité enregistrée.</p> : <ol className="interaction-history">{activities.map((activity) => <li key={activity.id}><strong>{activity.action}</strong><time dateTime={activity.createdAt}>{activity.createdLabel}</time><p>{activity.actorEmail} · {activity.entityType} · {activity.entityId}</p></li>)}</ol>}
      </div>
      <ComplianceSettings />
      <PrivacyRequestsPanel contacts={contacts} />
      <div className="settings-section">
        <h2>Connexion</h2>
        <dl className="settings-facts">
          <div><dt>Opérateur</dt><dd>{operatorEmail}</dd></div>
          <div><dt>Transport</dt><dd>{transportStateLabel(transportState)}</dd></div>
          <div><dt>Stockage</dt><dd>D1 + R2 privés</dd></div>
          <div><dt>Domaine</dt><dd>27pm.org</dd></div>
        </dl>
      </div>
      <p className="settings-warning">
        Les pièces jointes reçues restent bloquées tant qu’une analyse antimalware n’est pas configurée.
      </p>
    </section>
  );
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

function transportStateLabel(state: TransportState) {
  return {
    operational: "Mailgun opérationnel",
    configuration: "Mailgun à connecter",
    degraded: "Mailgun à vérifier",
  }[state];
}
