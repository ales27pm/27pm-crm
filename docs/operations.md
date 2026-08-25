# 27PM CRM operations

This runbook covers the production handoff between OpenAI Sites, the private
CRM, and Mailgun. It does not authorize a deployment, a checkpoint, or any DNS
change.

## Safety contract

- Only `bonjour@27pm.org` and `admin@27pm.org` may enter the CRM.
- The Mailgun route is account-global, so inspect all routes before changing
  one. Mailgun documents `GET /v3/routes` and `POST /v3/routes` as account route
  operations in its [Routes API](https://documentation.mailgun.com/docs/mailgun/api-reference/send/mailgun/routes/post-v3-routes).
- The provisioner is read-only unless `--apply` is present. It never calls a
  DNS API, never updates or deletes a route, and never accepts credentials on
  the command line.
- A production checkpoint must be deployed and healthy before the route is
  created. The provisioner enforces a successful HTTPS `GET /api/health`
  immediately before its only possible `POST`.
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
| `CRM_WEBHOOK_MAX_AGE_SECONDS` | No | Maximum accepted webhook age; the current operational default is 900 seconds. |

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
7. Inspect the plan. This performs only paginated `GET /v3/routes` requests:

   ```sh
   node scripts/provision-mailgun-route.mjs --dry-run
   ```

8. Review any conflict in the Mailgun dashboard. The script refuses to replace
   a route with the same managed description or recipient expression.
9. Apply exactly once. The command re-inspects first, checks production health,
   creates only when absent, and re-inspects afterward:

   ```sh
   node scripts/provision-mailgun-route.mjs --apply
   ```

10. Record the returned route ID in the private change record, not in source.
11. Remove `MAILGUN_API_KEY` from the local environment.
12. Run the two-mailbox canary below before announcing availability.

Running the apply command again is safe: an existing exact route produces a
no-change result. If a network failure occurs after a create request, run the
dry-run first; do not blindly repeat an apply.

## Exact Mailgun contract

The provisioner can create only this route:

```text
priority:    0
expression:  match_recipient("^(bonjour|admin)@27pm\.org$")
action 1:    store(notify="https://crm.27pm.org/api/webhooks/mailgun/inbound")
action 2:    stop()
```

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

The single transport route does not merge the two business identities. Enforce
these rules at every application boundary:

| Mailbox | Allowed content | Forbidden use |
| --- | --- | --- |
| `bonjour@27pm.org` | Prospects, clients, project intake, estimates, and project replies | Password recovery, vendor administration, security alerts, or Google ownership notices |
| `admin@27pm.org` | Service accounts, supplier administration, security/recovery, billing operations, and Search Console | Lead intake, sales follow-ups, project replies, or public contact |

- Classify inbound mail from Mailgun's validated envelope recipient, not a
  display name or an untrusted `To` header.
- Reject every recipient outside the two exact addresses even if a callback is
  otherwise correctly signed.
- Persist the mailbox identity on the message and conversation. Do not infer it
  later from participants.
- Permit outbound mail only when the authenticated operator selected the same
  mailbox as the conversation. Audit every override or rejection.
- Keep `admin` messages out of contact, sales-pipeline, and marketing views.
  Keep `bonjour` out of credential-recovery workflows.
- Do not create catch-all, alias, wildcard, or plus-address behavior as an
  incidental extension of this route.

## Two-mailbox canary

From an external address not hosted at `27pm.org`:

1. Send a uniquely titled plain-text message to `bonjour@27pm.org`.
2. Send a different uniquely titled message to `admin@27pm.org`.
3. Verify one and only one CRM record for each message.
4. Verify the `bonjour` message appears only in the client mailbox and the
   `admin` message only in the operational mailbox.
5. Verify the raw body is not rendered as trusted HTML and attachments remain
   unavailable while marked `unscanned`.
6. Reply from each conversation and verify the envelope/header identity and
   Mailgun delivery event match that conversation's mailbox.
7. Check Mailgun delivery logs for duplicates, bounce, complaint, or callback
   failure, then retain only the normal audit record.

## Rollback

The provisioner intentionally has no delete mode.

1. Stop canary and operator sends, but leave the deployed checkpoint running so
   already-issued notifications can finish.
2. In the Mailgun dashboard, find the recorded route ID and compare its
   expression and both actions with the exact contract above.
3. Delete **only that route** in the dashboard, or use Mailgun's documented
   `DELETE /v3/routes/{id}` operation with the approved account credential.
4. Run the provisioner in dry-run mode and confirm the exact route is absent.
5. Confirm no new callbacks arrive. Review messages retained by `store()` before
   the three-day temporary-storage window expires.
6. Keep DNS and the Sites checkpoint unchanged while diagnosing. A route
   rollback does not require an MX, SPF, DKIM, DMARC, A, AAAA, CNAME, or TLS
   change.

If the API returned success but post-create verification failed, assume the
route may exist. Use the route ID shown by the tool, or inspect the dashboard,
before retrying. If a credential may have leaked, revoke it in Mailgun first,
issue a replacement, then review account routes and logs.

## DNS boundary

This workflow assumes Mailgun receiving DNS is already authorized. The route
script has no DNS code and must not be used as a reason to churn working DNS.
Google Search Console verification is a separate, interactive ownership task
documented in [google-accounts.md](google-accounts.md); its TXT token must never
replace an existing mail or website record.
