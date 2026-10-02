# Vercel migration runbook

The migration keeps the CRM data plane on Cloudflare and moves the operator
interface plus Web authentication to Vercel. This avoids a high-risk rewrite
of the existing D1 queries, D1 transactions, R2 objects, webhooks, and mobile
session state.

## Target architecture

- Vercel serves the Next.js pages and Auth.js Google login.
- `proxy.ts` is the Web backend-for-frontend boundary for `/api/*` except
  `/api/auth/*`.
- An authenticated same-origin browser request receives a 30-second HMAC
  assertion bound to operator email, audience, method, pathname, query, body,
  the canonical `content-type` and `idempotency-key` values, expiry, and a
  random nonce. Auth.js cookies, incoming identity headers, and client-supplied
  forwarding/IP headers are removed before the request leaves Vercel.
- The Cloudflare Worker verifies the assertion before the application router,
  consumes its nonce atomically in D1, and only then injects the legacy trusted
  operator header. A replay is rejected.
- Requests without a Web session are proxied without an operator assertion so
  the existing public and mobile bearer-token routes retain their own guards,
  except public intake, which is refused until its client-IP contract moves.
- D1 and R2 remain authoritative on Cloudflare. Existing mobile access and
  refresh tokens therefore keep the same issuer, signing key, and state.

## Build targets

- `npm run build` remains the verified Vinext/Sites build.
- `npm run build:vercel` runs the native Next.js build used by `vercel.json`.
- The Vercel build aliases `cloudflare:workers` to an empty binding object only
  while analyzing the legacy API modules. `proxy.ts` must intercept those
  routes in production; accidental local execution remains fail-closed because
  no DB or bucket binding exists on Vercel.
- `next.config.ts` applies the same five private-surface security headers as
  the Worker.

## Environment contract

Configure Vercel with:

```text
CRM_WEB_IDENTITY_PROVIDER=google
CRM_ADMIN_EMAILS=<explicit operator allowlist>
CRM_API_ORIGIN=https://<dedicated-worker-host>
CRM_INTERNAL_API_AUDIENCE=27pm-sites-worker
CRM_INTERNAL_API_SIGNING_KEY=<dedicated random base64url secret, at least 32 bytes>
AUTH_SECRET=<dedicated Auth.js secret>
AUTH_GOOGLE_ID=<Google OAuth client id>
AUTH_GOOGLE_SECRET=<Google OAuth client secret>
CRM_PUBLIC_ORIGIN=https://crm.27pm.org
CRM_MOBILE_REDIRECT_URI=https://crm.27pm.org/mobile/oauth/callback
CRM_IOS_APP_ID=<Apple Team ID plus bundle ID>
```

The Google OAuth Web callback must be exactly:

```text
https://crm.27pm.org/api/auth/callback/google
```

Use a stable custom staging hostname for preview authentication, for example
`crm-preview.27pm.org`, and register its exact callback with Google as well:

```text
https://crm-preview.27pm.org/api/auth/callback/google
```

Set the preview `CRM_PUBLIC_ORIGIN` to that stable hostname. A changing
`*.vercel.app` preview URL cannot be covered by a wildcard Google redirect.
Testing the Universal Link on staging also requires the staging hostname in the
iOS Associated Domains entitlement and a matching staging mobile redirect URI;
otherwise reserve that boundary check for the controlled production canary.

Configure the Worker/Sites backend with the same internal audience and signing
key. Use `CRM_API_AUTH_MODE=hybrid` while the Sites UI must continue to accept
its platform identity, and set
`CRM_SITES_TRUSTED_ORIGIN=https://crm.27pm.org`. In both `sites` and `hybrid`
mode the raw Sites identity headers are accepted only at that exact origin;
the dedicated backend hostname strips them. Hybrid mode still accepts a valid
signed assertion there. Switch to `internal` only after the Vercel cutover is
proven. `CRM_API_AUTH_MODE` is mandatory: missing, empty, and unknown values
fail closed.

Configure these attachment values on the Worker/Sites backend only:

```text
CRM_ATTACHMENT_DOWNLOAD_ORIGIN=https://files.crm.27pm.org
CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY=<separate random base64url secret, at least 32 bytes>
```

The origin is the exact dedicated Worker hostname that serves
`/downloads/attachments/*`; it must not be the Vercel hostname. The signing key
must not be configured on Vercel. The checked-in Wrangler override enables
`observability.redact_query_string=true`, because a 45-second download ticket
is a bearer secret carried in the URL. Before any canary, verify the setting on
the actually deployed Worker version and confirm that logs and traces omit the
query string. A local build or Sites archive alone is not that production
proof. If the platform cannot preserve and prove redaction, do not enable this
URL-ticket flow; move the ticket into a direct POST body instead.

