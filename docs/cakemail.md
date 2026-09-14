# Optional Cakemail outbound transport

The CRM supports Cakemail as an optional **outbound-only** transport. Mailgun
remains the default and continues to own the `27pm.org` MX records, inbound
routes, stored inbound messages, and inbound webhook authentication. Enabling
Cakemail never authorizes a DNS change or a real send by itself.

## Why activation is gated

The current CRM route is manual prospecting. Cakemail's published anti-spam
policy restricts addresses copied or scraped from public directories and
generic role addresses. This is a **hard provider-policy blocker**, not an
operator acknowledgement: `CAKEMAIL_PROSPECTING_APPROVED` must remain `false`
and `CRM_OUTBOUND_PROVIDER` must remain `mailgun` while either source is
eligible for a Cakemail send. A CRM lawful-basis value or a publicly listed
address does not, by itself, satisfy Cakemail's policy.

Production use is allowed only after one of these two conditions has been
evidenced:

- Cakemail gives written approval that names the exact 27PM use case, address
  acquisition sources, and intended use of any generic role addresses; or
- deployed, fail-closed source enforcement makes scraped/public-directory and
  generic-role prospects ineligible and admits only recipients whose CRM
  `lawfulBasis` is exactly `explicit_consent`,
  `existing_business_relationship`, or `requested_response`.

Retain the provider approval or the reviewed enforcement revision with the
activation evidence. Do not set the gate from a general sales conversation,
an unsigned verbal answer, or an exception that covers a different audience.

Cakemail's current REST endpoint description requires exactly one of `html`,
`text`, or a template, while the Mailgun path sends both plain text and HTML.
The configured `CAKEMAIL_CONTENT_MODE` is therefore an explicit, reviewed
single-part choice rather than a hidden downgrade. Received-message canaries
must prove the selected rendering is acceptable.

Finally, custom headers are available through `additional_headers`, but the
provider documentation does not guarantee that an Internet `Message-ID`,
threading headers, or RFC 8058 unsubscribe headers are preserved and covered by
DKIM. Those properties and strict `d=27pm.org` alignment must be proven from a
received canary before the gates below are enabled.

## Runtime configuration

Keep `CRM_OUTBOUND_PROVIDER` unset or set it to `mailgun` until every gate has
been passed. Cakemail uses a Personal Access Token rather than an account
password or the SDK's automatic retry behavior.

```dotenv
CRM_OUTBOUND_PROVIDER=cakemail
CAKEMAIL_PAT=ck_pat_<40-lowercase-hex-characters>
CAKEMAIL_ACCOUNT_ID=<positive-account-id>
CAKEMAIL_LIST_ID=<positive-marketing-list-id>
CAKEMAIL_SENDER_ID_BONJOUR=<confirmed-sender-id>
CAKEMAIL_SENDER_ID_ALEXIS=<confirmed-sender-id>
CAKEMAIL_SENDER_ID_ADMIN=<optional-confirmed-sender-id>
CAKEMAIL_CONTENT_MODE=html
CAKEMAIL_AUDIENCE_MODE=permission_relationship
CAKEMAIL_ACTIVATION_BINDING_JSON={"version":2,"accountId":17,"listId":23,"contentMode":"html","senderIds":{"bonjour@27pm.org":"<confirmed-sender-id>","alexis@27pm.org":"<confirmed-sender-id>"},"audiencePolicy":{"mode":"permission_relationship"}}
CAKEMAIL_WEBHOOK_SECRETS_JSON={"Email.Sent":["<sent-secret>"],"Email.Delivered":["<delivered-secret>"],"Email.Rejected":["<rejected-secret>"],"Email.Error":["<error-secret>"],"Email.Bounced":["<bounced-secret>"],"Email.ReportedAsSpam":["<complaint-secret>"],"Email.Unsubscribed":["<unsubscribe-secret>"],"Email.GlobalUnsubscribed":["<global-unsubscribe-secret>"]}

CAKEMAIL_LIST_POLICY_ACCEPTED=true
CAKEMAIL_TRACKING_DOMAIN_READY=true
CAKEMAIL_PROSPECTING_APPROVED=false
CAKEMAIL_HEADER_PRESERVATION_CONFIRMED=true
CAKEMAIL_DKIM_ALIGNMENT_CONFIRMED=true
```

