import assert from "node:assert/strict";
import test from "node:test";

import {
  defaultComposeMailbox,
  filterInboxConversations,
  inboxEmptyState,
  resolveVisibleConversation,
  transitionConversationUnreadState,
} from "../lib/mail-ui-state.ts";

const mailboxes = [
  { address: "bonjour@27pm.org", label: "Prospects et clients", kind: "sales", unreadCount: 1 },
  { address: "alexis@27pm.org", label: "Alexis Boulet", kind: "sales", unreadCount: 0 },
  { address: "admin@27pm.org", label: "Comptes et opérations", kind: "operations", unreadCount: 0 },
];

function conversation(overrides) {
  return {
    id: "conversation-1",
    mailboxAddress: "bonjour@27pm.org",
    contactId: "contact-1",
    contactName: "Marie Tremblay",
    contactEmail: "marie@example.com",
    organization: "Atelier Boréal",
    subject: "Refonte du site",
    preview: "Bonjour Alexis",
    updatedLabel: "09:35",
    unread: true,
    followUp: false,
    messages: [],
    dealId: null,
    ...overrides,
  };
}

test("filters mailbox, state, and normalized search before resolving a thread", () => {
  const conversations = [
    conversation({ id: "visible" }),
    conversation({ id: "other-mailbox", mailboxAddress: "alexis@27pm.org" }),
    conversation({ id: "read", unread: false }),
  ];
  const visible = filterInboxConversations({
    conversations,
    filter: "unread",
    mailboxAddress: "bonjour@27pm.org",
    search: " atelier ",
  });

  assert.deepEqual(visible.map(({ id }) => id), ["visible"]);
  assert.equal(resolveVisibleConversation(visible, "other-mailbox")?.id, "visible");
  assert.equal(resolveVisibleConversation([], "visible"), null);
});

test("search includes the full contact email", () => {
  const visible = filterInboxConversations({
    conversations: [conversation({})],
    filter: "all",
    mailboxAddress: "bonjour@27pm.org",
    search: "MARIE@EXAMPLE.COM",
  });
  assert.equal(visible.length, 1);
});

test("keeps the just-opened conversation visible after marking it read", () => {
  const visible = filterInboxConversations({
    conversations: [
      conversation({ id: "opened", unread: false }),
      conversation({ id: "still-unread", unread: true }),
    ],
    filter: "unread",
    mailboxAddress: "bonjour@27pm.org",
    pinnedConversationId: "opened",
    search: "",
  });

  assert.deepEqual(visible.map(({ id }) => id), ["opened", "still-unread"]);
});

test("updates the conversation and its mailbox unread count atomically", () => {
  const read = transitionConversationUnreadState({
    conversations: [conversation({})],
    mailboxes,
    conversationId: "conversation-1",
    unread: false,
  });

  assert.equal(read.conversations[0].unread, false);
  assert.equal(read.mailboxes[0].unreadCount, 0);
  assert.equal(read.mailboxes[1].unreadCount, 0);

  const rolledBack = transitionConversationUnreadState({
    conversations: read.conversations,
    mailboxes: read.mailboxes,
    conversationId: "conversation-1",
    unread: true,
  });

  assert.equal(rolledBack.conversations[0].unread, true);
  assert.equal(rolledBack.mailboxes[0].unreadCount, 1);
});

test("compose prefers the selected sales mailbox and never defaults to operations", () => {
  assert.equal(defaultComposeMailbox(mailboxes, "alexis@27pm.org"), "alexis@27pm.org");
  assert.equal(defaultComposeMailbox(mailboxes, "admin@27pm.org"), "bonjour@27pm.org");
});

test("empty-state copy distinguishes search, unread, follow-up, and empty mailbox", () => {
  assert.equal(inboxEmptyState({ filter: "all", mailboxLabel: "Alexis", search: "nord" }).title, "Aucun résultat.");
  assert.equal(inboxEmptyState({ filter: "unread", mailboxLabel: "Alexis", search: "" }).title, "Aucun message non lu.");
  assert.equal(inboxEmptyState({ filter: "follow-up", mailboxLabel: "Alexis", search: "" }).title, "Aucun suivi en attente.");
  assert.equal(inboxEmptyState({ filter: "all", mailboxLabel: "Alexis", search: "" }).title, "Aucune conversation ici.");
});
