import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { InboxRail } from "../app/components/inbox-rail.tsx";
import { ThreadView } from "../app/components/thread-view.tsx";

const mailbox = {
  address: "bonjour@27pm.org",
  label: "Prospects et clients",
  kind: "sales",
  unreadCount: 2,
};

const conversation = {
  id: "conversation-visible",
  mailboxAddress: mailbox.address,
  contactId: "contact-visible",
  contactName: "Marie Tremblay",
  contactEmail: "marie@example.com",
  organization: "Atelier Boréal",
  subject: "Refonte du site",
  preview: "Bonjour Alexis",
  updatedLabel: "09:35",
  unread: true,
  followUp: false,
  dealId: null,
  messages: [],
};

test("inbox exposes mailbox context, selected row, pressed filter, and local status", () => {
  const html = renderToStaticMarkup(createElement(InboxRail, {
    mailboxes: [mailbox],
    mailboxAddress: mailbox.address,
    conversations: [conversation],
    selectedId: conversation.id,
    filter: "unread",
    search: "",
    status: "Le message demeure non lu.",
    hiddenOnMobile: false,
    onMailboxChange() {},
    onFilterChange() {},
    onSearchChange() {},
    onSelect() {},
  }));

  assert.match(html, /Prospects et clients — bonjour@27pm\.org \(2 non lus\)/u);
  assert.match(html, /aria-pressed="true"/u);
  assert.match(html, /aria-current="true"/u);
  assert.match(html, /Le message demeure non lu\./u);
});

test("inbox empty state explains an active search instead of claiming the mailbox is empty", () => {
  const html = renderToStaticMarkup(createElement(InboxRail, {
    mailboxes: [mailbox],
    mailboxAddress: mailbox.address,
    conversations: [],
    selectedId: null,
    filter: "all",
    search: "introuvable",
    hiddenOnMobile: false,
    onMailboxChange() {},
    onFilterChange() {},
    onSearchChange() {},
    onSelect() {},
  }));

  assert.match(html, /Aucun résultat\./u);
  assert.doesNotMatch(html, /Les nouveaux messages apparaîtront/u);
});

test("thread shows the full sender address without marking every inbound message unread", () => {
  const html = renderToStaticMarkup(createElement(ThreadView, {
    conversation: {
      ...conversation,
      unread: false,
      messages: [{
        id: "message-inbound",
        direction: "inbound",
        senderName: "Marie Tremblay",
        senderEmail: "marie@example.com",
        recipientLabel: mailbox.address,
        sentAt: "09:35",
        sentAtIso: "2026-10-16T13:35:00.000Z",
        body: "Bonjour",
        deliveryState: "received",
        deliveryEvents: [],
      }],
    },
    sendEnabled: false,
    contextOpen: false,
    contextTriggerRef: null,
    onBack() {},
    onOpenContext() {},
    async onSend() {
      throw new Error("not called");
    },
  }));

  assert.match(html, /marie@example\.com/u);
  assert.doesNotMatch(html, /aria-label="Message reçu"/u);
  assert.match(html, /Envoi désactivé/u);
});

test("new compose reviews the exact payload before executing the frozen send", async () => {
  const [compose, app, thread, css] = await Promise.all([
    readFile(new URL("../app/components/compose-dialog.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/crm-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/thread-view.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  const submit = compose.indexOf("async function submit()");
  const review = compose.indexOf(
    "setConfirmation({ payload, localRepair: presentation.localRepair })",
    submit,
  );
  const confirm = compose.indexOf("function confirm()", review);
  const exactGuard = compose.indexOf(
    "sameComposePayload(currentPayload, confirmation.payload)",
    confirm,
  );
  const dispatch = compose.indexOf(
    "void dispatch(currentPayload, confirmation.localRepair)",
    exactGuard,
  );
  const send = compose.indexOf("executeFrozenSend({", dispatch);

  assert.ok(submit >= 0);
  assert.ok(review > submit);
  assert.ok(confirm > review);
  assert.ok(exactGuard > confirm);
  assert.ok(dispatch > exactGuard);
  assert.ok(send > dispatch);
  assert.doesNotMatch(compose.slice(submit, review), /executeFrozenSend/u);
  assert.match(compose, /aria-labelledby="compose-dialog-title"/u);
  assert.match(compose, /aria-labelledby="compose-confirmation-title"/u);
  assert.match(compose, /<dt>De<\/dt><dd>\{payload\.from\}<\/dd>/u);
  assert.match(compose, /<dt>À<\/dt><dd>\{payload\.to\}<\/dd>/u);
  assert.match(compose, /<dt>Objet<\/dt><dd>\{payload\.subject\}<\/dd>/u);
  assert.match(compose, /<pre>\{payload\.body\}<\/pre>/u);
  assert.match(compose, /Outils administratifs de délivrabilité/u);
  assert.match(app, /selectedMailboxAddress=\{mailboxAddress\}/u);

  assert.match(thread, /setAttachmentReloadToken\(\(current\) => current \+ 1\)/u);
  assert.match(thread, /Les pièces jointes sont indisponibles\./u);
  assert.match(thread, /Réessayer/u);

  assert.match(app, /transitionConversationUnreadState\(\{/u);
  assert.match(app, /conversationId: id,\s+unread: true,/u);
  assert.match(app, /setInboxStatus\(/u);
  assert.doesNotMatch(css, /\.message-attachments li\s*\{[^}]*border-radius:\s*0\.65rem/su);
  assert.doesNotMatch(css, /\.message-attachments button\s*\{[^}]*border-radius:\s*0\.45rem/su);
});