Store `CAKEMAIL_PAT` and webhook secrets only as Sites runtime secrets. Request
the PAT with only `emailapi:send` and restrict it to the 27PM account. Cakemail
1.25.3 currently expands that request to the exact effective metadata scopes
`emailapi:read` and `emailapi:send`; the preflight rejects every other scope.
Provider mutations, including webhook provisioning, must use a separate,
task-specific credential that is never deployed to the runtime.
`CAKEMAIL_ACTIVATION_BINDING_JSON` is not secret. Version 2 must exactly
reproduce the account ID, list ID, selected content mode, complete sender-ID
mapping, and reviewed audience-policy mode. Changing any of those values
invalidates the activation until a new canary/proof review produces a
replacement binding. The `17` and `23` values shown above are schema examples,
not 27PM account data; replace them with the two verified IDs.
Every configured address must have its own distinct confirmed sender ID. The
runtime rejects duplicate IDs because Cakemail's payload selects the visible
identity by sender ID rather than carrying a separate `From` address. Each ID
must be at most 128 characters.

Run the read-only activation preflight locally with the dedicated audit PAT and
the public 12-character prefix of the runtime PAT; never copy the audit PAT into
Sites. `CAKEMAIL_TRACKING_HOSTNAME` must be the newly reviewed Cakemail hostname,
not an existing Mailgun or CRM hostname:

```dotenv
CAKEMAIL_PREFLIGHT_PAT=ck_pat_<40-lowercase-hex-characters>
CAKEMAIL_RUNTIME_PAT_PREFIX=ck_pat_<5-lowercase-hex-characters>
CAKEMAIL_TRACKING_HOSTNAME=track-cakemail.27pm.org
CAKEMAIL_BOUNCE_HOSTNAME=bounce-cakemail.27pm.org
```

```bash
npm run cakemail:preflight
```

The command performs only bounded `GET` requests to the pinned official API
origin and prints no token or webhook signing secret. Every gate must report
`pass`; retain the redacted result with the activation evidence.

The audit PAT must be active, unexpired, restricted to exactly the configured
account ID, and have exactly these six read scopes: `dkim:read`, `domains:read`,
`lists:read`, `senders:read`, `tokens:read`, and `webhooks:read`. Request the
runtime PAT independently with only `emailapi:send` and restrict it to that same
single account. Cakemail currently reports its effective scopes as exactly
`emailapi:read` and `emailapi:send`; this unavoidable read closure is accepted.
Their 12-character prefixes must be distinct. Any other mutation,
administration, wildcard, or additional scope fails the preflight.

`permission_relationship` is the preferred mode. It requires deployed source
enforcement that accepts only the exact `explicit_consent`,
`existing_business_relationship`, and `requested_response` lawful bases. It
also blocks generic-role mailbox local parts (including normalized plus-tag and
punctuation variants such as `info`, `contact`, `sales`, `admin`, `bonjour`,
and `support`); the explicit deny-set in `lib/cakemail-audience-policy.ts` is
the source of truth. In this mode,
`CAKEMAIL_PROSPECTING_APPROVED` must be absent or literal `false`, and
`CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE` and
`CAKEMAIL_PROSPECTING_APPROVAL_SHA256` must be absent. The example binding
above records that exact policy choice.

The alternative `written_exception` mode is allowed only with the exact
Cakemail approval described above. It requires all of the following values:

