"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type {
  Contact,
  CrmInteraction,
  CrmTask,
  Deal,
  IntakeSubmission,
  Organization,
  OutreachStep,
  OutreachStrategy,
} from "../crm-types";
import { isGlobalComplianceReason, outreachErrorMessage } from "../../lib/outreach-errors";
import { Icon } from "./icons";
import { OutreachStrategyPanel } from "./outreach-strategy-panel";

type AccountsViewProps = {
  requestedAccountId?: string | null;
  requestedIntakeId?: string | null;
  requestedStrategyAccountId?: string | null;
  onStrategyRequestHandled?: () => void;
  organizations: Organization[];
  contacts: Contact[];
  deals: Deal[];
  tasks: CrmTask[];
  strategies?: OutreachStrategy[];
  intakes: IntakeSubmission[];
  onEdit: (account: Organization) => void;
  onAddContact: (account: Organization) => void;
  onEditContact: (account: Organization, contact: Contact) => void;
  onReviewIntake: (id: string, status: "accepted" | "rejected") => void;
  onOpenDeal: (id: string) => void;
  onToggleTask: (id: string) => void;
  onEditStrategy?: (account: Organization, strategy: OutreachStrategy | null) => void;
  onOpenComplianceSettings?: () => void;
  onUpdateStrategyStep?: (
    strategyId: string,
    stepId: string,
    patch: { status?: OutreachStep["status"]; scheduledAt?: string },
  ) => void;
  updatingStrategyStepIds?: ReadonlySet<string>;
};

type AccountFilter = "all" | "high" | "unassigned" | "blocked";

type TimelineEntry = CrmInteraction & { dealTitle: string };

