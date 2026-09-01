# 27PM CRM visual implementation spec

Source concepts:

- `design/concepts/crm-inbox-desktop.png`
- `design/concepts/crm-pipeline-desktop.png`
- `design/concepts/crm-thread-mobile.png`

## Locked visual system

- Background is warm ivory `#f4f0e7`, never white or beige-substituted.
- Raised inputs and active rows use `#fbf8f1`.
- Ink is `#171714`; action/focus color is cobalt `#2846b8`.
- Major view, thread, and contact titles use Newsreader. Interface chrome uses
  Instrument Sans. Control typography is explicitly sized and never browser
  default.
- Geometry is square with at most `4px` radii. Structure comes from thin rails
  and dividers, not floating card grids or shadows.
- Icons are consistent `1.7px` outline SVGs using `currentColor`.

## Component inventory

- Persistent navigation rail with mailbox state.
- Inbox rail with mailbox selector, search, filters, and message rows.
- Conversation canvas with messages, delivery state, and reply composer.
- Context rail with contact, deal, next action, task, and notes.
- Pipeline columns with keyboard-operable stage movement and selected detail.
- Open-list views for contacts, projects, and tasks.
- Settings view for the three mailbox identities and provider readiness.
- Mobile bottom navigation plus context sheet.

## Above-the-fold copy lock

Allowed primary labels: `27PM`, `Réception`, `Nouveau courriel`,
`bonjour@27pm.org`, `alexis@27pm.org`, `Tous`, `Non lus`, `À suivre`,
`Contacts`, `Pipeline`, `Projets`, `Tâches`, `Paramètres`, and operational state
text. Authentication and provider-configuration messages are functional
necessities and may replace the working surface when those boundaries are
unavailable.

## Responsive contract

- `>= 1180px`: four-rail inbox composition.
- `760–1179px`: compact navigation; context becomes an overlay sheet.
- `< 760px`: single inbox/thread surface, 44px targets, bottom navigation,
  reply composer in flow, and a dismissible context sheet.

## Fidelity ledger targets

1. Shell proportions and divider anatomy match the desktop concepts.
2. Serif/sans hierarchy and control sizing match every concept.
3. Palette stays exact across backgrounds, selected rows, focus, and actions.
4. Inbox/thread/context content order matches the primary concept.
5. Pipeline stages and selected detail match the secondary concept.
6. Mobile thread, composer, context sheet, and bottom navigation match the
   mobile concept without squeezing desktop columns.