```dotenv
CAKEMAIL_AUDIENCE_MODE=written_exception
CAKEMAIL_PROSPECTING_APPROVED=true
CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE=<safe-redacted-evidence-reference>
CAKEMAIL_PROSPECTING_APPROVAL_SHA256=<lowercase-64-hex-sha256-of-retained-approval>
CAKEMAIL_ACTIVATION_BINDING_JSON={"version":2,"accountId":17,"listId":23,"contentMode":"html","senderIds":{"bonjour@27pm.org":"<confirmed-sender-id>","alexis@27pm.org":"<confirmed-sender-id>"},"audiencePolicy":{"mode":"written_exception","approvalReference":"<same-safe-reference>","approvalSha256":"<same-lowercase-64-hex>"}}
```

The approval reference is a non-secret evidence locator matching
`[A-Za-z0-9][A-Za-z0-9._:/#@-]{0,255}`; spaces and control characters are not
allowed. The digest is the exact lowercase SHA-256 of the retained written
approval. The runtime rejects missing, malformed, or binding-mismatched
evidence. Neither variable contains the approval text itself.

Before enabling the runtime, accept Cakemail's anti-spam policy once for the
configured list through `POST /lists/{list_id}/accept-policy`, confirm every
sender, authenticate `27pm.org`, and finish the branded tracking-domain setup
required by Cakemail even though CRM open/click tracking remains disabled. The
two setup gates record those completed account-side prerequisites; they do not
perform or authorize the provider mutations themselves.

Use a new, provider-specific tracking hostname such as
`track-cakemail.27pm.org`. **Do not reuse `email.27pm.org`**: that hostname is
already the Mailgun tracking CNAME and must remain unchanged. Apply only the
exact DNS entries returned for the Cakemail account after reviewing a
record-level diff. Use a similarly non-conflicting provider-assigned bounce
hostname if Cakemail requires one; never replace the `27pm.org` Mailgun MX,
SPF, or existing Mailgun DKIM selectors as part of this activation.

The transport sends one recipient with `content.type=marketing`, the configured
list, exactly the selected text or HTML alternative, explicit zero open/click
tracking, and the existing non-PII CRM tags. It
does not retry `POST /v2/emails`: HTTP 408/429, any timeout, network
interruption, 5xx, or malformed success after dispatch remains an unknown,
non-retryable outcome. Only an explicit, unambiguous provider rejection is
treated as definitive.

## Provider-side activation checks

Run these checks with the separate exact-scope read-only audit PAT and append
`?account_id=<CAKEMAIL_ACCOUNT_ID>` wherever the OpenAPI operation accepts it.
Record a redacted response or checksum for each check. The IDs and fields below
must match exactly before constructing `CAKEMAIL_ACTIVATION_BINDING_JSON`:

| Object | Read operation | Required evidence |
|---|---|---|
| Account | `GET /accounts/self` | `data.id` equals the configured account ID, `status` is `active` or `trial`, `usage_limits.use_email_api` is `true`, and both the monthly limit and remaining Email API allowance are greater than zero. |
| List | `GET /lists/{list_id}` | `data.id` equals `CAKEMAIL_LIST_ID`, `status` is `active`, and `policy_accepted` is `true`. |
| Senders | `GET /brands/default/senders/{sender_id}` once per ID | `data.id` is exact, `data.email` is exactly the mapped `@27pm.org` mailbox, and `confirmed` is `true`; no two mailboxes share an ID. |
| DKIM | `GET /brands/default/dkim`, then `GET /brands/default/dkim/{id}` | The selected domain-default key has `domain` exactly `27pm.org`, a new non-conflicting `selector`, `status=active`, and `live_dns_status=valid`. |
| Domains | `GET /brands/default/domains/default` | The automated gate requires `dkim` exactly `27pm.org`, `bounce` exactly `CAKEMAIL_BOUNCE_HOSTNAME`, and `tracking` exactly `CAKEMAIL_TRACKING_HOSTNAME` (never `email.27pm.org`). It records `auth` for manual review but does not enforce an exact expected auth-domain value. |
| Domain DNS | `GET /brands/default/domains/default/validate` | Every required entry returned in `data.bounce` and `data.tracking` has `valid=true`, and the live DNS values equal the reviewed Cakemail instructions. |

