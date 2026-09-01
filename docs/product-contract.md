# 27PM CRM — product and integration contract

## Outcome

The private CRM is the durable working surface for three distinct 27PM email
identities:

- `bonjour@27pm.org` receives prospects, clients, project intake, and replies.
- `alexis@27pm.org` sends and receives commercial conversations explicitly
  assigned to Alexis Boulet.
- `admin@27pm.org` receives service-account, supplier, security, recovery, and
  Google Search Console messages.

Mailgun remains the SMTP transport already authorized by the public DNS. The
CRM receives signed Mailgun HTTP callbacks and sends through a domain-scoped
sending key. GitHub Pages continues to host the public 27PM site and stores no
CRM data.

## Primary workflow

1. Open **Réception** and filter by mailbox, unread state, or follow-up state.
2. Read a conversation with its contact or operational-account context.
3. Reply from the correct mailbox identity.
4. For sales messages, qualify the lead, choose a project type, and schedule a
   next action without leaving the conversation.
5. Track delivery, bounce, complaint, and failure events from Mailgun.

## Security invariants

- CRM pages and operator API routes require dispatch-owned ChatGPT sign-in and
  an explicit server-side email allowlist.
- Mailgun endpoints remain public but accept only fresh HMAC-SHA256 signed
  requests and reject replayed tokens.
- Runtime secrets never reach browser code, D1 records, logs, Git, or rendered
  HTML.
- Received HTML is stored for audit only and is never rendered unsanitized.
- Attachment bytes remain private in R2. New attachments are marked
  `unscanned` and cannot be downloaded until a malware-scanning decision is
  implemented.
- All message, pipeline, task, and audit state is authoritative in D1, not
  browser storage.
- Duplicate Mailgun callbacks and duplicate send commands are idempotent.

## Public HTTP seams

- `GET /api/health` — non-sensitive service health.
- `POST /api/public/intake` — anti-abuse public intake queued for review; never
  creates an actionnable contact directly.
- `GET` and `POST /api/public/unsubscribe` — opaque authenticated confirmation and immediate,
  idempotent suppression; never sends a message.
- `POST /api/webhooks/mailgun/inbound` — signed inbound email callback.
- `POST /api/webhooks/mailgun/events` — signed delivery-event callback.

## Protected HTTP seams

- `GET /api/dashboard` — mailbox, conversation, lead, and task summary.
- `POST /api/messages/send` — send or reply from an allowed 27PM mailbox.
- `PATCH /api/conversations/:id` — read/follow-up state.
- `PATCH /api/deals/:id` — pipeline stage, project type, and next action.
- `POST /api/organizations` and `PATCH /api/organizations/:id` — create and
  maintain independent accounts and their opportunity context.
- `POST /api/contacts` and `PATCH /api/contacts/:id` — create or update a
  verified, sourced professional contact with compliance state.
- `POST /api/accounts/import` — idempotent non-personal account import.
- `GET` and `PATCH /api/compliance` — fail-closed operator compliance settings.
- `GET` and `POST /api/privacy-requests`, `PATCH /api/privacy-requests/:id` —
  audited manual workflow for privacy rights.
- `PATCH /api/intake/:id` — operator review of a pending public request.
- `POST /api/prospects` — retired with HTTP 410; callers must use the separate
  account/contact workflow.
- `POST /api/interactions` — record a manual call, meeting, completed email,
  note, or other interaction without invoking the mail transport.
- `PUT /api/strategies/:organizationId` — create or revise a versioned,
  fail-closed outreach plan and its six-step working-day cadence.
- `PATCH /api/strategies/:strategyId/steps/:stepId` — reschedule or complete a
  planning step; contact steps revalidate the selected channel at action time.

An outreach strategy is planning data, not send authorization. The strategy
and step routes never write `messages` or `send_commands` and never call the
mail transport.

## Mailgun route target

Once a stable CRM origin and Mailgun account access are available, prefer two
non-overlapping account routes matching exactly:

```text
^(bonjour|admin)@27pm\.org$
^alexis@27pm\.org$
```

Each route uses
`store(notify="https://crm.27pm.org/api/webhooks/mailgun/inbound")` followed by
`stop()`. The second expression cannot match either historical address, so it
can be added without replacing or overlapping the existing route.

When the Mailgun plan permits only one account route, the guarded fallback is
one combined exact expression:

```text
^(bonjour|admin|alexis)@27pm\.org$
```

The provisioner may expand only the recognized historical route in place and
must preserve its route ID, priority, and actions. Mailgun temporary storage is
the short recovery buffer; D1/R2 is the durable application record.

## Completion evidence

- Database migrations contain all three mailbox identities and unique
  idempotency constraints.
- Unit tests reject invalid, expired, and replayed webhook signatures.
- Route tests prove inbound classification and protected operator mutations.
- Production build emits the Sites worker, hosting metadata, and migrations.
- The matching checkpoint deployment succeeds before a new Mailgun route is
  created.
