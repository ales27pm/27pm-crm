"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DashboardData,
  Contact,
  Deal,
  NavView,
  Organization,
  PipelineStage,
} from "../crm-types";
import { AccountDialog } from "./account-dialog";
import { AccountsView } from "./account-workspace";
import { ComposeDialog } from "./compose-dialog";
import { ContactDialog } from "./contact-dialog";
import { ContextRail } from "./context-rail";
import { InboxRail, type InboxFilter } from "./inbox-rail";
import { Icon } from "./icons";
import { PipelineView } from "./pipeline-view";
import { Sidebar } from "./sidebar";
import { ThreadView } from "./thread-view";
import { TodayView } from "./today-view";
import {
  ProjectsView,
  SettingsView,
  TasksView,
} from "./work-views";

type CrmAppProps = {
  initialData: DashboardData;
  operator: { displayName: string; email: string };
};

const viewTitles: Record<NavView, string> = {
  today: "Aujourd’hui",
  inbox: "Réception",
  contacts: "Comptes",
  pipeline: "Pipeline",
  projects: "Projets",
  tasks: "Tâches",
  settings: "Paramètres",
};

export function CrmApp({ initialData, operator }: CrmAppProps) {
  const [data, setData] = useState(initialData);
  const [activeView, setActiveView] = useState<NavView>("today");
  const [mailboxAddress, setMailboxAddress] = useState(
    initialData.mailboxes[0]?.address ?? "bonjour@27pm.org",
  );
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(
    initialData.conversations[0]?.id ?? null,
  );
  const [selectedDealId, setSelectedDealId] = useState<string | null>(
    initialData.deals[0]?.id ?? null,
  );
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [search, setSearch] = useState("");
  const [composeOpen, setComposeOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Organization | null>(null);
  const [contactAccount, setContactAccount] = useState<Organization | null>(null);
  const [editingContact, setEditingContact] = useState<Contact | null>(null);
  const [requestedAccountId, setRequestedAccountId] = useState<string | null>(null);
  const [requestedIntakeId, setRequestedIntakeId] = useState<string | null>(null);
  const [contextOpen, setContextOpen] = useState(false);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
  const workspaceTitleRef = useRef<HTMLHeadingElement>(null);
  const [mobileThreadOpen, setMobileThreadOpen] = useState(
    Boolean(initialData.conversations[0]),
  );
  const [syncMessage, setSyncMessage] = useState(
    initialData.live ? "" : "Aperçu local — connexion du serveur en cours",
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetchDashboard(controller.signal)
      .then((dashboard) => {
        if (!dashboard) return;
        setData(dashboard);
        setSyncMessage("");
        const defaultMailbox = dashboard.mailboxes[0]?.address;
        if (defaultMailbox) setMailboxAddress(defaultMailbox);
        const defaultConversation = dashboard.conversations[0];
        setSelectedConversationId(defaultConversation?.id ?? null);
        setSelectedDealId(defaultConversation?.dealId ?? dashboard.deals[0]?.id ?? null);
        setMobileThreadOpen(Boolean(defaultConversation));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setSyncMessage("Serveur indisponible — aperçu local conservé");
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const editing =
        target?.matches("input, textarea, select, [contenteditable='true']") ?? false;
      if (!editing && event.key.toLowerCase() === "n") {
        event.preventDefault();
        setComposeOpen(true);
      }
      if (!editing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".search-field input")?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const visibleConversations = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("fr-CA");
    return data.conversations.filter((conversation) => {
      if (conversation.mailboxAddress !== mailboxAddress) return false;
      if (filter === "unread" && !conversation.unread) return false;
      if (filter === "follow-up" && !conversation.followUp) return false;
      if (!query) return true;
      return [
        conversation.contactName,
        conversation.organization,
        conversation.subject,
        conversation.preview,
      ].some((value) => value.toLocaleLowerCase("fr-CA").includes(query));
    });
  }, [data.conversations, filter, mailboxAddress, search]);

  const selectedConversation =
    data.conversations.find((item) => item.id === selectedConversationId) ??
    visibleConversations[0] ??
    null;
  const selectedContact = selectedConversation
    ? data.contacts.find((item) => item.id === selectedConversation.contactId) ?? null
    : null;
  const selectedConversationDeal = selectedConversation?.dealId
    ? data.deals.find((item) => item.id === selectedConversation.dealId) ?? null
    : null;
  const selectedPipelineDeal =
    data.deals.find((item) => item.id === selectedDealId) ?? data.deals[0] ?? null;
  const selectedPipelineContact = selectedPipelineDeal
    ? data.contacts.find((item) => item.id === selectedPipelineDeal.contactId) ?? null
    : null;
  const unreadCount = data.conversations.filter((conversation) => conversation.unread).length;
  const sendEnabled = data.live && data.transportState === "operational";

  const closeInboxContext = useCallback(() => {
    setContextOpen(false);
    window.requestAnimationFrame(() => {
      if (contextTriggerRef.current?.isConnected) {
        contextTriggerRef.current.focus();
      }
    });
  }, []);

  function navigate(view: NavView) {
    setActiveView(view);
    setContextOpen(false);
    if (view !== "contacts") {
      setRequestedAccountId(null);
      setRequestedIntakeId(null);
    }
  }

  function focusWorkspaceTitle() {
    window.requestAnimationFrame(() => workspaceTitleRef.current?.focus());
  }

  function selectConversation(id: string) {
    const conversation = data.conversations.find((item) => item.id === id);
    setSelectedConversationId(id);
    setSelectedDealId(conversation?.dealId ?? null);
    setMobileThreadOpen(true);
    if (conversation?.unread) {
      setData((current) => ({
        ...current,
        conversations: current.conversations.map((item) =>
          item.id === id ? { ...item, unread: false } : item,
        ),
      }));
      if (currentIsLive(data)) {
        void fetch(`/api/conversations/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ unread: false }),
        }).then((response) => {
          if (!response.ok) setSyncMessage("La lecture n’a pas pu être synchronisée.");
        }).catch(() => setSyncMessage("La lecture n’a pas pu être synchronisée."));
      }
    }
  }

  function updateDeal(id: string, patch: Partial<Deal>) {
    const previous = data.deals.find((deal) => deal.id === id);
    const { nextActionDate, ...directPatch } = patch;
    const apiPatch =
      nextActionDate === undefined
        ? directPatch
        : {
            ...directPatch,
            nextActionAt: nextActionDate
              ? `${nextActionDate}T12:00:00.000Z`
              : null,
          };
    setData((current) => ({
      ...current,
      deals: current.deals.map((deal) => (deal.id === id ? { ...deal, ...patch } : deal)),
    }));
    if (currentIsLive(data)) {
      void fetch(`/api/deals/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(apiPatch),
      }).then((response) => {
        if (response.ok) {
          setSyncMessage("");
          return;
        }
        if (previous) {
          setData((current) => ({
            ...current,
            deals: current.deals.map((deal) => (deal.id === id ? previous : deal)),
          }));
        }
        setSyncMessage("La modification du dossier n’a pas été enregistrée.");
      }).catch(() => {
        if (previous) {
          setData((current) => ({
            ...current,
            deals: current.deals.map((deal) => (deal.id === id ? previous : deal)),
          }));
        }
        setSyncMessage("La modification du dossier n’a pas été enregistrée.");
      });
    }
  }

  function addTask(deal: Deal | null) {
    if (!deal) return;
    const id = crypto.randomUUID();
    setData((current) => ({
      ...current,
      tasks: [
        ...current.tasks,
        {
          id,
          title: deal.nextAction || `Suivre ${deal.title}`,
          dueLabel: deal.nextActionDate || "À planifier",
          dueAt: deal.nextActionDate
            ? `${deal.nextActionDate}T12:00:00.000Z`
            : null,
          overdue: false,
          completed: false,
          dealId: deal.id,
          conversationId: deal.conversationId,
          organizationId: deal.organizationId,
          organization: deal.organization,
        },
      ],
    }));
    if (currentIsLive(data)) {
      void fetch("/api/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title: deal.nextAction || `Suivre ${deal.title}`,
          dealId: deal.id,
          contactAction: false,
          contactChannel: "internal",
          dueAt: deal.nextActionDate
            ? `${deal.nextActionDate}T12:00:00.000Z`
            : undefined,
        }),
      }).then(async (response) => {
        if (!response.ok) throw new Error("task_create_failed");
        await refreshDashboard();
      }).catch(() => {
        setData((current) => ({
          ...current,
          tasks: current.tasks.filter((task) => task.id !== id),
        }));
        setSyncMessage("La tâche n’a pas été enregistrée.");
      });
    }
  }

  function toggleTask(id: string) {
    const task = data.tasks.find((item) => item.id === id);
    if (!task) return;
    const completed = !task.completed;
    setData((current) => ({
      ...current,
      tasks: current.tasks.map((item) =>
        item.id === id ? { ...item, completed } : item,
      ),
    }));
    if (!currentIsLive(data)) return;
    void fetch(`/api/tasks/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ completed }),
    }).then((response) => {
      if (!response.ok) throw new Error("task_update_failed");
      setSyncMessage("");
    }).catch(() => {
      setData((current) => ({
        ...current,
        tasks: current.tasks.map((item) =>
          item.id === id ? { ...item, completed: task.completed } : item,
        ),
      }));
      setSyncMessage("La tâche n’a pas été mise à jour.");
    });
  }

  async function refreshDashboard() {
    const dashboard = await fetchDashboard();
    if (!dashboard) throw new Error("dashboard_refresh_failed");
    setData(dashboard);
    setSyncMessage("");
    return dashboard;
  }

  async function addInteraction(
    dealId: string,
    kind: Deal["interactions"][number]["kind"],
    summary: string,
  ) {
    if (!currentIsLive(data)) return false;
    try {
      const response = await fetch("/api/interactions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dealId, kind, summary }),
      });
      if (!response.ok) return false;
      await refreshDashboard();
      return true;
    } catch {
      setSyncMessage("L’interaction n’a pas été enregistrée.");
      return false;
    }
  }

  async function sendMessage(payload: Record<string, string | boolean>) {
    if (!sendEnabled) return false;
    try {
      const response = await fetch("/api/messages/send", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...payload, idempotencyKey: crypto.randomUUID() }),
      });
      if (response.ok) await refreshDashboard();
      return response.ok;
    } catch {
      return false;
    }
  }

  function confirmReply(payload: Record<string, string>) {
    if (!window.confirm("Confirmer la qualification, le fondement LCAP et les preuves à jour pour ce destinataire unique?")) return Promise.resolve(false);
    return sendMessage({ ...payload, complianceConfirmed: true });
  }

  const inboxContext = (
    <ContextRail
      id="conversation-context"
      contact={selectedContact}
      deal={selectedConversationDeal}
      open={contextOpen}
      mobileSheet
      onClose={closeInboxContext}
      onDealChange={(patch) => {
        if (selectedConversationDeal) updateDeal(selectedConversationDeal.id, patch);
      }}
      onAddTask={() => addTask(selectedConversationDeal)}
      onAddInteraction={(kind, summary) =>
        selectedConversationDeal
          ? addInteraction(selectedConversationDeal.id, kind, summary)
          : Promise.resolve(false)
      }
    />
  );

  return (
    <div className="crm-app">
      <Sidebar
        active={activeView}
        unreadCount={unreadCount}
        transportState={data.transportState}
        onNavigate={navigate}
      />

      <main className="workspace">
        <header className="workspace-header">
          <div>
            <h1 ref={workspaceTitleRef} tabIndex={-1}>{viewTitles[activeView]}</h1>
            {syncMessage ? <p role="status">{syncMessage}</p> : null}
          </div>
          {activeView === "inbox" ? (
            <button className="primary-action" type="button" onClick={() => setComposeOpen(true)}>
              <Icon name="compose" /> Nouveau courriel
            </button>
          ) : null}
          {(["contacts", "pipeline", "projects"] as NavView[]).includes(activeView) ? (
            <button className="primary-action" type="button" onClick={() => { setEditingAccount(null); setAccountOpen(true); }}>
              <Icon name="plus" /> Nouvelle entreprise
            </button>
          ) : null}
        </header>

        {activeView === "today" ? (
          <TodayView
            data={data}
            operatorName={operator.displayName}
            onOpenAccounts={(organizationId, intakeId) => {
              setRequestedAccountId(organizationId ?? null);
              setRequestedIntakeId(intakeId ?? null);
              setContextOpen(false);
              setActiveView("contacts");
            }}
            onOpenConversation={(id) => {
              selectConversation(id);
              setContextOpen(false);
              setActiveView("inbox");
              focusWorkspaceTitle();
            }}
            onOpenDeal={(id) => {
              setSelectedDealId(id);
              setContextOpen(true);
              setActiveView("pipeline");
              focusWorkspaceTitle();
            }}
            onOpenTasks={() => {
              navigate("tasks");
              focusWorkspaceTitle();
            }}
            onToggleTask={toggleTask}
          />
        ) : null}

        {activeView === "inbox" ? (
          <div className="inbox-workspace">
            <InboxRail
              mailboxes={data.mailboxes}
              mailboxAddress={mailboxAddress}
              conversations={visibleConversations}
              selectedId={selectedConversation?.id ?? null}
              filter={filter}
              search={search}
              hiddenOnMobile={mobileThreadOpen}
              onMailboxChange={(address) => {
                setMailboxAddress(address);
                setSelectedConversationId(
                  data.conversations.find((item) => item.mailboxAddress === address)?.id ?? null,
                );
                setMobileThreadOpen(false);
              }}
              onFilterChange={setFilter}
              onSearchChange={setSearch}
              onSelect={selectConversation}
            />
            <div className="thread-column" data-mobile-hidden={!mobileThreadOpen || undefined}>
              <ThreadView
                key={selectedConversation?.id ?? "empty"}
                conversation={selectedConversation}
                sendEnabled={sendEnabled}
                contextOpen={contextOpen}
                contextTriggerRef={contextTriggerRef}
                onBack={() => setMobileThreadOpen(false)}
                onOpenContext={() => setContextOpen(true)}
                onSend={(body) =>
                  selectedConversation
                    ? confirmReply({
                        conversationId: selectedConversation.id,
                        from: selectedConversation.mailboxAddress,
                        to: selectedConversation.contactEmail,
                        subject: selectedConversation.subject,
                        body,
                      })
                    : Promise.resolve(false)
                }
              />
            </div>
            {inboxContext}
          </div>
        ) : null}

        {activeView === "pipeline" ? (
          <div className="pipeline-workspace">
            <PipelineView
              deals={data.deals}
              selectedId={selectedPipelineDeal?.id ?? null}
              onSelect={(id) => {
                setSelectedDealId(id);
                setContextOpen(true);
              }}
              onMove={(id, stage: PipelineStage) => updateDeal(id, { stage })}
            />
            <ContextRail
              contact={selectedPipelineContact}
              deal={selectedPipelineDeal}
              open={contextOpen}
              mobileSheet={false}
              onClose={() => setContextOpen(false)}
              onDealChange={(patch) => {
                if (selectedPipelineDeal) updateDeal(selectedPipelineDeal.id, patch);
              }}
              onAddTask={() => addTask(selectedPipelineDeal)}
              onAddInteraction={(kind, summary) =>
                selectedPipelineDeal
                  ? addInteraction(selectedPipelineDeal.id, kind, summary)
                  : Promise.resolve(false)
              }
              onOpenConversation={
                selectedPipelineDeal && data.conversations.some(
                  (conversation) => conversation.id === selectedPipelineDeal.conversationId,
                )
                  ? () => {
                      setSelectedConversationId(selectedPipelineDeal.conversationId);
                      setActiveView("inbox");
                      setMobileThreadOpen(true);
                    }
                  : undefined
              }
            />
          </div>
        ) : null}

        {activeView === "contacts" ? (
          <AccountsView
            key={`${requestedAccountId ?? "all"}:${requestedIntakeId ?? "none"}`}
            requestedAccountId={requestedAccountId}
            requestedIntakeId={requestedIntakeId}
            organizations={data.organizations}
            contacts={data.contacts}
            deals={data.deals}
            tasks={data.tasks}
            intakes={data.intakes}
            onEdit={(account) => {
              setEditingAccount(account);
              setAccountOpen(true);
            }}
            onAddContact={(account) => {
              setEditingContact(null);
              setContactAccount(account);
            }}
            onEditContact={(account, contact) => {
              setEditingContact(contact);
              setContactAccount(account);
            }}
            onReviewIntake={(id, status) => {
              void fetch(`/api/intake/${encodeURIComponent(id)}`, {
                method: "PATCH",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ status }),
              }).then((response) => {
                if (!response.ok) throw new Error();
                return refreshDashboard();
              }).catch(() => setSyncMessage("La demande n’a pas pu être revue."));
            }}
            onOpenDeal={(id) => {
              setSelectedDealId(id);
              setContextOpen(true);
              setActiveView("pipeline");
              focusWorkspaceTitle();
            }}
            onToggleTask={toggleTask}
          />
        ) : null}
        {activeView === "projects" ? <ProjectsView deals={data.deals} /> : null}
        {activeView === "tasks" ? (
          <TasksView
            tasks={data.tasks}
            onToggle={toggleTask}
          />
        ) : null}
        {activeView === "settings" ? (
          <SettingsView
            mailboxes={data.mailboxes}
            transportState={data.transportState}
            operatorEmail={operator.email}
            activities={data.activities}
            contacts={data.contacts}
          />
        ) : null}
      </main>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {(
          [
            ["today", "Aujourd’hui", "calendar"],
            ["inbox", "Réception", "inbox"],
            ["contacts", "Comptes", "contacts"],
            ["pipeline", "Pipeline", "pipeline"],
            ["tasks", "Tâches", "tasks"],
          ] as const
        ).map(([view, label, icon]) => (
          <button
            key={view}
            type="button"
            data-active={activeView === view || undefined}
            onClick={() => navigate(view)}
          >
            <Icon name={icon} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <ComposeDialog
        open={composeOpen}
        mailboxes={data.mailboxes}
        sendEnabled={sendEnabled}
        onClose={() => setComposeOpen(false)}
        onSend={sendMessage}
      />
      <AccountDialog account={editingAccount} open={accountOpen} onClose={() => setAccountOpen(false)} onSaved={async () => { await refreshDashboard(); }} />
      <ContactDialog account={contactAccount} contact={editingContact} open={Boolean(contactAccount)} onClose={() => { setContactAccount(null); setEditingContact(null); }} onSaved={async () => { await refreshDashboard(); }} />
    </div>
  );
}

function currentIsLive(data: DashboardData) {
  return data.live;
}

async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const response = await fetch("/api/dashboard", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) throw new Error(`dashboard_http_${response.status}`);
  return (await response.json()) as DashboardData;
}
