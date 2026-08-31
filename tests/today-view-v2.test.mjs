import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { TodayView } from "../app/components/today-view.tsx";
import { buildTodayDashboard } from "../app/today-dashboard.ts";

const now = new Date("2026-08-30T16:00:00.000Z");

function dashboard(overrides = {}) {
  return {
    mailboxes: [],
    transportState: "configuration",
    live: false,
    organizations: [
      {
        id: "org-due",
        name: "Atelier Exemple",
        doNotContact: false,
        nextFollowUpAt: "2026-08-30T18:00:00.000Z",
        nextStep: "Valider le besoin",
      },
      {
        id: "org-blocked",
        name: "Compte bloqué",
        doNotContact: true,
        nextFollowUpAt: "2026-08-29T18:00:00.000Z",
        nextStep: "Ne pas relancer",
      },
      {
        id: "org-plan",
        name: "Cohorte prioritaire",
        doNotContact: false,
        priority: "very_high",
        score: 96,
        nextFollowUpAt: null,
        nextStep: "Identifier un rôle professionnel pertinent",
      },
    ],
    contacts: [],
    conversations: [
      {
        id: "conversation-unread",
        unread: true,
        subject: "Demande entrante",
        contactName: "Alex Tremblay",
        organization: "Atelier Exemple",
        updatedLabel: "10:15",
        dealId: "deal-overdue",
        messages: [{ sentAtIso: "2026-08-30T14:15:00.000Z" }],
      },
      {
        id: "conversation-read",
        unread: false,
        subject: "Déjà traité",
        contactName: "Camille Roy",
        organization: "Autre",
        updatedLabel: "Hier",
        dealId: null,
        messages: [],
      },
    ],
    deals: [
      {
        id: "deal-overdue",
        organizationId: "org-due",
        organization: "Atelier Exemple",
        title: "Refonte Atelier",
        stage: "qualifie",
        nextAction: "Préparer le cadrage",
        nextActionDate: "2026-08-29",
      },
      {
        id: "deal-unplanned",
        organizationId: "org-due",
        organization: "Atelier Exemple",
        title: "Portail sans prochaine date",
        stage: "nouveau",
        nextAction: "Clarifier la portée",
        nextActionDate: "",
      },
      {
        id: "deal-upcoming",
        organizationId: "org-due",
        organization: "Atelier Exemple",
        title: "Application planifiée",
        stage: "proposition",
        nextAction: "Présenter la proposition",
        nextActionDate: "2026-09-02",
      },
      {
        id: "deal-won",
        organizationId: "org-due",
        organization: "Atelier Exemple",
        title: "Projet gagné",
        stage: "gagne",
        nextAction: "Démarrer",
        nextActionDate: "2026-08-29",
      },
    ],
    tasks: [
      {
        id: "task-overdue",
        title: "Relancer Atelier Exemple",
        dueLabel: "Hier",
        dueAt: "2026-08-29T12:00:00.000Z",
        overdue: false,
        completed: false,
        dealId: "deal-overdue",
        conversationId: "conversation-unread",
        organizationId: "org-due",
        organization: "Atelier Exemple",
      },
      {
        id: "task-complete",
        title: "Tâche terminée",
        dueLabel: "Hier",
        dueAt: "2026-08-29T12:00:00.000Z",
        overdue: true,
        completed: true,
        dealId: null,
        conversationId: null,
        organizationId: "org-due",
        organization: "Atelier Exemple",
      },
    ],
    intakes: [
      {
        id: "intake-latest",
        organizationName: "Nouvelle demande",
        contactName: "Morgan Test",
        contactEmail: "morgan@example.invalid",
        projectType: "site",
        message: "Besoin d’une refonte.",
        createdAt: "2026-08-30T15:00:00.000Z",
        createdLabel: "Aujourd’hui",
      },
    ],
    activities: [],
    ...overrides,
  };
}

test("builds a deterministic Today cockpit without promoting blocked or won follow-ups", () => {
  const snapshot = buildTodayDashboard(dashboard(), now);

  assert.deepEqual(snapshot.pendingIntakes.map((item) => item.id), ["intake-latest"]);
  assert.deepEqual(snapshot.overdueTasks.map((item) => item.id), ["task-overdue"]);
  assert.deepEqual(snapshot.unreadConversations.map((item) => item.id), ["conversation-unread"]);
  assert.deepEqual(snapshot.dueFollowUps.map((item) => `${item.kind}:${item.id}`), [
    "organization:org-due",
  ]);
  assert.deepEqual(snapshot.atRiskDeals.map((item) => item.id), [
    "deal-overdue",
    "deal-unplanned",
  ]);
  assert.deepEqual(snapshot.upcomingDeals.map((item) => item.id), ["deal-upcoming"]);
  assert.deepEqual(snapshot.accountsToPlan.map((item) => item.id), ["org-plan"]);
  assert.equal(snapshot.actionCount, 5);
  assert.equal(snapshot.riskCount, 3);
});

