"use client";

import Image from "next/image";
import type { NavView, TransportState } from "../crm-types";
import { Icon, type IconName } from "./icons";

const items: Array<{ id: NavView; label: string; icon: IconName }> = [
  { id: "today", label: "Aujourd’hui", icon: "calendar" },
  { id: "inbox", label: "Réception", icon: "inbox" },
  { id: "contacts", label: "Comptes", icon: "contacts" },
  { id: "pipeline", label: "Pipeline", icon: "pipeline" },
  { id: "projects", label: "Projets", icon: "projects" },
  { id: "tasks", label: "Tâches", icon: "tasks" },
  { id: "settings", label: "Paramètres", icon: "settings" },
];

type SidebarProps = {
  active: NavView;
  unreadCount: number;
  transportState: TransportState;
  onNavigate: (view: NavView) => void;
};

export function Sidebar({
  active,
  unreadCount,
  transportState,
  onNavigate,
}: SidebarProps) {
  const stateLabel = {
    operational: "Courriel opérationnel",
    configuration: "Configuration courriel",
    degraded: "Courriel à vérifier",
  }[transportState];

  return (
    <aside className="sidebar" aria-label="Navigation principale">
      <button
        className="sidebar-brand"
        type="button"
        aria-label="Aller à Aujourd’hui"
        onClick={() => onNavigate("today")}
      >
        <Image
          className="sidebar-logo-wide"
          src="/visual-assets/brand/27pm-crm-horizontal.svg"
          alt=""
          width={150}
          height={48}
          unoptimized
        />
        <Image
          className="sidebar-logo-compact"
          src="/visual-assets/brand/27pm-crm-compact.svg"
          alt=""
          width={40}
          height={40}
          unoptimized
        />
      </button>
      <nav>
        {items.map((item) => (
          <button
            key={item.id}
            className="nav-item"
            data-active={active === item.id || undefined}
            type="button"
            onClick={() => onNavigate(item.id)}
            aria-current={active === item.id ? "page" : undefined}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
            {item.id === "inbox" && unreadCount > 0 ? (
              <span className="nav-count" aria-label={`${unreadCount} non lus`}>
                {unreadCount}
              </span>
            ) : null}
          </button>
        ))}
      </nav>
      <div className="transport-state" data-state={transportState}>
        <span aria-hidden="true" />
        <strong>{stateLabel}</strong>
      </div>
    </aside>
  );
}
