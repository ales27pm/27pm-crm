import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";

import { ThreadView } from "../app/components/thread-view.tsx";
import {
  DELIVERY_PRESENTATION,
  OUTBOUND_DELIVERY_STATES,
} from "../lib/mailgun-lifecycle.ts";

const timestamp = "2026-08-25T13:35:04.000Z";

function conversationWith(messages) {
  return {
    id: "conversation-test",
    mailboxAddress: "bonjour@27pm.org",
    contactId: "contact-test",
    contactName: "Marie Test",
    contactEmail: "marie@example.com",
    organization: "Atelier Test",
    subject: "Cycle de livraison",
    preview: "Test",
    updatedLabel: "09:35",
    unread: false,
    followUp: false,
    dealId: "deal-test",
    messages,
  };
}

function renderThread(messages, contextOpen = false) {
  return renderToStaticMarkup(
    createElement(ThreadView, {
      conversation: conversationWith(messages),
      sendEnabled: false,
      contextOpen,
      contextTriggerRef: null,
      onBack() {},
      onOpenContext() {},
      async onSend() {
        return false;
      },
    }),
  );
}

test("renders every delivery state with timestamp and operator guidance", () => {
  const messages = OUTBOUND_DELIVERY_STATES.map((state, index) => ({
    id: `message-${state}`,
    direction: "outbound",
    senderName: "27PM",
    senderEmail: "bonjour@27pm.org",
    recipientLabel: "Marie Test",
    sentAt: `09:${35 + index}`,
    sentAtIso: timestamp,
    body: `Message ${state}`,
    deliveryState: state,
    deliveryEvents: [
      {
        state,
        occurredAt: timestamp,
        occurredLabel: `09:${35 + index}`,
      },
    ],
  }));

  const html = renderThread(messages);

  for (const state of OUTBOUND_DELIVERY_STATES) {
    assert.match(html, new RegExp(`data-state="${state}"`, "u"));
    assert.ok(html.includes(DELIVERY_PRESENTATION[state].label));
    assert.ok(html.includes(DELIVERY_PRESENTATION[state].guidance));
  }
  assert.match(html, /dateTime="2026-08-25T13:35:04.000Z"/u);
  assert.equal((html.match(/class="delivery-status"/gu) ?? []).length, 6);
});

test("renders an accepted-to-delivered event history without marking inbound mail", () => {
  const html = renderThread([
    {
      id: "message-inbound",
      direction: "inbound",
      senderName: "Marie Test",
      senderEmail: "marie@example.com",
      recipientLabel: "bonjour@27pm.org",
      sentAt: "09:34",
      sentAtIso: "2026-08-25T13:34:00.000Z",
      body: "Bonjour",
      deliveryState: "received",
      deliveryEvents: [],
    },
    {
      id: "message-outbound",
      direction: "outbound",
      senderName: "27PM",
      senderEmail: "bonjour@27pm.org",
      recipientLabel: "Marie Test",
      sentAt: "09:35",
      sentAtIso: "2026-08-25T13:35:00.000Z",
      body: "Réponse",
      deliveryState: "delivered",
      deliveryEvents: [
        {
          state: "accepted",
          occurredAt: "2026-08-25T13:35:00.000Z",
          occurredLabel: "09:35:00",
        },
        {
          state: "delivered",
          occurredAt: timestamp,
          occurredLabel: "09:35:04",
        },
      ],
    },
  ]);

  assert.match(html, /Voir l’historique de livraison \(2\)/u);
  assert.match(html, /aria-label="Historique de livraison"/u);
  assert.equal((html.match(/class="delivery-status"/gu) ?? []).length, 1);
});
