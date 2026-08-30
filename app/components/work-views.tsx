"use client";

import { useMemo, useState } from "react";
import type { ActivityEntry, Contact, CrmTask, Deal, IntakeSubmission, Mailbox, Organization, TransportState } from "../crm-types";
import { Icon } from "./icons";
import { ComplianceSettings } from "./compliance-settings";
import { PrivacyRequestsPanel } from "./privacy-requests-panel";

export function AccountsView({ organizations, contacts, intakes, onEdit, onAddContact, onEditContact, onReviewIntake }: { organizations: Organization[]; contacts: Contact[]; intakes: IntakeSubmission[]; onEdit: (account: Organization) => void; onAddContact: (account: Organization) => void; onEditContact: (account: Organization, contact: Contact) => void; onReviewIntake: (id: string, status: "accepted" | "rejected") => void }) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const visible = useMemo(() => organizations.filter((organization) => {
    const matches = organization.name.toLocaleLowerCase("fr-CA").includes(query.trim().toLocaleLowerCase("fr-CA"));
    if (!matches) return false;
    if (filter === "unassigned") return !organization.ownerEmail;
    if (filter === "blocked") return organization.doNotContact;
    if (filter === "high") return organization.priority === "very_high" || organization.priority === "high";
    return true;
  }), [organizations, query, filter]);
  return (
    <section className="accounts-view" aria-label="Comptes et contacts">
      <div className="list-summary">
        <strong>{organizations.length} entreprise{organizations.length === 1 ? "" : "s"}</strong>
        <span>{contacts.length} contact{contacts.length === 1 ? "" : "s"}</span>
      </div>
      <div className="account-filters"><label>Rechercher<input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Entreprise" /></label><label>Filtre<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">Tous</option><option value="high">Priorité haute</option><option value="unassigned">Non assignés</option><option value="blocked">Bloqués</option></select></label></div>
      <div className="account-grid">
        {visible.map((account) => <article className="account-card" key={account.id} data-blocked={account.doNotContact || undefined}>
          <header><div><span className="score-badge">{account.score ?? "—"}</span><div><h3>{account.name}</h3><p>{priorityLabel(account.priority)} · {account.ownerEmail ?? "Non assigné"}</p></div></div><button type="button" className="secondary-action" onClick={() => onEdit(account)}>Modifier</button></header>
          <dl><div><dt>Enveloppe</dt><dd>{budget(account)}</dd></div><div><dt>Source</dt><dd>{account.sourceUrl ? <a href={account.sourceUrl} target="_blank" rel="noreferrer">{account.sourceLabel}</a> : account.sourceLabel}{account.sourceDate ? ` · ${account.sourceDate}` : " · date non fournie"}</dd></div><div><dt>Prochaine étape</dt><dd>{account.nextStep ?? "À définir"}</dd></div><div><dt>Relance</dt><dd>{account.nextFollowUpAt?.slice(0, 10) ?? "À planifier"}</dd></div></dl>
          {account.budgetIsHypothesis ? <p className="hypothesis-note">Hypothèse de prospection — montant non confirmé</p> : null}
          {account.doNotContact ? <p className="compliance-stop">Toute action de contact est bloquée.</p> : null}
          <div className="account-contacts"><strong>{account.contactCount ? "Contacts vérifiés" : "Aucun contact vérifié"}</strong>{contacts.filter((contact) => contact.organizationId === account.id).map((contact) => <button type="button" className="contact-row-button" key={contact.id} onClick={() => onEditContact(account, contact)}><span>{contact.name} · {contact.role}</span><small>{contact.email} · {contact.status}</small></button>)}</div>
          <button type="button" className="secondary-action" disabled={account.doNotContact} onClick={() => onAddContact(account)}>Ajouter un contact vérifié</button>
        </article>)}
      </div>
      {visible.length === 0 ? <p className="empty-state">Aucun compte ne correspond à ces critères.</p> : null}
      <section className="intake-queue"><h2>Demandes publiques en attente <span>{intakes.length}</span></h2>{intakes.length === 0 ? <p className="empty-state">Aucune demande à qualifier.</p> : intakes.map((intake) => <article key={intake.id}><div><strong>{intake.organizationName}</strong><span>{intake.contactName} · {intake.contactEmail} · {intake.createdLabel}</span><p>{intake.message}</p></div><div><button className="secondary-action" onClick={() => onReviewIntake(intake.id, "rejected")}>Rejeter</button><button className="secondary-action" onClick={() => onReviewIntake(intake.id, "accepted")}>Marquer revue</button></div></article>)}</section>
    </section>
  );
}

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

function priorityLabel(value: Organization["priority"]) { return { very_high: "Priorité très élevée", high: "Priorité élevée", normal: "Priorité normale", low: "Priorité basse" }[value]; }
function budget(account: Organization) { if (account.budgetMinCents == null && account.budgetMaxCents == null) return "Non estimée"; const format = (value: number | null) => value == null ? "?" : new Intl.NumberFormat("fr-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 0 }).format(value / 100); return `${format(account.budgetMinCents)} – ${format(account.budgetMaxCents)}`; }

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