export function AccountsView({
  requestedAccountId,
  requestedIntakeId,
  requestedStrategyAccountId,
  onStrategyRequestHandled = () => undefined,
  organizations,
  contacts,
  deals,
  tasks,
  strategies = [],
  intakes,
  onEdit,
  onAddContact,
  onEditContact,
  onReviewIntake,
  onOpenDeal,
  onToggleTask,
  onEditStrategy = () => undefined,
  onOpenComplianceSettings = () => undefined,
  onUpdateStrategyStep = () => undefined,
  updatingStrategyStepIds = new Set<string>(),
}: AccountsViewProps) {
  const viewRef = useRef<HTMLElement>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<AccountFilter>("all");
  const [selectedAccountId, setSelectedAccountId] = useState(
    requestedAccountId ?? organizations[0]?.id ?? null,
  );

  useEffect(() => {
    if (!requestedAccountId || !organizations.some((account) => account.id === requestedAccountId)) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const target = Array.from(
        viewRef.current?.querySelectorAll<HTMLButtonElement>("[data-account-id]") ?? [],
      ).find((button) => button.dataset.accountId === requestedAccountId);
      target?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [organizations, requestedAccountId]);

  useEffect(() => {
    if (!requestedIntakeId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = Array.from(
        viewRef.current?.querySelectorAll<HTMLElement>("[data-intake-id]") ?? [],
      ).find((item) => item.dataset.intakeId === requestedIntakeId);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [intakes, requestedIntakeId]);

  useEffect(() => {
    if (!requestedStrategyAccountId) return;
    const frame = window.requestAnimationFrame(() => {
      const target = Array.from(
        viewRef.current?.querySelectorAll<HTMLElement>("[data-outreach-strategy-account-id]") ?? [],
      ).find((item) => item.dataset.outreachStrategyAccountId === requestedStrategyAccountId);
      target?.scrollIntoView({ behavior: "smooth", block: "start" });
      target?.focus({ preventScroll: true });
      if (target) onStrategyRequestHandled();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [onStrategyRequestHandled, requestedStrategyAccountId]);

  const accountNameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of organizations) {
      const name = normalize(account.name);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [organizations]);

  const visibleAccounts = useMemo(() => {
    const normalizedQuery = normalize(query);
    return organizations.filter((account) => {
      const matchesQuery = [
        account.name,
        account.ownerEmail ?? "",
        account.sourceLabel,
        account.nextStep ?? "",
      ].some((value) => normalize(value).includes(normalizedQuery));
      if (!matchesQuery) return false;
      if (filter === "unassigned") return !account.ownerEmail;
      if (filter === "blocked") return account.doNotContact;
      if (filter === "high") {
        return account.priority === "very_high" || account.priority === "high";
      }
      return true;
    });
  }, [filter, organizations, query]);

  const selectedAccount =
    visibleAccounts.find((account) => account.id === selectedAccountId) ??
    visibleAccounts[0] ??
    null;

  const selectedNameIsUnique = selectedAccount
    ? accountNameCounts.get(normalize(selectedAccount.name)) === 1
    : false;
  const relatedContacts = selectedAccount
    ? contacts.filter((contact) => belongsToAccount(contact, selectedAccount, selectedNameIsUnique))
    : [];
  const relatedDeals = selectedAccount
    ? deals.filter((deal) => belongsToAccount(deal, selectedAccount, selectedNameIsUnique))
    : [];
  const relatedDealIds = new Set(relatedDeals.map((deal) => deal.id));
  const relatedTasks = selectedAccount
    ? tasks.filter((task) =>
        Boolean(task.dealId && relatedDealIds.has(task.dealId)) ||
        belongsToAccount(task, selectedAccount, selectedNameIsUnique),
      )
    : [];
  const openTasks = relatedTasks.filter((task) => !task.completed);
  const overdueTasks = openTasks.filter((task) => task.overdue);
  const selectedStrategy = selectedAccount
    ? strategies.find((strategy) => strategy.organizationId === selectedAccount.id) ?? null
    : null;
  const timeline = relatedDeals
    .flatMap<TimelineEntry>((deal) =>
      deal.interactions.map((interaction) => ({
        ...interaction,
        dealTitle: deal.title,
      })),
    )
    .toSorted((left, right) => right.occurredAt.localeCompare(left.occurredAt));

  return (
    <section ref={viewRef} className="accounts-view" aria-label="Espace de travail des comptes">
      <div className="account-v2-summary">
        <div>
          <strong>{organizations.length}</strong>
          <span>entreprises</span>
        </div>
        <div>
          <strong>{organizations.filter((account) => account.priority === "very_high" || account.priority === "high").length}</strong>
          <span>prioritaires</span>
        </div>
        <div>
          <strong>{organizations.filter((account) => !account.ownerEmail).length}</strong>
          <span>non assignées</span>
        </div>
        <div data-alert={intakes.length > 0 || undefined}>
          <strong>{intakes.length}</strong>
          <span>demandes à revoir</span>
        </div>
      </div>

      <div className="account-v2-filters">
        <label className="search-field account-v2-search">
          <span className="sr-only">Rechercher une entreprise</span>
          <Icon name="search" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Entreprise, responsable ou prochaine étape"
          />
        </label>
        <label className="account-v2-filter">
          <span className="sr-only">Filtrer les entreprises</span>
          <select
            value={filter}
            onChange={(event) => setFilter(event.target.value as AccountFilter)}
          >
            <option value="all">Toutes les entreprises</option>
            <option value="high">Priorité haute</option>
            <option value="unassigned">Non assignées</option>
            <option value="blocked">Contact bloqué</option>
          </select>
          <Icon name="chevron" />
        </label>
      </div>

      <div className="account-v2-layout">
        <aside className="account-master" aria-label="Liste des entreprises">
          <header>
            <strong>{visibleAccounts.length} résultat{visibleAccounts.length === 1 ? "" : "s"}</strong>
            <span>Choisir une entreprise</span>
          </header>
          <div className="account-master-list">
            {visibleAccounts.map((account) => (
              <button
                type="button"
                className="account-master-row"
                data-active={selectedAccount?.id === account.id || undefined}
                data-blocked={account.doNotContact || undefined}
                data-account-id={account.id}
                aria-pressed={selectedAccount?.id === account.id}
                key={account.id}
                onClick={() => setSelectedAccountId(account.id)}
              >
                <span className="account-master-score">{account.score ?? "—"}</span>
                <span className="account-master-copy">
                  <strong>{account.name}</strong>
                  <small>{priorityLabel(account.priority)} · {account.ownerEmail ?? "Non assignée"}</small>
                  <span>{account.nextStep ?? "Prochaine étape à définir"}</span>
                </span>
                <Icon name="chevron" />
              </button>
            ))}
          </div>
          {visibleAccounts.length === 0 ? (
            <p className="account-master-empty">Aucune entreprise ne correspond à ces critères.</p>
          ) : null}
        </aside>

        <div className="account-detail">
          {selectedAccount ? (
            <>
              <header className="account-detail-header">
                <div>
                  <span className="account-eyebrow">Fiche entreprise</span>
                  <h2>{selectedAccount.name}</h2>
                  <p>{selectedAccount.website ?? "Site web à documenter"}</p>
                </div>
                <div className="account-detail-actions">
                  <span className="account-priority" data-priority={selectedAccount.priority}>
                    {priorityLabel(selectedAccount.priority)}
                  </span>
                  <button type="button" className="secondary-action" onClick={() => onEdit(selectedAccount)}>
                    Modifier l’entreprise
                  </button>
                </div>
              </header>

              {selectedAccount.doNotContact ? (
                <p className="account-compliance-stop" role="status">
                  Toute action de contact est bloquée pour cette entreprise. Les données restent visibles pour conserver la preuve et l’historique.
                </p>
              ) : null}

              <dl className="account-stat-grid">
                <div><dt>Score</dt><dd>{selectedAccount.score ?? "—"}<small>/ 100</small></dd></div>
                <div><dt>Contacts</dt><dd>{relatedContacts.length}</dd></div>
                <div><dt>Opportunités</dt><dd>{relatedDeals.length}</dd></div>
                <div data-alert={overdueTasks.length > 0 || undefined}><dt>Actions ouvertes</dt><dd>{openTasks.length}<small>{overdueTasks.length ? ` · ${overdueTasks.length} en retard` : ""}</small></dd></div>
              </dl>

              <section className="account-focus">
                <div>
                  <span>À faire maintenant</span>
                  <h3>{selectedAccount.nextStep ?? "Définir la prochaine étape"}</h3>
                  <p>
                    {selectedAccount.nextFollowUpAt
                      ? `Relance prévue le ${formatDate(selectedAccount.nextFollowUpAt)}`
                      : "Aucune date de relance planifiée"}
                  </p>
                </div>
                <button type="button" className="secondary-action" onClick={() => onEdit(selectedAccount)}>
                  Ajuster le suivi
                </button>
              </section>

              <div className="account-detail-grid">
                <section className="account-section">
                  <header>
                    <div><span>Relations</span><h3>Contacts</h3></div>
                    <button
                      type="button"
                      className="secondary-action"
                      disabled={selectedAccount.doNotContact}
                      onClick={() => onAddContact(selectedAccount)}
                    >
                      <Icon name="plus" /> Ajouter
                    </button>
                  </header>
                  <div className="account-section-list">
                    {relatedContacts.map((contact) => {
                      const reasons = contact.emailBlockReasons?.length
                        ? contact.emailBlockReasons
                        : contact.emailReady
                          ? []
                          : ["contact_compliance_missing"];
                      const hasGlobalBlocker = reasons.some(isGlobalComplianceReason);
                      return (
                        <article
                          className="account-contact-card"
                          data-ready={contact.emailReady || undefined}
                          key={contact.id}
                        >
                          <button
                            type="button"
                            className="account-contact-row"
                            data-blocked={contact.doNotContact || contact.unsubscribed || undefined}
                            onClick={() => onEditContact(selectedAccount, contact)}
                          >
                            <span className="account-contact-initials">{initials(contact.name)}</span>
                            <span>
                              <strong>{contact.name}</strong>
                              <small>{contact.role || "Rôle à documenter"} · {contact.status}</small>
                              <span>{contact.email}</span>
                            </span>
                            <Icon name="chevron" />
                          </button>
                          <div className="contact-lcap-summary" role="status">
                            <strong>{contact.emailReady ? "Dossier LCAP documenté" : "Validation LCAP requise"}</strong>
                            {contact.emailReady ? (
                              <p>Le dossier permet la préparation. Le serveur le revérifiera avant toute action; aucun envoi n’est autorisé ici.</p>
                            ) : (
                              <ul>
                                {reasons.map((reason) => <li key={reason}>{outreachErrorMessage(reason)}</li>)}
                              </ul>
                            )}
                            <div className="contact-lcap-actions">
                              <button
                                type="button"
                                className="secondary-action"
                                onClick={() => onEditContact(selectedAccount, contact)}
                              >
                                {contact.emailReady ? "Revoir le dossier LCAP" : "Compléter la validation LCAP"}
                              </button>
                              {hasGlobalBlocker ? (
                                <button type="button" className="secondary-action" onClick={onOpenComplianceSettings}>
                                  Ouvrir les paramètres de conformité
                                </button>
                              ) : null}
                            </div>
                            {contact.emailEvaluatedAt ? (
                              <small>Décision serveur évaluée le {formatDate(contact.emailEvaluatedAt)}.</small>
                            ) : null}
                          </div>
                        </article>
                      );
                    })}
                    {relatedContacts.length === 0 ? (
                      <p className="account-section-empty">Aucun contact vérifié. Ajoutez uniquement un rôle professionnel dont la provenance est documentée.</p>
                    ) : null}
                  </div>
                </section>

                <OutreachStrategyPanel
                  account={selectedAccount}
                  strategy={selectedStrategy}
                  onEdit={() => onEditStrategy(selectedAccount, selectedStrategy)}
                  onResolveContact={() => {
                    const contact = selectedStrategy?.contactId
                      ? relatedContacts.find((candidate) => candidate.id === selectedStrategy.contactId)
                      : null;
                    if (contact) onEditContact(selectedAccount, contact);
                  }}
                  onOpenComplianceSettings={onOpenComplianceSettings}
                  onUpdateStep={onUpdateStrategyStep}
                  updatingStepIds={updatingStrategyStepIds}
                />

                <section className="account-section">
                  <header><div><span>Vente</span><h3>Opportunités</h3></div></header>
                  <div className="account-section-list">
                    {relatedDeals.map((deal) => (
                      <article className="account-deal-row" key={deal.id}>
                        <div>
                          <strong>{deal.title}</strong>
                          <small>{stageLabel(deal.stage)} · {deal.projectType || "À définir"}</small>
                          <span>{deal.nextAction || "Prochaine action à définir"}</span>
                        </div>
                        <button type="button" className="secondary-action" onClick={() => onOpenDeal(deal.id)}>
                          Ouvrir dans le pipeline
                        </button>
                      </article>
                    ))}
                    {relatedDeals.length === 0 ? (
                      <p className="account-section-empty">Aucune opportunité active pour cette entreprise.</p>
                    ) : null}
                  </div>
                </section>

                <section className="account-section">
                  <header><div><span>Suivi</span><h3>Tâches</h3></div></header>
                  <div className="account-section-list">
                    {relatedTasks.map((task) => (
                      <label className="account-task-row" data-overdue={task.overdue || undefined} key={task.id}>
                        <input
                          type="checkbox"
                          checked={task.completed}
                          onChange={() => onToggleTask(task.id)}
                        />
                        <span className="task-check"><Icon name="check" /></span>
                        <span>
                          <strong>{task.title}</strong>
                          <small>{task.dueLabel}{task.overdue && !task.completed ? " · En retard" : ""}</small>
                        </span>
                      </label>
                    ))}
                    {relatedTasks.length === 0 ? (
                      <p className="account-section-empty">Aucune tâche rattachée aux opportunités de cette entreprise.</p>
                    ) : null}
                  </div>
                </section>

                <section className="account-section account-commercial-context">
                  <header><div><span>Qualification</span><h3>Contexte commercial</h3></div></header>
                  <dl>
                    <div><dt>Responsable</dt><dd>{selectedAccount.ownerEmail ?? "Non assignée"}</dd></div>
                    <div>
                      <dt>Source</dt>
                      <dd>
                        {selectedAccount.sourceUrl ? (
                          <a href={selectedAccount.sourceUrl} target="_blank" rel="noreferrer">
                            {selectedAccount.sourceLabel}
                          </a>
                        ) : selectedAccount.sourceLabel}
                        {selectedAccount.sourceDate ? ` · ${formatDate(selectedAccount.sourceDate)}` : ""}
                      </dd>
                    </div>
                    <div><dt>Enveloppe</dt><dd>{budgetLabel(selectedAccount)}</dd></div>
                    <div><dt>Dernier contact</dt><dd>{selectedAccount.lastContactAt ? formatDate(selectedAccount.lastContactAt) : "Aucun"}</dd></div>
                  </dl>
                  {selectedAccount.budgetIsHypothesis ? (
                    <p>Budget indicatif : cette hypothèse doit être validée avant toute proposition.</p>
                  ) : null}
                </section>

                <section className="account-section account-timeline">
                  <header><div><span>Mémoire</span><h3>Historique récent</h3></div></header>
                  <ol>
                    {timeline.slice(0, 8).map((entry) => (
                      <li key={entry.id}>
                        <span className="account-timeline-marker" aria-hidden="true" />
                        <div>
                          <strong>{interactionLabel(entry.kind)} · {entry.dealTitle}</strong>
                          <time dateTime={entry.occurredAt}>{entry.occurredLabel}</time>
                          <p>{entry.summary}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                  {timeline.length === 0 ? (
                    <p className="account-section-empty">Aucune interaction manuelle consignée pour cette entreprise.</p>
                  ) : null}
                </section>
              </div>
            </>
          ) : (
            <div className="account-detail-empty">
              <Icon name="contacts" />
              <h2>Aucune entreprise sélectionnée</h2>
              <p>Modifiez la recherche ou créez une entreprise pour commencer.</p>
            </div>
          )}

          <section className="intake-queue account-intake-queue">
            <h2>Demandes publiques en attente <span>{intakes.length}</span></h2>
            {intakes.length === 0 ? (
              <p className="account-section-empty">Aucune demande à qualifier.</p>
            ) : intakes.map((intake) => (
              <article data-intake-id={intake.id} key={intake.id} tabIndex={-1}>
                <div>
                  <strong>{intake.organizationName}</strong>
                  <span>{intake.contactName} · {intake.contactEmail} · {intake.createdLabel}</span>
                  <p>{intake.message}</p>
                </div>
                <div>
                  <button className="secondary-action" type="button" onClick={() => onReviewIntake(intake.id, "rejected")}>Rejeter</button>
                  <button className="secondary-action" type="button" onClick={() => onReviewIntake(intake.id, "accepted")}>Marquer revue</button>
                </div>
              </article>
            ))}
          </section>
        </div>
      </div>
    </section>
  );
}

function belongsToAccount(
  item: Pick<Contact | Deal | CrmTask, "organizationId" | "organization">,
  account: Organization,
  allowNameFallback: boolean,
) {
  if (item.organizationId) return item.organizationId === account.id;
  return allowNameFallback && normalize(item.organization) === normalize(account.name);
}

function normalize(value: string) {
  return value.trim().toLocaleLowerCase("fr-CA");
}

function initials(name: string) {
  return name
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("fr-CA") ?? "")
    .join("") || "—";
}

function priorityLabel(value: Organization["priority"]) {
  return {
    very_high: "Priorité très élevée",
    high: "Priorité élevée",
    normal: "Priorité normale",
    low: "Priorité basse",
  }[value];
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

function budgetLabel(account: Organization) {
  if (account.budgetMinCents == null && account.budgetMaxCents == null) return "Non estimée";
  const format = (value: number | null) =>
    value == null
      ? "?"
      : new Intl.NumberFormat("fr-CA", {
          style: "currency",
          currency: "CAD",
          maximumFractionDigits: 0,
        }).format(value / 100);
  return `${format(account.budgetMinCents)} – ${format(account.budgetMaxCents)}`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 10);
  return new Intl.DateTimeFormat("fr-CA", { dateStyle: "medium" }).format(date);
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
