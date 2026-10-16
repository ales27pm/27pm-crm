import type { Conversation, Mailbox } from "../app/crm-types";

export type InboxFilter = "all" | "unread" | "follow-up";

export const MAIL_SEND_DISABLED_REASON =
  "Envoi désactivé : le transport de courriel doit être opérationnel avant tout envoi ordinaire.";

type InboxSelection = {
  conversations: Conversation[];
  filter: InboxFilter;
  mailboxAddress: string;
  pinnedConversationId?: string | null;
  search: string;
};

export type InboxEmptyState = {
  description: string;
  title: string;
};

export function filterInboxConversations({
  conversations,
  filter,
  mailboxAddress,
  pinnedConversationId = null,
  search,
}: InboxSelection): Conversation[] {
  const query = search.trim().toLocaleLowerCase("fr-CA");
  return conversations.filter((conversation) => {
    if (conversation.mailboxAddress !== mailboxAddress) return false;
    const pinned = conversation.id === pinnedConversationId;
    if (filter === "unread" && !conversation.unread && !pinned) return false;
    if (filter === "follow-up" && !conversation.followUp && !pinned) return false;
    if (!query) return true;
    return [
      conversation.contactName,
      conversation.contactEmail,
      conversation.organization,
      conversation.subject,
      conversation.preview,
    ].some((value) => value.toLocaleLowerCase("fr-CA").includes(query));
  });
}

export function resolveVisibleConversation(
  conversations: Conversation[],
  selectedId: string | null,
): Conversation | null {
  return conversations.find((conversation) => conversation.id === selectedId) ??
    conversations[0] ??
    null;
}

export function defaultComposeMailbox(
  mailboxes: Mailbox[],
  selectedAddress: string,
): string {
  const salesMailboxes = mailboxes.filter((mailbox) => mailbox.kind === "sales");
  return salesMailboxes.find((mailbox) => mailbox.address === selectedAddress)?.address ??
    salesMailboxes[0]?.address ??
    "bonjour@27pm.org";
}

export function transitionConversationUnreadState({
  conversations,
  mailboxes,
  conversationId,
  unread,
}: {
  conversations: Conversation[];
  mailboxes: Mailbox[];
  conversationId: string;
  unread: boolean;
}): { conversations: Conversation[]; mailboxes: Mailbox[] } {
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation || conversation.unread === unread) {
    return { conversations, mailboxes };
  }

  const unreadDelta = unread ? 1 : -1;
  return {
    conversations: conversations.map((item) =>
      item.id === conversationId ? { ...item, unread } : item,
    ),
    mailboxes: mailboxes.map((mailbox) =>
      mailbox.address === conversation.mailboxAddress
        ? {
            ...mailbox,
            unreadCount: Math.max(0, mailbox.unreadCount + unreadDelta),
          }
        : mailbox,
    ),
  };
}

export function inboxEmptyState({
  filter,
  mailboxLabel,
  search,
}: {
  filter: InboxFilter;
  mailboxLabel: string;
  search: string;
}): InboxEmptyState {
  if (search.trim()) {
    return {
      title: "Aucun résultat.",
      description: `Aucune conversation dans ${mailboxLabel} ne correspond à cette recherche.`,
    };
  }
  if (filter === "unread") {
    return {
      title: "Aucun message non lu.",
      description: `Tous les messages de ${mailboxLabel} ont été consultés.`,
    };
  }
  if (filter === "follow-up") {
    return {
      title: "Aucun suivi en attente.",
      description: `Aucune conversation de ${mailboxLabel} n’est marquée à suivre.`,
    };
  }
  return {
    title: "Aucune conversation ici.",
    description: `Les nouveaux messages reçus dans ${mailboxLabel} apparaîtront ici.`,
  };
}
