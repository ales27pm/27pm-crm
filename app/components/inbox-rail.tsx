"use client";

import type { Conversation, Mailbox } from "../crm-types";
import { Icon } from "./icons";

export type InboxFilter = "all" | "unread" | "follow-up";

type InboxRailProps = {
  mailboxes: Mailbox[];
  mailboxAddress: string;
  conversations: Conversation[];
  selectedId: string | null;
  filter: InboxFilter;
  search: string;
  hiddenOnMobile: boolean;
  onMailboxChange: (address: string) => void;
  onFilterChange: (filter: InboxFilter) => void;
  onSearchChange: (value: string) => void;
  onSelect: (id: string) => void;
};

const filters: Array<{ id: InboxFilter; label: string }> = [
  { id: "all", label: "Tous" },
  { id: "unread", label: "Non lus" },
  { id: "follow-up", label: "À suivre" },
];

export function InboxRail({
  mailboxes,
  mailboxAddress,
  conversations,
  selectedId,
  filter,
  search,
  hiddenOnMobile,
  onMailboxChange,
  onFilterChange,
  onSearchChange,
  onSelect,
}: InboxRailProps) {
  return (
    <section
      className="inbox-rail"
      data-mobile-hidden={hiddenOnMobile || undefined}
      aria-label="Liste des conversations"
    >
      <div className="mailbox-select-wrap">
        <label htmlFor="mailbox">Boîte courriel</label>
        <select
          id="mailbox"
          value={mailboxAddress}
          onChange={(event) => onMailboxChange(event.target.value)}
        >
          {mailboxes.map((mailbox) => (
            <option key={mailbox.address} value={mailbox.address}>
              {mailbox.address}
            </option>
          ))}
        </select>
        <Icon name="chevron" />
      </div>

      <label className="search-field">
        <span className="sr-only">Rechercher dans les courriels</span>
        <Icon name="search" />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder="Rechercher"
        />
        <kbd>⌘K</kbd>
      </label>

      <div className="inbox-filters" role="group" aria-label="Filtrer les conversations">
        {filters.map((item) => (
          <button
            key={item.id}
            type="button"
            data-active={filter === item.id || undefined}
            onClick={() => onFilterChange(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="conversation-list">
        {conversations.length ? (
          conversations.map((conversation) => (
            <button
              className="conversation-row"
              data-selected={selectedId === conversation.id || undefined}
              key={conversation.id}
              type="button"
              onClick={() => onSelect(conversation.id)}
            >
              <span className="conversation-row__topline">
                <span className="conversation-sender">
                  {conversation.unread ? <span className="unread-dot" aria-label="Non lu" /> : null}
                  <strong>{conversation.contactName}</strong>
                </span>
                <time>{conversation.updatedLabel}</time>
              </span>
              <span className="conversation-subject">{conversation.subject}</span>
              <span className="conversation-preview">{conversation.preview}</span>
            </button>
          ))
        ) : (
          <div className="empty-list">
            <Icon name="mail" />
            <strong>Aucune conversation ici.</strong>
            <p>Les nouveaux messages apparaîtront dans cette boîte.</p>
          </div>
        )}
      </div>
    </section>
  );
}