test("uses Montreal civil dates, rejects invalid planning dates and keeps stable ordering", () => {
  const lateEveningMontreal = new Date("2026-08-31T03:30:00.000Z");
  const data = dashboard({
    organizations: [],
    conversations: [],
    intakes: [
      { id: "intake-b", createdAt: "2026-08-30T12:00:00.000Z" },
      { id: "intake-a", createdAt: "2026-08-30T12:00:00.000Z" },
      { id: "intake-old", createdAt: "2026-08-29T12:00:00.000Z" },
    ],
    deals: [
      {
        id: "deal-today",
        organizationId: "",
        organization: "Montréal",
        title: "Échéance civile",
        stage: "qualifie",
        nextAction: "Faire le suivi",
        nextActionDate: "2026-08-30",
      },
      {
        id: "deal-invalid",
        organizationId: "",
        organization: "Montréal",
        title: "Date invalide",
        stage: "nouveau",
        nextAction: "Planifier",
        nextActionDate: "2026-02-31",
      },
    ],
    tasks: [
      {
        id: "task-before-now",
        dueAt: "2026-08-31T03:00:00.000Z",
        overdue: false,
        completed: false,
        dealId: null,
      },
      {
        id: "task-after-now",
        dueAt: "2026-08-31T04:00:00.000Z",
        overdue: false,
        completed: false,
        dealId: null,
      },
    ],
  });

  const snapshot = buildTodayDashboard(data, lateEveningMontreal);
  assert.deepEqual(snapshot.pendingIntakes.map((item) => item.id), [
    "intake-old", "intake-a", "intake-b",
  ]);
  assert.deepEqual(snapshot.overdueTasks.map((item) => item.id), ["task-before-now"]);
  assert.deepEqual(snapshot.dueFollowUps.map((item) => item.id), ["deal-today"]);
  assert.deepEqual(snapshot.atRiskDeals.map((item) => item.id), ["deal-invalid"]);
  assert.deepEqual(snapshot.upcomingDeals, []);
});

test("counts one normal account follow-up once, preferring task over deal over organization", () => {
  const normalFlow = dashboard({
    organizations: [
      {
        id: "org-normal",
        name: "Compte normal",
        doNotContact: false,
        priority: "high",
        score: 88,
        nextFollowUpAt: "2026-08-29T12:00:00.000Z",
        nextStep: "Faire le suivi",
      },
    ],
    conversations: [],
    intakes: [],
    deals: [
      {
        id: "deal-normal",
        organizationId: "org-normal",
        organization: "Compte normal",
        title: "Projet normal",
        stage: "qualifie",
        nextAction: "Faire le suivi",
        nextActionDate: "2026-08-29",
      },
    ],
    tasks: [
      {
        id: "task-normal",
        title: "Faire le suivi",
        dueAt: "2026-08-29T12:00:00.000Z",
        overdue: true,
        completed: false,
        dealId: "deal-normal",
        organizationId: "org-normal",
      },
    ],
  });
  const taskFirst = buildTodayDashboard(normalFlow, now);
  assert.deepEqual(taskFirst.overdueTasks.map((item) => item.id), ["task-normal"]);
  assert.deepEqual(taskFirst.dueFollowUps, []);
  assert.deepEqual(taskFirst.accountsToPlan, []);
  assert.equal(taskFirst.actionCount, 1);

  const organizationOnly = buildTodayDashboard(
    dashboard({
      organizations: [
        {
          id: "org-only",
          name: "Compte sans action",
          doNotContact: false,
          priority: "normal",
          score: 60,
          nextFollowUpAt: "2026-08-30T12:00:00.000Z",
          nextStep: null,
        },
      ],
      conversations: [], deals: [], tasks: [], intakes: [],
    }),
    now,
  );
  assert.deepEqual(organizationOnly.dueFollowUps.map((item) => item.id), ["org-only"]);
  assert.deepEqual(organizationOnly.accountsToPlan, []);
  assert.equal(organizationOnly.actionCount, 1);
});

test("renders actionable priorities and a calm empty state", () => {
  const markup = renderToStaticMarkup(
    createElement(TodayView, {
      data: dashboard(),
      operatorName: "Alex",
      now,
      onOpenAccounts() {},
      onOpenConversation() {},
      onOpenDeal() {},
      onOpenTasks() {},
      onToggleTask() {},
    }),
  );

  assert.match(markup, /aria-label="Cockpit Aujourd’hui"/u);
  assert.match(markup, /Bonjour Alex/u);
  assert.match(markup, /File du jour/u);
  assert.match(markup, /Nouvelle demande/u);
  assert.match(markup, /Relancer Atelier Exemple/u);
  assert.match(markup, /Demande entrante/u);
  assert.match(markup, /Préparer le cadrage/u);
  assert.match(markup, /Pipeline à surveiller/u);
  assert.match(markup, /Portail sans prochaine date/u);
  assert.match(markup, /Relances planifiées/u);
  assert.match(markup, /Application planifiée/u);
  assert.match(markup, /Cohorte prioritaire/u);
  assert.match(markup, /Marquer « Relancer Atelier Exemple » terminée/u);
  assert.doesNotMatch(markup, /Compte bloqué/u);
  assert.doesNotMatch(markup, /Projet gagné/u);

  const emptyMarkup = renderToStaticMarkup(
    createElement(TodayView, {
      data: dashboard({
        organizations: [], conversations: [], deals: [], tasks: [], intakes: [],
      }),
      operatorName: "Alex",
      now,
      onOpenAccounts() {},
      onOpenConversation() {},
      onOpenDeal() {},
      onOpenTasks() {},
      onToggleTask() {},
    }),
  );
  assert.match(emptyMarkup, /Tout est à jour/u);
});

test("connects Today as the default responsive CRM destination", async () => {
  const [app, today, sidebar, types, css] = await Promise.all([
    readFile(new URL("../app/components/crm-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/today-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/sidebar.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/crm-types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(types, /NavView\s*=\s*\|\s*"today"/u);
  assert.match(app, /useState<NavView>\("today"\)/u);
  assert.match(app, /activeView === "today"/u);
  assert.match(app, /<TodayView/u);
  assert.match(app, /data\.conversations\.filter\(\(conversation\) => conversation\.unread\)/u);
  assert.doesNotMatch(today, /api\/messages\/send/u);
  assert.match(sidebar, /id: "today", label: "Aujourd’hui"/u);
  assert.match(sidebar, /onNavigate\("today"\)/u);
  assert.match(css, /\.today-view/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.today-layout/u);
});
