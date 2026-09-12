# 27PM CRM operations

This runbook covers the production handoff between OpenAI Sites, the private
CRM, and Mailgun. It does not authorize a deployment, a checkpoint, or any DNS
change.

## Safety contract

- Only `bonjour@27pm.org`, `alexis@27pm.org`, and `admin@27pm.org` may enter
  the CRM.
- The Mailgun routes are account-global, so inspect all routes before changing
  one. Mailgun documents `GET`, `POST`, and guarded `PUT /v3/routes/{id}`
  operations in its [Routes API](https://documentation.mailgun.com/docs/inboxready/api-reference/optimize/mailgun/routes/put-v3-routes-id).
- The provisioner is read-only unless `--apply` is present. It never calls a
  DNS API, never deletes a route, and never accepts credentials on the command
  line. Its only update path expands the exact recognized historical route for
  a one-route account while preserving route ID, priority, and actions.
- A production checkpoint must be deployed and healthy before the route is
  created or expanded. The provisioner enforces a successful HTTPS
  `GET /api/health` immediately before its possible `POST` or `PUT`.
- Do not paste keys into issue trackers, chat, checkpoint descriptions, shell
  commands, screenshots, or logs.

## Sites runtime configuration

Add runtime secrets through the CRM's **Sites project settings → Secrets**.
Use production values, then deploy a new checkpoint so the worker receives
them. Never commit a production value to `.env.example`.

| Name | Sites secret? | Purpose |
| --- | --- | --- |
| `CRM_ADMIN_EMAILS` | Yes | Explicit operator allowlist; it must not be empty in production. |
| `MAILGUN_SENDING_KEY` | Yes | Domain-scoped sending key used by the CRM; do not use the account route-administration key here. |
| `MAILGUN_WEBHOOK_SIGNING_KEY` | Yes | Verifies fresh Mailgun HMAC-SHA256 callbacks and rejects replay. |
| `MAILGUN_API_BASE` | No | `https://api.mailgun.net` for US or `https://api.eu.mailgun.net` for EU. |
| `MAILGUN_DOMAIN` | No | Must remain exactly `27pm.org`. |
| `CRM_PUBLIC_ORIGIN` | No | Stable production HTTPS origin, normally `https://crm.27pm.org`. |
| `CRM_UNSUBSCRIBE_SIGNING_KEY` | Yes | Dedicated secret (at least 32 random bytes) for opaque AES-GCM authenticated unsubscribe tokens. No production fallback exists. |
| `CRM_WEBHOOK_MAX_AGE_SECONDS` | No | Maximum accepted webhook age; the current operational default is 900 seconds. |
| `PUBLIC_SITE_ORIGIN` | No | Exact public site origin allowed to submit an intake. |
| `TURNSTILE_SECRET_KEY` | Yes | Server-side Cloudflare Turnstile verification secret. |
| `PUBLIC_INTAKE_HASH_SALT` | Yes | Random secret used only to hash requester IPs for rate limiting. |
| `PUBLIC_INTAKE_TURNSTILE_ACTION` | No | Expected Turnstile widget action; defaults to `crm_intake`. |

## Migrations CRM 0004 à 0011

The Sites build packages the SQL migrations and the production D1 binding is
owned by the Sites project. Do not run Wrangler against the placeholder local
database ID from `vite.config.ts`.

Before an authorized deployment:

1. export or snapshot the production D1 database using the Sites project
   controls;
2. record the current checkpoint and migration state;
3. deploy the exact reviewed checkpoint through Sites so its packaged
   migrations apply to the correct binding;
4. verify `GET /api/health`, operator denial/allowlist behavior, the five
   accounts, six fail-closed research contacts, and `PRAGMA foreign_key_check` through the
   approved D1 console;
5. verify a duplicate import key returns an idempotent no-change result.

Rollback is not `DROP TABLE`: pause writes, restore the captured D1 snapshot
and the prior Sites checkpoint together. If restoration is unavailable, keep
the new schema and ship a reviewed forward-only corrective migration.
Migration 0004 preserves legacy contacts, backfills organizations and seeds
the five account hypotheses. Migration 0005 adds the atomic public-intake rate
bucket and the explicit channel for contact tasks. Migration 0006 adds the
per-channel evidence ledger, suppressions, fail-closed configuration, privacy
requests and immutable triggers; every legacy contact is deliberately assigned
`lawful_basis = 'none'`. Migration 0007 adds import and policy evidence fields.
Migration 0008 marks Mailgun receipts as `reserved` until the message, event and
attachments are durable, then `processed`; reserved callbacks may be resumed
idempotently after an intermediate failure. Existing receipts are backfilled
as processed.
Migration 0009 removes only the exact canary and public-intake QA identifiers
recorded before the V2 release. It preserves the five approved organizations,
their account conversations, opportunities and internal tasks, the cohort
import record, the two mailboxes that existed at that point, compliance
configuration, suppressions and the immutable audit ledger. Reapplying 0009
is a no-op and unknown records survive.
Migration 0010 adds one dated outreach strategy and six planning steps for
each approved organization. It also records five shared business routes and
one nominative professional address from an official company page. Every imported email
has `email_status = 'unknown'`, `lawful_basis = 'none'` and channel status
`unknown`; all 15 email steps are therefore blocked. The migration creates no
message, send command or automatic transport action.
Migration 0011 adds the active `alexis@27pm.org` sales identity with the
display name `Alexis Boulet — 27PM`. It does not create a Mailgun route, a
message, a send command, a DNS record, or a separate IMAP/POP mailbox.
A code rollback without a data rollback has not been claimed compatible.

Before applying 0006, validate the full export by restoring it to a disposable
D1/SQLite target and record the source database, UTC timestamp, object count,
checksum and exact restore command. A truncated SQL display or an untested
download is not a restorable backup. After migration, run `PRAGMA
foreign_key_check`, confirm the five cohort accounts remain ordered, confirm
the six research contacts retain their provenance and fail-closed state, and
confirm all 30 planning steps exist without a message or send command.

## Public intake contract

The public site may send this request only after the three intake settings are
configured. It must generate a fresh idempotency key and Turnstile token:

```http
POST /api/public/intake
Origin: https://27pm.org
Content-Type: application/json
Idempotency-Key: form-<random-uuid>

{"organizationName":"…","contactName":"…","contactEmail":"…","projectType":"…","message":"…","privacyAcknowledged":true,"turnstileToken":"…","website":""}
```

`website` is a honeypot and must remain empty. A `202` means only “queued for
operator review”; it is not an acknowledgement of a commercial relationship
and must not trigger email, SMS, calls, or automated sequencing.
The Turnstile widget must use action `crm_intake` (or the exact configured
override); the CRM verifies both the action and the hostname before storing.

The route-administration credential, `MAILGUN_API_KEY`, is deliberately **not**
a Sites runtime secret. It is a short-lived operator input for the local
provisioning process and has broader account privileges than the CRM needs.
Load it from the approved password manager into the current process
environment, run the provisioner, then remove it from the environment.

## Production order of operations

Do these steps in order. Do not create the Mailgun route early.

1. Configure the Sites runtime secrets above.
2. Checkpoint the coherent CRM release.
3. Deploy that checkpoint and attach the stable HTTPS origin.
4. Confirm that `GET https://crm.27pm.org/api/health` returns a success status.
5. Confirm operator pages require ChatGPT sign-in plus the explicit server-side
   allowlist. Confirm an unsigned Mailgun callback is rejected.
6. Load `MAILGUN_API_KEY` locally without echoing it. Set
   `CRM_PUBLIC_ORIGIN=https://crm.27pm.org` and, if needed, the official US/EU
   `MAILGUN_API_BASE`.
7. Inspect both managed plans. These commands perform only paginated
   `GET /v3/routes` requests:

   ```sh
   npm run mailgun:route -- --dry-run
   npm run mailgun:route:alexis -- --dry-run
   ```

8. Review any conflict in the Mailgun dashboard. The script refuses to replace
   a route with the same managed description or recipient expression.
9. Apply only the missing exact coverage. For the Alexis identity, the command
   re-inspects first and checks production health. It creates a non-overlapping
   `alexis@` route when possible; on an exact one-route account, it instead
   expands the historical route in place and verifies that its ID, priority,
   and actions did not change:

   ```sh
   npm run mailgun:route:alexis -- --apply
   ```

10. Record the returned route ID in the private change record, not in source.
11. In the Mailgun domain webhooks, inspect the existing configuration before
    changing it, then point `accepted`, `delivered`, `temporary_fail`,
    `permanent_fail`, and `complained` to the exact delivery-event callback
    documented below. Do not replace an unrelated callback without a separate
    review.
12. Remove `MAILGUN_API_KEY` from the local environment.
13. Run the three-mailbox canary below before announcing availability.

Running the apply command again is safe: an existing exact route produces a
no-change result. If a network failure occurs after a create request, run the
dry-run first; do not blindly repeat an apply.

## Exact Mailgun contract

The default provisioner manages only the historical route:

```text
priority:    0
expression:  match_recipient("^(bonjour|admin)@27pm\.org$")
action 1:    store(notify="https://crm.27pm.org/api/webhooks/mailgun/inbound")
action 2:    stop()
```

With `--mailbox=alexis` (or `npm run mailgun:route:alexis`), the preferred
contract is this additive route:

```text
priority:    0
expression:  match_recipient("^alexis@27pm\.org$")
action 1:    store(notify="https://crm.27pm.org/api/webhooks/mailgun/inbound")
action 2:    stop()
```

The two recipient expressions are disjoint. If the account quota is one route,
the provisioner may instead update only the exact recognized historical route
to this combined expression while preserving its transport:

```text
priority:    0
expression:  match_recipient("^(bonjour|admin|alexis)@27pm\.org$")
action 1:    unchanged store(notify=...) callback
action 2:    stop()
```

Never create this combined route alongside an additive `alexis@` route.

Configure each delivery-event webhook above with this exact HTTPS target:

```text
https://crm.27pm.org/api/webhooks/mailgun/events
```

Mailgun posts accepted and delivered events directly. It posts delivery
failures as `failed` events with a temporary or permanent severity; a permanent
event whose reason is `bounce` or `suppress-bounce` is presented separately as
a rebond. Complaint events remain `complained`. The CRM stores the signed raw
event for audit, but exposes only the canonical state, timestamp, and safe
operator guidance in the browser. See Mailgun’s [event types](https://documentation.mailgun.com/docs/mailgun/user-manual/events/event-types)
and [webhook payloads](https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/webhook-payloads).

The receipt is not considered processed until all durable writes finish. A
retry of a reserved callback resumes idempotently; a processed signature is a
replay and a new signature for an already processed callback is a duplicate.

### Outbound prospecting contract

Every CRM prospecting send must force Mailgun DKIM, disable open/click
tracking, use an exact `Reply-To` matching the selected mailbox, and include
the signed HTTPS CRM URL in both the visible footer and the RFC 8058
`List-Unsubscribe` headers. The one-click endpoint accepts both standard form
encodings and applies a global suppression immediately.

For DKIM rotation, publish the two exact 2048-bit rotating CNAME records that
Mailgun generates, wait for Mailgun verification, and only then remove legacy
DKIM TXT records. Do not move sending to a subdomain while DMARC uses strict
alignment unless that subdomain is explicitly aligned first. After any DNS
change, send a canary and verify `spf=pass`, `dkim=pass`, `dmarc=pass`, and that
the DKIM signature covers both unsubscribe headers before resuming the cadence.

Mailgun uses Python-style regular expressions for `match_recipient`; the
anchors above exclude aliases, plus-addresses, other local parts, and other
domains. See [Route filters](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/route-filters).
`store(notify=...)` keeps a temporary recovery copy for up to three days, and
`stop()` prevents lower-priority routes from being evaluated. See
[Route actions](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/route-actions).

The HTTPS callback is still untrusted input. The application must verify the
Mailgun timestamp, token, and HMAC-SHA256 signature before it persists any
message. Mailgun documents the signed fields in
[Receiving messages over HTTP](https://documentation.mailgun.com/docs/mailgun/user-manual/receive-forward-store/receive-http).

## Strict mailbox separation

The transport filters do not merge the three business identities. Enforce
these rules at every application boundary:

| Mailbox | Allowed content | Forbidden use |
| --- | --- | --- |
| `bonjour@27pm.org` | Prospects, clients, project intake, estimates, and project replies | Password recovery, vendor administration, security alerts, or Google ownership notices |
| `alexis@27pm.org` | Commercial conversations explicitly initiated by or assigned to Alexis Boulet | Generic public intake, password recovery, vendor administration, security alerts, or impersonating another sender |
| `admin@27pm.org` | Service accounts, supplier administration, security/recovery, billing operations, and Search Console | Lead intake, sales follow-ups, project replies, or public contact |

- Classify inbound mail from Mailgun's validated envelope recipient, not a
  display name or an untrusted `To` header.
- Reject every recipient outside the three exact addresses even if a callback is
  otherwise correctly signed.
- Persist the mailbox identity on the message and conversation. Do not infer it
  later from participants.
- Permit outbound mail only when the authenticated operator selected the same
  mailbox as the conversation. Audit every override or rejection.
- Keep `admin` messages out of contact, sales-pipeline, and marketing views.
  Keep both `bonjour` and `alexis` out of credential-recovery workflows.
- Do not create catch-all, alias, wildcard, or plus-address behavior as an
  incidental extension of this route.

## Three-mailbox canary

From an external address not hosted at `27pm.org`:

1. Send a uniquely titled plain-text message to `bonjour@27pm.org`.
2. Send a different uniquely titled message to `alexis@27pm.org`.
3. Send a third uniquely titled message to `admin@27pm.org`.
4. Verify one and only one CRM record for each message.
5. Verify the `bonjour` and `alexis` messages appear only in their respective
   sales inboxes and the `admin` message only in the operational inbox.
6. Verify the raw body is not rendered as trusted HTML and attachments remain
   unavailable while marked `unscanned`.
7. Reply from each conversation and verify the envelope/header identity and
   Mailgun delivery event match that conversation's mailbox.
8. Check Mailgun delivery logs for duplicates, bounce, complaint, or callback
   failure, then retain only the normal audit record.

## Rollback

The provisioner intentionally has no delete mode.

1. Stop canary and operator sends, but leave the deployed checkpoint running so
   already-issued notifications can finish.
2. In the Mailgun dashboard, find the recorded target route ID and compare its
   expression and both actions with the corresponding exact contract above.
3. For an additive Alexis route, delete **only that target route** in the
   dashboard or with Mailgun's documented `DELETE /v3/routes/{id}` operation.
   For a combined one-route account, do not delete the historical route;
   restore only its prior description and two-address expression while keeping
   the same ID, priority, and actions.
4. Run the corresponding provisioner in dry-run mode and confirm the intended
   rollback state. For Alexis, use
   `npm run mailgun:route:alexis -- --dry-run`.
5. Confirm no new callbacks arrive. Review messages retained by `store()` before
   the three-day temporary-storage window expires.
6. Keep DNS and the Sites checkpoint unchanged while diagnosing. A route
   rollback does not require an MX, SPF, DKIM, DMARC, A, AAAA, CNAME, or TLS
   change.

If the API returned success but post-change verification failed, inspect the
recorded route ID before retrying. If a credential may have leaked, revoke it
in Mailgun first, issue a replacement, then review account routes and logs.

## DNS boundary

This workflow assumes Mailgun receiving DNS is already authorized. The route
script has no DNS code and must not be used as a reason to churn working DNS.
Google Search Console verification is a separate, interactive ownership task
documented in [google-accounts.md](google-accounts.md); its TXT token must never
replace an existing mail or website record.