Never expose `AUTH_SECRET`, `AUTH_GOOGLE_SECRET`, or
`CRM_INTERNAL_API_SIGNING_KEY` to client-side variables or commit their values.
Keep `CRM_MOBILE_TOKEN_SIGNING_KEY` only on the Worker; the Vercel authorization
page deliberately does not read it. Apply the same isolation to
`CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY`.

## Required backend preparation

1. Apply migrations `0015` through `0018` in order. Migration `0018` creates
   the one-time internal assertion nonce table.
2. Deploy the Worker code with `CRM_API_AUTH_MODE=hybrid` and a dedicated
   backend hostname before creating a Vercel preview.
3. Keep Mailgun/Cakemail inbound webhooks on the Worker hostname. Vercel
   Functions have a smaller request/response body limit than the existing 12 MB
   Mailgun inbound allowance. Private downloads use
   `POST /api/attachments/:id/download-ticket` to obtain a short-lived,
   one-time Worker URL; `/downloads/attachments/:id` streams R2 bytes directly
   and never traverses Vercel. The legacy binary API now returns
   `410 attachment_download_ticket_required`. New inbound files remain
   `unscanned` and fail closed: this transport change does not implement or
   bypass malware scanning. New writes also provide R2's native SHA-256 and a
   download requires it to match D1. An older object without that native
   checksum fails with `423`; before cutover, inventory any existing `clean`
   rows and re-verify their bytes before a controlled rewrite/backfill.
4. Keep public intake on the Worker hostname until its trusted client-IP
   contract is explicitly moved. The Vercel BFF returns `503` for
   `/api/public/intake` and never relays client-supplied forwarding/IP headers.
   Cloudflare's `cf-connecting-ip` at the end of a Vercel rewrite identifies
   Vercel, not the original visitor.
5. Treat cross-origin or cross-scheme redirects from the Worker as backend
   failures. Only same-backend redirects are rebased to the public CRM origin.

## Cutover checklist

1. Leave `crm.27pm.org` on Sites.
2. Capture a fresh, validated, restorable D1 export and an R2 key/native
   SHA-256 inventory. Resolve every `clean` row whose R2 object lacks the native
   SHA-256. Older backups are not cutover evidence.
3. Apply and verify migrations through `0018`; preserve the current mobile
   token signing key and public origin.
4. Deploy the backend compatibility change first and verify Sites login, CRUD,
   mobile authorization/refresh/revocation, webhooks, and attachments. On the
   deployed Worker, confirm query-string redaction before issuing any real
   download ticket.
5. Create a separate Vercel CRM project. Do not reuse the public `27pm` Web
   project.
6. Configure secrets and the Google callback, then deploy a Vercel preview.
7. Verify rejected identity spoofing, rejected cross-origin mutations, nonce
   replay rejection, operator allowlist enforcement, all CRUD flows, the iOS
   authorization callback, and the security headers. Download a clean test
   object larger than 4.5 MB directly from the Worker, verify its checksum,
   confirm that missing or mismatched native SHA-256, a replay, and a changed R2
   object fail, and inspect Worker logs to prove the ticket query is absent.
8. Change DNS only after preview evidence passes. Retain Sites and its bindings
   as the rollback target until production verification also passes.

## Header verification

For a future preview URL, verify a representative page and API response:

```bash
curl --silent --show-error --dump-header - --output /dev/null \
  "${VERCEL_PREVIEW_URL:?}/"
curl --silent --show-error --dump-header - --output /dev/null \
  "${VERCEL_PREVIEW_URL:?}/api/dashboard"
```

Both must include:

| Header | Required value |
| --- | --- |
| `Permissions-Policy` | `camera=(), geolocation=(), microphone=()` |
| `Referrer-Policy` | `same-origin` |
| `X-Content-Type-Options` | `nosniff` |
| `X-Frame-Options` | `DENY` |
| `X-Robots-Tag` | `noindex, nofollow, noarchive` |

The direct attachment response is stricter: it requires
`Referrer-Policy: no-referrer`, `Cache-Control: private, no-store, max-age=0`,
`Content-Type: application/octet-stream`, `Cross-Origin-Resource-Policy:
same-site`, and no public `ETag`.

## Rollback

Keep the Worker in `hybrid` mode for the entire rollback window. If it has
already moved to `internal`, first restore `CRM_API_AUTH_MODE=hybrid` with the
exact `CRM_SITES_TRUSTED_ORIGIN`, then verify a Sites login and an authenticated
Sites API request at that origin. Only after that proof should DNS be restored
to Sites. Restoring DNS while the Worker remains in `internal` mode leaves the
Sites UI unable to authenticate.

If authentication, data parity, mobile authorization, uploads, webhooks, or
authorization fail, keep or restore DNS to Sites using that order. Do not
delete Sites, D1, R2, or their secrets until rollback has been rehearsed and
the Vercel production boundary is verified.