The DKIM API state is necessary but not sufficient. Because the production
DMARC record uses strict alignment, the received-message canary must still
prove `dkim=pass` with exactly `d=27pm.org`. Likewise, the domain API result is
not permission to overwrite an existing record: stop if any requested owner
name collides with Mailgun or another service.

## Identity and event correlation

Cakemail returns a provider UUID, not an Internet `Message-ID`. Migration 0014
keeps these values separate:

- `transport_provider` records `mailgun` or `cakemail`;
- `provider_message_id` stores the provider UUID/identifier used by callbacks;
- `external_message_id` stores the RFC `Message-ID` used for replies and
  `References`.

Historical rows are backfilled as Mailgun. A provider switch never rewrites
that provenance. Immediately before the non-idempotent provider request, the
CRM also stores a bounded snapshot of the exact compliant body, original
operator, timestamp, mailbox, recipient, and conversation reference. If the
provider accepts but the secondary CRM transaction fails, a retry with the
same idempotency key repairs only those local records from that snapshot; it
does not regenerate the footer or contact Cakemail again.
For Cakemail, that snapshot and the `messages` row contain only the configured
HTML or text part that actually crossed the provider boundary, together with
the selected content mode. Mailgun continues to record both transmitted MIME
alternatives. The dashboard derives a plain display string from stored HTML
when no transmitted text part exists; it does not label the untransmitted
composed alternative as sent.

Cakemail events use the separate endpoint:

```text
POST https://crm.27pm.org/api/webhooks/cakemail/events
```

Treat the current OpenAPI document as the provisioning contract. Cakemail's
prose webhook guide describes an older/different shape and is not sufficient
evidence for a production configuration. Re-check the live OpenAPI immediately
before provisioning and stop for review if its request, response, signature,
or event contracts have changed.

Create one Cakemail webhook per required event with
`POST /webhooks?account_id=<CAKEMAIL_ACCOUNT_ID>`. The current request accepts
one scalar `event`, not an event array, and `rate_limit_period` accepts only
`second` or `minute`:

```json
{
  "event": "Email.Delivered",
  "url": "https://crm.27pm.org/api/webhooks/cakemail/events",
  "rate_limit": 50,
  "rate_limit_period": "second"
}
```

Repeat that one-event POST for `Email.Sent`,
`Email.Delivered`, `Email.Rejected`, `Email.Error`, `Email.Bounced`,
`Email.ReportedAsSpam`, `Email.Unsubscribed`, and `Email.GlobalUnsubscribed`.
Do not provision additional active hooks such as `Email.Submitted` or
`Email.Queued`: they are redundant with the CRM's durable REST acceptance
record, and the activation preflight requires the exact eight-hook set above.
Contact-only webhook events are deliberately rejected because they do not carry
the email UUID needed to correlate a message.

The create response does not expose the signing key. Immediately after every
POST, call
`GET /webhooks/{webhook_id}?account_id=<CAKEMAIL_ACCOUNT_ID>` and fail the
provisioning run unless all of these fields are exact:

- `id` and `data.id` equal the ID returned by the create call;
- `data.event` equals the single requested event;
- `data.url` equals the HTTPS CRM callback above;
- `data.status` is `active`;
- `data.rate_limit` and `data.rate_limit_period` equal the reviewed values;
- `signature.hash_function` is `sha256`; and
- `signature.key` is present and is stored only in that event's runtime-secret
  array.

