"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DashboardData,
  Deal,
  NavView,
  PipelineStage,
} from "../crm-types";
import { ComposeDialog } from "./compose-dialog";
import { ContextRail } from "./context-rail";
import { InboxRail, type InboxFilter } from "./inbox-rail";
import { Icon } from "./icons";
import { PipelineView } from "./pipeline-view";
import { Sidebar } from "./sidebar";
import { ThreadView } from "./thread-view";
import {
  ContactsView,
  ProjectsView,
  SettingsView,
  TasksView,
} from "./work-views";

type CrmAppProps = {
  initialData: DashboardData;
  operator: { displayName: string; email: string };
};

const viewTitles: Record<NavView, string> = {
  inbox: "Réception",
  contacts: "Contacts",
  pipeline: "Pipeline",
  projects: "Projets",
  tasks: "Tâches",
  settings: "Paramètres",
};

export function CrmApp({ initialData, operator }: CrmAppProps) {
  const [data, setData] = useState(initialData);
  const [activeView, setActiveView] = useState<NavView>("inbox");
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
  const [contextOpen, setContextOpen] = useState(false);
  const contextTriggerRef = useRef<HTMLButtonElement>(null);
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
  const unreadCount = data.mailboxes.reduce((sum, mailbox) => sum + mailbox.unreadCount, 0);
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
    setData((current) => ({
      ...current,
      deals: current.deals.map((deal) => (deal.id === id ? { ...deal, ...patch } : deal)),
    }));
    if (currentIsLive(data)) {
      void fetch(`/api/deals/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
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
          completed: false,
          dealId: deal.id,
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
          dueAt: deal.nextActionDate || undefined,
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
  }

  async function sendMessage(payload: Record<string, string>) {
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
            <h1>{viewTitles[activeView]}</h1>
            {syncMessage ? <p role="status">{syncMessage}</p> : null}
          </div>
          {activeView === "inbox" ? (
            <button className="primary-action" type="button" onClick={() => setComposeOpen(true)}>
              <Icon name="compose" /> Nouveau courriel
            </button>
          ) : null}
          {activeView === "pipeline" ? (
            <button className="primary-action" type="button" onClick={() => {
              setActiveView("inbox");
              setComposeOpen(true);
            }}>
              <Icon name="compose" /> Nouveau courriel
            </button>
          ) : null}
        </header>

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
                    ? sendMessage({
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
              onOpenConversation={() => {
                if (!selectedPipelineDeal) return;
                setSelectedConversationId(selectedPipelineDeal.conversationId);
                setActiveView("inbox");
                setMobileThreadOpen(true);
              }}
            />
          </div>
        ) : null}

        {activeView === "contacts" ? <ContactsView contacts={data.contacts} /> : null}
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
          />
        ) : null}
      </main>

      <nav className="mobile-nav" aria-label="Navigation mobile">
        {(
          [
            ["inbox", "Réception", "inbox"],
            ["contacts", "Contacts", "contacts"],
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
    </div>
  );
}

function currentIsLive(data: DashboardData) {
  return data.live;
}

async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData | null> {
  const response = await fetch("/api/dashboard", {
    headers: { accept: "application/json" },
    signal,
  });
  if (!response.ok) return null;
  return (await response.json()) as DashboardData;
}
