import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ContextRail } from "../app/components/context-rail.tsx";
import { ThreadView } from "../app/components/thread-view.tsx";

const conversation = {
  id: "conversation-mobile",
  mailboxAddress: "bonjour@27pm.org",
  contactId: "contact-mobile",
  contactName: "Marie Mobile",
  contactEmail: "marie@example.com",
  organization: "Atelier Mobile",
  subject: "Contexte mobile",
  preview: "Test",
  updatedLabel: "09:35",
  unread: false,
  followUp: false,
  dealId: "deal-mobile",
  messages: [],
};

test("connects the thread trigger to the expanded context sheet", () => {
  const thread = renderToStaticMarkup(
    createElement(ThreadView, {
      conversation,
      sendEnabled: false,
      contextOpen: true,
      contextTriggerRef: null,
      onBack() {},
      onOpenContext() {},
      async onSend() {
        return false;
      },
    }),
  );
  const context = renderToStaticMarkup(
    createElement(ContextRail, {
      id: "conversation-context",
      contact: {
        id: "contact-mobile",
        name: "Marie Mobile",
        email: "marie@example.com",
        organization: "Atelier Mobile",
        source: "Courriel",
        status: "Prospect",
        conversationCount: 1,
      },
      deal: {
        id: "deal-mobile",
        contactId: "contact-mobile",
        conversationId: "conversation-mobile",
        title: "Atelier Mobile",
        contactName: "Marie Mobile",
        organization: "Atelier Mobile",
        projectType: "Site web",
        stage: "nouveau",
        source: "Courriel",
        nextAction: "Planifier l’appel",
        nextActionDate: "2026-08-26",
        note: "Prioritaire",
      },
      open: true,
      mobileSheet: true,
      onClose() {},
      onDealChange() {},
      onAddTask() {},
    }),
  );

  assert.match(thread, /class="thread-context-action"/u);
  assert.match(thread, /aria-controls="conversation-context"/u);
  assert.match(thread, /aria-expanded="true"/u);
  assert.match(context, /id="conversation-context"/u);
  assert.match(context, /aria-label="Fermer le contexte"/u);
  assert.match(context, /Étape du pipeline/u);
  assert.match(context, /Prochaine action/u);
  assert.match(context, /Type de projet/u);
  assert.match(context, /Ajouter une tâche/u);
});

test("keeps the mobile context trigger and 44px workflow controls visible", async () => {
  const [css, contextRail, crmApp] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/components/context-rail.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/crm-app.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(css, /thread-actions button:nth-child\(-n \+ 2\)/u);
  assert.match(
    css,
    /\.thread-reply-action\s*\{\s*display:\s*none;/u,
  );
  assert.match(
    css,
    /\.thread-context-action\s*\{\s*flex:\s*0 0 2\.75rem;/u,
  );
  assert.doesNotMatch(
    css,
    /context-rail\[data-mobile-sheet\][^{]*\.context-action\s*\{\s*display:\s*none;/u,
  );
  assert.match(
    css,
    /\.context-rail\[data-mobile-sheet\] \.context-action button\s*\{\s*min-height:\s*2\.75rem;/u,
  );
  assert.match(contextRail, /closeButtonRef\.current\?\.focus\(\)/u);
  assert.match(contextRail, /event\.key !== "Escape"/u);
  assert.match(crmApp, /contextTriggerRef\.current\.focus\(\)/u);
});
