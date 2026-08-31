import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { AccountsView } from "../app/components/account-workspace.tsx";

const account = (id, name, overrides = {}) => ({
  id,
  name,
  website: `https://${id}.example`,
  sourceLabel: "Document utilisateur",
  sourceUrl: null,
  sourceDate: "2026-08-29",
  score: 92,
  priority: "high",
  budgetMinCents: 250000,
  budgetMaxCents: 500000,
  budgetIsHypothesis: true,
  ownerEmail: "owner@27pm.org",
  doNotContact: false,
  lastContactAt: null,
  nextFollowUpAt: "2026-09-02T12:00:00.000Z",
  nextStep: "Valider le rôle décisionnaire",
  notes: "Compte prioritaire",
  contactCount: 1,
  ...overrides,
});

test("renders one isolated account 360 workspace with its commercial context", () => {
  const markup = renderToStaticMarkup(
    createElement(AccountsView, {
      organizations: [
        account("atelier", "Atelier Exemple"),
        account("ailleurs", "Entreprise Ailleurs", { score: 74 }),
        account("atelier-homonyme", "Atelier Exemple", { score: 70 }),
      ],
      contacts: [
        {
          id: "contact-atelier",
          name: "Alex Tremblay",
          email: "alex@atelier.example",
          phone: "",
          organization: "Atelier Exemple",
          organizationId: "atelier",
          role: "Direction",
          status: "Vérifié",
          doNotContact: false,
          unsubscribed: false,
          doNotCall: false,
          lastContactAt: null,
          nextFollowUpAt: null,
        },
        {
          id: "contact-ailleurs",
          name: "Personne Ailleurs",
          email: "ailleurs@autre.example",
          organization: "Atelier Exemple",
          organizationId: "ailleurs",
          role: "Direction",
          status: "Vérifié",
        },
        {
          id: "contact-ambigu",
          name: "Contact Ambigu",
          email: "ambigu@atelier.example",
          organization: "Atelier Exemple",
          organizationId: "",
          role: "Direction",
          status: "À valider",
        },
      ],
      deals: [
        {
          id: "deal-atelier",
          organizationId: "atelier",
          contactId: "contact-atelier",
          conversationId: "conversation-atelier",
          title: "Refonte Atelier",
          contactName: "Alex Tremblay",
          organization: "Atelier Exemple",
          projectType: "Site web",
          stage: "qualifie",
          source: "Document utilisateur",
          nextAction: "Préparer le cadrage",
          nextActionDate: "2026-09-02",
          note: "",
          interactions: [
            {
              id: "interaction-atelier",
              kind: "meeting",
              summary: "Besoins et échéancier confirmés.",
              occurredAt: "2026-08-30T13:00:00.000Z",
              occurredLabel: "30 août",
              createdBy: "owner@27pm.org",
            },
          ],
        },
        {
          id: "deal-ailleurs",
          organizationId: "ailleurs",
          contactId: "contact-ailleurs",
          conversationId: "conversation-ailleurs",
          title: "Projet secret ailleurs",
          contactName: "Personne Ailleurs",
          organization: "Entreprise Ailleurs",
          projectType: "Application",
          stage: "nouveau",
          source: "Autre",
          nextAction: "Attendre",
          nextActionDate: "",
          note: "",
          interactions: [],
        },
      ],
      tasks: [
        {
          id: "task-atelier",
          title: "Relancer Atelier Exemple",
          dueLabel: "En retard",
          dueAt: "2026-08-29T12:00:00.000Z",
          overdue: true,
          completed: false,
          dealId: "deal-atelier",
          conversationId: "conversation-atelier",
          organizationId: "atelier",
          organization: "Atelier Exemple",
        },
        {
          id: "task-conversation-atelier",
          title: "Relance liée à la conversation",
          dueLabel: "Demain",
          dueAt: "2026-09-01T12:00:00.000Z",
          overdue: false,
          completed: false,
          dealId: null,
          conversationId: "conversation-sans-deal",
          organizationId: "atelier",
          organization: "Atelier Exemple",
        },
      ],
      intakes: [
        {
          id: "intake-test",
          organizationName: "Demande Test",
          contactName: "Test",
          contactEmail: "test@example.invalid",
          projectType: "site",
          message: "Demande synthétique",
          createdAt: "2026-08-30T13:00:00.000Z",
          createdLabel: "Aujourd’hui",
        },
      ],
      onEdit() {},
      onAddContact() {},
      onEditContact() {},
      onReviewIntake() {},
      onOpenDeal() {},
      onToggleTask() {},
    }),
  );

  assert.match(markup, /aria-label="Espace de travail des comptes"/u);
  assert.match(markup, /Fiche entreprise/u);
  assert.match(markup, /À faire maintenant/u);
  assert.match(markup, /alex@atelier\.example/u);
  assert.match(markup, /Refonte Atelier/u);
  assert.match(markup, /Relancer Atelier Exemple/u);
  assert.match(markup, /Relance liée à la conversation/u);
  assert.match(markup, /Besoins et échéancier confirmés\./u);
  assert.match(markup, /Ouvrir dans le pipeline/u);
  assert.match(markup, /Demandes publiques en attente/u);
  assert.doesNotMatch(markup, /ailleurs@autre\.example/u);
  assert.doesNotMatch(markup, /ambigu@atelier\.example/u);
  assert.doesNotMatch(markup, /Projet secret ailleurs/u);
});

test("connects the account 360 workspace to CRM data and responsive layout", async () => {
  const [app, dashboardRoute, css] = await Promise.all([
    readFile(new URL("../app/components/crm-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(app, /deals=\{data\.deals\}/u);
  assert.match(app, /tasks=\{data\.tasks\}/u);
  assert.match(app, /onOpenDeal=/u);
  assert.match(app, /onToggleTask=\{toggleTask\}/u);
  assert.match(dashboardRoute, /const auth = requireOperatorRequest\(request\);[\s\S]*if \(auth\.response\) return auth\.response;[\s\S]*CRM_DEMO_MODE/u);
  assert.match(dashboardRoute, /Response\.json\(demoDashboard,[\s\S]*cache-control["']:\s*["']no-store/u);
  assert.match(dashboardRoute, /task\.conversation_id AS conversationId[\s\S]*COALESCE\(deal\.organization_id, contact\.organization_id\) AS organizationId/u);
  assert.match(css, /\.account-v2-layout/u);
  assert.match(css, /grid-template-columns:\s*minmax\(18rem, 22rem\) minmax\(0, 1fr\)/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.account-v2-summary\s*\{[\s\S]*grid-template-columns:\s*repeat\(4/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.account-v2-layout\s*\{[\s\S]*display:\s*block/u);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*\.account-master\s*\{[\s\S]*max-height:\s*14\.5rem/u);
});