Map every event to its own secret array; reusing one secret for multiple events
is rejected so a delivery-only secret cannot authenticate a complaint or
unsubscribe. During rotation, put the current and retiring key in that event's
array, then remove the retiring key only after the old webhook is archived and
provider retries have drained. The current OpenAPI has no webhook DELETE
operation: use
`POST /webhooks/{webhook_id}/archive?account_id=<CAKEMAIL_ACCOUNT_ID>` and
confirm `data.status=archived`; do not invent a delete call. The bounded mapping
supports all eight required webhooks plus one complete rotation overlap.

The CRM endpoint currently verifies `X-Cakemail-Signature` as Base64
HMAC-SHA256 over the exact raw request bytes, checks the signature against the
configured webhook secrets, bounds the body, prefixes callback identities with
`cakemail:`, and deduplicates signed payloads. This is the implemented callback
contract to prove with a real signed sample, not an assumption that the
provisioning OpenAPI documents the callback envelope. The raw JSON is retained
for audit while known email events are normalized into the existing delivery timeline.

Cakemail does not sign a separate delivery timestamp with a documented
freshness contract. The handler therefore authenticates the complete raw body
and prevents exact replay by its SHA-256 identity instead of rejecting delayed
legitimate retries by age.

The OpenAPI does not publish the complete signed callback body or retry
schedule. Before enabling Cakemail outbound, keep
`CRM_OUTBOUND_PROVIDER=mailgun`, exercise controlled canaries through the new
webhooks, and retain redacted raw signed samples for every required event class.
Verify from those real samples the event name, provider email UUID, timestamp,
hard-versus-soft bounce signal, and any unsubscribe/complaint identity that the
normalizer consumes. Do not enable on the basis of a hand-authored fixture or
the stale prose guide. Any observed shape that the handler cannot classify and
correlate is an activation blocker, not permission to loosen signature checks.

An unclassified bounce is never enough to suppress a recipient. Only an
explicit hard-bounce signal may create the bounce tombstone; complaints and
unsubscribe events remain immediate idempotent suppressions. Because Cakemail
does not publish a complete callback schema or retry schedule, keep its event
handler enabled during rollback and reconcile unresolved messages against the
provider before resuming another transport.

## Required canary evidence

Before recording the activation binding and satisfying all configuration
gates,
use a separately operator-reviewed, single-recipient request for **every
configured sender address** against Cakemail's API with the same payload
produced by `buildCakemailPayload`. At minimum this means one received canary
for `bonjour@27pm.org` and one for `alexis@27pm.org`; include
`admin@27pm.org` if its optional ID is configured. Each canary is intentionally
run outside the production CRM route with a non-deployed token requested only
for `emailapi:send` and carrying Cakemail's automatic read closure; the
production route never bypasses its activation gates. Retain each raw
received message and verify all of the following for every identity:

Generate and inspect the exact payload first:

```bash
export CAKEMAIL_CANARY_FROM='alexis@27pm.org'
export CAKEMAIL_CANARY_RECIPIENT='<controlled-recipient>'
export CAKEMAIL_CANARY_SENDER_ID='<confirmed-sender-id>'
export CAKEMAIL_CANARY_PARENT_MESSAGE_ID='<lowercase-parent-id@domain>'
export CAKEMAIL_LIST_ID='<positive-list-id>'
export CAKEMAIL_CONTENT_MODE='html'
export CAKEMAIL_CANARY_UNSUBSCRIBE_URL='https://crm.27pm.org/api/public/unsubscribe?token=<controlled-token>'
npm run cakemail:canary-payload
```

`CAKEMAIL_CANARY_SENDER_ID` must exactly equal the runtime sender ID mapped to
`CAKEMAIL_CANARY_FROM` and must be at most 128 characters.

The preview prints the exact payload, its external `Message-ID`, its SHA-256,
and the matching approval string. Freeze those exact values before sending;
otherwise the sender aborts before any network request:

