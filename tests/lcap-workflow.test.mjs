import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { AccountsView } from "../app/components/account-workspace.tsx";
import { ContactDialog } from "../app/components/contact-dialog.tsx";

test("account workspace exposes every authoritative LCAP blocker and both correction paths", () => {
  const markup = renderToStaticMarkup(createElement(AccountsView, {
    organizations: [account()],
    contacts: [contact()],
    deals: [],
    tasks: [],
    strategies: [strategy()],
    intakes: [],
    onEdit() {},
    onAddContact() {},
    onEditContact() {},
    onReviewIntake() {},
    onOpenDeal() {},
    onToggleTask() {},
    onOpenComplianceSettings() {},
  }));

  assert.match(markup, /Validation LCAP requise/u);
  assert.match(markup, /Le fondement LCAP n’est pas documenté/u);
  assert.match(markup, /L’identité complète de l’expéditeur doit être configurée/u);
  assert.match(markup, /Réviser ce contact/u);
  assert.match(markup, /Ouvrir les paramètres de conformité/u);
  assert.doesNotMatch(markup, />Envoyer</u);
});

test("contact dialog explains the current server decision and saves without authorizing a send", () => {
  const markup = renderToStaticMarkup(createElement(ContactDialog, {
    account: account(),
    contact: contact(),
    open: true,
    onClose() {},
    async onSaved() {},
  }));

  assert.match(markup, /Dossier LCAP à compléter/u);
  assert.match(markup, /Le fondement LCAP n’est pas documenté/u);
  assert.match(markup, /Source et preuve/u);
  assert.match(markup, /Fondement déclaré/u);
  assert.match(markup, /Enregistrer sans autoriser d’envoi/u);
  assert.doesNotMatch(markup, />Envoyer</u);
});

test("a strategy without a contact offers a real correction path", () => {
  const missingContactStrategy = {
    ...strategy(),
    contactId: null,
    contactName: null,
    contactEmail: null,
    emailBlockReasons: ["strategy_contact_missing"],
  };
  const markup = renderToStaticMarkup(createElement(AccountsView, {
    organizations: [account()],
    contacts: [contact()],
    deals: [],
    tasks: [],
    strategies: [missingContactStrategy],
    intakes: [],
    onEdit() {},
    onAddContact() {},
    onEditContact() {},
    onReviewIntake() {},
    onOpenDeal() {},
    onToggleTask() {},
  }));

  assert.match(markup, /Choisir un contact/u);
  assert.doesNotMatch(markup, />Envoyer</u);
});

test("dashboard contact status is derived from the central readiness engine instead of a local heuristic", async () => {
  const dashboard = await readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8");
  const readiness = await readFile(new URL("../lib/outreach-readiness.ts", import.meta.url), "utf8");
  assert.match(dashboard, /evaluateOutreachChannels/u);
  assert.match(dashboard, /emailReady:\s*readiness\?\.allowed/u);
  assert.match(dashboard, /emailBlockReasons:\s*readiness\?\.reasons/u);
  assert.doesNotMatch(dashboard, /contact\.validatedAt && contact\.emailStatus === "valid"/u);
  assert.match(readiness, /loadAllContactCompliance/u);
  assert.doesNotMatch(readiness, /Promise\.all\(uniqueContactIds\.map/u);
});

function account() {
  return {
    id: "org-1",
    name: "Entreprise Exemple",
    website: "https://example.com",
    sourceLabel: "Document utilisateur",
    sourceUrl: null,
    sourceDate: "2026-08-29",
    score: 90,
    priority: "high",
    budgetMinCents: null,
    budgetMaxCents: null,
    budgetIsHypothesis: true,
    ownerEmail: null,
    doNotContact: false,
    lastContactAt: null,
    nextFollowUpAt: null,
    nextStep: "Valider le contact",
    notes: "",
    contactCount: 1,
  };
}

function contact() {
  return {
    id: "contact-1",
    name: "Personne Exemple",
    email: "person@example.com",
    phone: "",
    organization: "Entreprise Exemple",
    organizationId: "org-1",
    role: "Direction",
    source: "Page officielle",
    sourceUrl: "https://example.com/contact",
    sourceDate: "2026-08-29",
    contactBasis: "unknown",
    roleRelevance: "relevant",
    roleRelevanceDetail: "Responsable des services numériques concernés.",
    personalDataCategory: "work_contact",
    qualificationMode: "manual",
    provenanceType: "recipient_published",
    evidenceRef: "capture:source",
    lawfulBasis: "none",
    basisEvidenceRef: null,
    basisVerifiedBy: null,
    basisVerifiedAt: null,
    basisExpiresAt: null,
    publicationByRecipient: false,
    publicationNoRestriction: false,
    publicationRoleRelevance: "",
    directDisclosureNoRestriction: false,
    b2bRelationshipEvidence: "",
    b2bMessageRelevance: "",
    phoneEvidenceRef: null,
    recipientTimezone: null,
    dnclCheckedAt: null,
    dnclEvidenceRef: null,
    dnclStatus: "not_applicable",
    emailStatus: "unknown",
    unsubscribed: false,
    doNotCall: false,
    doNotContact: false,
    lastContactAt: null,
    nextFollowUpAt: null,
    validated: true,
    status: "LCAP à valider",
    emailReady: false,
    emailBlockReasons: ["email_lawful_basis_missing", "sender_identity_incomplete"],
    emailEvaluatedAt: "2026-08-31T14:00:00.000Z",
    conversationCount: 0,
  };
}

function strategy() {
  return {
    id: "strategy-1",
    organizationId: "org-1",
    organization: "Entreprise Exemple",
    contactId: "contact-1",
    contactName: "Personne Exemple",
    contactEmail: "person@example.com",
    version: 1,
    status: "draft",
    objective: "Préparer une discussion exploratoire.",
    targetName: "Personne Exemple",
    targetRole: "Direction",
    valueProposition: "Audit ciblé.",
    openingAngle: "Montrer une occasion précise.",
    timingRationale: "Signal à valider.",
    contactResearchNotes: "Fondement à confirmer.",
    recommendedStartAt: "2026-09-02T13:30:00.000Z",
    recipientTimezone: "America/Toronto",
    researchSource: "Page officielle",
    researchSourceUrl: "https://example.com/contact",
    researchCapturedAt: "2026-08-30T12:00:00.000Z",
    emailReady: false,
    emailBlockReasons: [
      "email_lawful_basis_missing",
      "email_basis_proof_incomplete",
      "sender_identity_incomplete",
      "unsubscribe_mechanism_incomplete",
    ],
    steps: [{
      id: "step-1",
      sequenceIndex: 0,
      businessDayOffset: 0,
      actionType: "email",
      title: "Premier courriel personnalisé",
      purpose: "Présenter un angle précis.",
      requiresContact: true,
      status: "blocked",
      scheduledAt: "2026-09-02T13:30:00.000Z",
      scheduledLabel: "2 septembre",
      completedAt: null,
    }],
  };
}
