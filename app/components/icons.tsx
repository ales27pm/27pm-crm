import type { SVGProps } from "react";

export type IconName =
  | "inbox"
  | "contacts"
  | "pipeline"
  | "projects"
  | "tasks"
  | "settings"
  | "compose"
  | "search"
  | "reply"
  | "clock"
  | "more"
  | "attachment"
  | "send"
  | "plus"
  | "note"
  | "globe"
  | "calendar"
  | "mail"
  | "close"
  | "back"
  | "chevron"
  | "check"
  | "folder"
  | "drag";

type IconProps = SVGProps<SVGSVGElement> & { name: IconName };

export function Icon({ name, ...props }: IconProps) {
  const content = {
    inbox: (
      <>
        <path d="M4 6.5 6.2 3h11.6L20 6.5v12H4z" />
        <path d="M4 13h4l1.6 2h4.8L16 13h4" />
      </>
    ),
    contacts: (
      <>
        <circle cx="9" cy="8" r="3.2" />
        <path d="M3.5 20v-1.3c0-3 2.5-5.2 5.5-5.2s5.5 2.2 5.5 5.2V20" />
        <path d="M16 5.3a3.1 3.1 0 0 1 0 5.8M17 13.4c2.3.7 3.5 2.5 3.5 4.8V20" />
      </>
    ),
    pipeline: <path d="M3 4h18l-7 8v6.5l-4 2V12z" />,
    projects: (
      <>
        <path d="M3.5 6.5h6l2-2h9v15h-17z" />
        <path d="M3.5 9h17" />
      </>
    ),
    tasks: (
      <>
        <rect x="4" y="3" width="16" height="18" rx="1.5" />
        <path d="m8 12 2.2 2.2L16 8.8" />
      </>
    ),
    settings: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19 14.5 21 16l-2 3.5-2.5-1a8 8 0 0 1-2.4 1.4L13.8 22h-4l-.4-2.1A8 8 0 0 1 7 18.5l-2.5 1-2-3.5 2-1.5a8 8 0 0 1 0-3L2.5 10l2-3.5 2.5 1a8 8 0 0 1 2.4-1.4L9.8 4h4l.4 2.1A8 8 0 0 1 16.5 7.5l2.5-1 2 3.5-2 1.5a8 8 0 0 1 0 3Z" />
      </>
    ),
    compose: (
      <>
        <path d="m14 5 5 5L9 20H4v-5z" />
        <path d="m12.5 6.5 5 5M4 20h16" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m15.5 15.5 5 5" />
      </>
    ),
    reply: <path d="m10 8-6 5 6 5v-3h3.5c3.5 0 5.5 1.2 7 4-.2-6.4-3.2-9-7-9H10z" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </>
    ),
    more: (
      <>
        <circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
        <circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" />
      </>
    ),
    attachment: <path d="m9.5 12.5 6.7-6.7a3 3 0 1 1 4.2 4.2l-9 9a5 5 0 0 1-7.1-7.1l9-9M7 14l8.8-8.8" />,
    send: <path d="m3 11 18-8-7.8 18-2.3-7.9zM11 13l10-10" />,
    plus: <path d="M12 4v16M4 12h16" />,
    note: (
      <>
        <path d="M5 3h14v15l-4 3H5z" />
        <path d="M8 8h8M8 12h6M15 21v-4h4" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
      </>
    ),
    calendar: (
      <>
        <rect x="3" y="5" width="18" height="16" rx="1.5" />
        <path d="M7 3v4M17 3v4M3 10h18" />
      </>
    ),
    mail: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="1.5" />
        <path d="m4 7 8 6 8-6" />
      </>
    ),
    close: <path d="m5 5 14 14M19 5 5 19" />,
    back: <path d="m14 5-7 7 7 7" />,
    chevron: <path d="m7 9 5 5 5-5" />,
    check: <path d="m5 12 4.5 4.5L19 7" />,
    folder: (
      <>
        <path d="M3 6h6l2-2h10v16H3z" />
        <path d="M3 9h18" />
      </>
    ),
    drag: <path d="M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01" strokeWidth="3" />,
  }[name];

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.7"
      aria-hidden="true"
      {...props}
    >
      {content}
    </svg>
  );
}