```bash
export CAKEMAIL_CANARY_EXTERNAL_MESSAGE_ID='<externalMessageId-from-preview>'
export CAKEMAIL_CANARY_PAYLOAD_SHA256='<payloadSha256-from-preview>'
export CAKEMAIL_CANARY_APPROVAL='send-one-canary-to:<controlled-recipient>:sha256:<payloadSha256-from-preview>'
npm run cakemail:canary-payload
```

The second preview must have the same SHA-256. Only after the operator has
reviewed that exact output and gives immediate approval naming the recipient
and digest, provide a non-deployed, account-restricted PAT requested with only
`emailapi:send` plus the account ID, then run the one-call sender. Cakemail may
report the resulting effective scopes as `emailapi:read` plus `emailapi:send`.
The sender pins the official origin, sends exactly once, and never retries an
ambiguous response:

```bash
export CAKEMAIL_PAT='ck_pat_<40-lowercase-hex-characters>'
export CAKEMAIL_ACCOUNT_ID='<positive-account-id>'
npm run cakemail:canary
```

The canary PAT is a send-only-request credential, not an administrative PAT. It
may be the future runtime PAT before deployment or a separate short-lived
canary PAT; do not grant scopes beyond Cakemail's automatic `emailapi:read`
closure. Clear the local shell variables
after retaining the redacted request and received-message evidence. The digest
gate is an additional technical control and never replaces immediate human
approval for the exact external email.

The payload always uses the exact production display name associated with the
selected mailbox. If `CAKEMAIL_CANARY_FROM_NAME` is supplied, it must equal that
name exactly. Immediately before the provider request, the script atomically
creates a mode-0600 receipt keyed by the payload digest under
`~/.local/state/27pm-crm/cakemail-canaries/`. A second attempt with the same
digest is refused, including after an ambiguous or rejected response. Never
delete that receipt to force a retry; construct and review a new payload and
obtain a new recipient-and-digest approval instead.

After the provider boundary returns or fails, the script atomically publishes
a separate mode-0600 `<digest>.result.json` beside that immutable reservation.
It records `accepted`, `rejected`, or `outcome_unknown` plus the account ID,
recipient, external Message-ID, provider UUID when available, and HTTP status
when known; it never records the PAT or response body. Failure to persist that
terminal evidence is itself a do-not-retry condition. Preserve both files with
the received-message evidence.

1. The configured list policy is accepted, every sender is confirmed, and the
   authenticated/branded domain setup is ready.
2. The selected audience mode is proven: source enforcement restricts sends to
   compliant permission/relationship traffic, or the exact written Cakemail
   exception and its digest/reference are retained and bound in version 2.
3. The visible `From` is unchanged and `Reply-To` is the selected CRM mailbox.
4. The generated `Message-ID`, `In-Reply-To`, and `References` are preserved.
5. `List-Unsubscribe` and `List-Unsubscribe-Post` are present and the one-click
   POST immediately suppresses the contact in the CRM.
6. `dkim=pass` signs with exactly `d=27pm.org`, `dmarc=pass` remains valid under
   strict alignment, and the unsubscribe headers are covered by DKIM.
7. No open pixel or rewritten click URL appears.
8. The REST `201`/`queued` result is retained separately. Signed `Email.Sent`,
   `Email.Delivered`, `Email.Rejected`, `Email.Error`, `Email.Bounced` (hard and
   soft variants), `Email.ReportedAsSpam`, `Email.Unsubscribed`, and
   `Email.GlobalUnsubscribed` samples are each accepted once and deduplicated on
   replay.
9. Replies still arrive through the unchanged Mailgun MX/routes and attach to
   the correct conversation.

After activation, review the deliverability dashboard by **outbound transport**
as well as by mailbox provider; Mailgun history and Cakemail traffic are never
merged into one transport reputation row.

## Resolving an unknown provider outcome

A timeout, network interruption, 5xx, or malformed success after dispatch is
deliberately non-retryable. The UI retains the original draft/key and warns the
operator not to edit or resend it. Do not create a modified draft while the
outcome remains unknown: Cakemail may already have accepted the first request.

