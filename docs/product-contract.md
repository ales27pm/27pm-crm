# 27PM CRM — product and integration contract

## Outcome

The private CRM is the durable working surface for two distinct 27PM email
identities:

- `bonjour@27pm.org` receives prospects, clients, project intake, and replies.
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
- `POST /api/webhooks/mailgun/inbound` — signed inbound email callback.
- `POST /api/webhooks/mailgun/events` — signed delivery-event callback.

## Protected HTTP seams

- `GET /api/dashboard` — mailbox, conversation, lead, and task summary.
- `POST /api/messages/send` — send or reply from an allowed 27PM mailbox.
- `PATCH /api/conversations/:id` — read/follow-up state.
- `PATCH /api/deals/:id` — pipeline stage, project type, and next action.

## Mailgun route target

Once a stable CRM origin and Mailgun account access are available, create one
account route matching exactly:

```text
^(bonjour|admin)@27pm\.org$
```

Use `store(notify="https://crm.27pm.org/api/webhooks/mailgun/inbound")` followed
by `stop()`. Mailgun temporary storage is the short recovery buffer; D1/R2 is
the durable application record.

## Completion evidence

- Database migration contains both mailbox identities and unique idempotency
  constraints.
- Unit tests reject invalid, expired, and replayed webhook signatures.
- Route tests prove inbound classification and protected operator mutations.
- Production build emits the Sites worker, hosting metadata, and migrations.
- A checkpoint deployment succeeds before any Mailgun route is created.