An authenticated operator can list unresolved Cakemail commands without
exposing their bodies:

```http
GET /api/admin/cakemail-send-resolution
```

Each row supplies the exact command ID, branded external Message-ID, sender,
recipient, subject, selected content mode, dispatch time, and whether the
stored snapshot remains valid. Explicit `transport_outcome_unknown` rows appear
immediately. A `dispatching` row with no failure code appears only after five
minutes; that is the fail-safe state left if both post-acceptance D1 writes
failed.

Investigate with a separate, non-deployed administrative credential and the
Cakemail console or its documented `GET /v2/logs/emails` activity log. Use the
sender, recipient, subject, `source-crm` / `traffic-prospecting` tags, and
dispatch window only to find candidates: those fields are not a unique key and
the log endpoint does not provide recipient/subject filters. For every
candidate UUID, call `GET /v2/emails/:id`. In the returned
`additional_headers` array, find the `{ "name": "Message-ID", "value": "..." }`
entry and require its value to equal the admin row's `externalMessageId`
wrapped in RFC angle brackets, exactly: `<cakemail.<uuid>@27pm.org>`. Do not
attach a UUID without that unique match. Retain a redacted export or checksum
and never paste a PAT into the evidence reference.

After that independent check, post one same-origin, explicitly confirmed
resolution. An acceptance requires the exact Cakemail UUID:

```json
{
  "confirmed": true,
  "commandId": "<command-uuid>",
  "externalMessageId": "cakemail.50f8f14b-dc70-4415-a587-235a86e833d3@27pm.org",
  "resolution": "accepted",
  "providerMessageId": "<cakemail-email-uuid>",
  "verifiedMessageIdHeader": "<cakemail.50f8f14b-dc70-4415-a587-235a86e833d3@27pm.org>",
  "providerObservedAt": "<canonical-provider-event-timestamp>",
  "evidenceReference": "<redacted-log-export-or-support-reference>"
}
```

A rejection must be supported by affirmative provider evidence that the
request was not accepted; a temporarily empty search result is not enough. Do
not include `providerMessageId` or `verifiedMessageIdHeader` for this form:

```json
{
  "confirmed": true,
  "commandId": "<command-uuid>",
  "externalMessageId": "cakemail.<uuid>@27pm.org",
  "resolution": "rejected",
  "providerObservedAt": "<canonical-provider-event-timestamp>",
  "evidenceReference": "<redacted-rejection-or-support-reference>"
}
```

`providerObservedAt` must fall between the stored dispatch time and 31 days
after it. The endpoint rejects a provider UUID already attached to another
external Message-ID, and an accepted resolution is invalid unless
`verifiedMessageIdHeader` exactly matches the stored external Message-ID in
angle brackets. State transition and audit evidence are one atomic D1 batch.
For an accepted result,
it then repairs the local CRM record from the
pre-dispatch snapshot and links any earlier callbacks. The endpoint contains no
provider client and never sends or retries an email. Repeating the exact same
resolution is idempotent; a contradictory resolution is rejected. If the
provider evidence is still ambiguous, leave the command blocked.

## Rollback

Set `CRM_OUTBOUND_PROVIDER=mailgun` (or remove it) to restore the existing send
path. Keep the Cakemail webhook secrets and handler available while accepted
Cakemail messages drain, reconcile all non-terminal provider IDs, and import
any complaints, hard bounces, or unsubscribes before normal Mailgun sending
resumes. Do not change the MX records as part of this rollback.

Provider contracts used for this implementation:

- [Cakemail OpenAPI](https://api.cakemail.dev/openapi.json)
- [Cakemail REST sending guide](https://dev.cakemail.com/en/guides/sending-emails-rest-api)
- [Cakemail webhook guide](https://dev.cakemail.com/en/guides/using-webhooks)
- [Cakemail anti-spam policy](https://www.cakemail.com/legal/anti-spam-policy)
