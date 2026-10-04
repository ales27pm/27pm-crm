# Native mobile capabilities: source audit and rollout

Audited against main 3cae59b5d852acea17fc976b339200ebf4b2eac1.

## Differences from the supplied guide

- App Router source uses **vinext + Cloudflare Workers**, D1 (`DB`) and private R2 (`BUCKET`), not a local SQLite file/volume. The Vercel project is configured with `npm run build:vercel`, but that script does not exist in main. This PR does not repair the deployment migration.
- `contacts.phone` already exists and is serialized by `/api/dashboard`. Do not add it again.
- `organizations.address` and `city` are new nullable columns, exposed by the dashboard query. Existing organization edit/import flows are not extended here; populating these columns is a separate write-flow task. Demo payload fields remain optional.
- `attachments` already contains email attachments with mandatory `message_id`; retain it unchanged. Native metadata uses `mobile_attachments`.
- Authentication uses the existing verified mobile operator session, allowlist and scopes. All these routes require a bearer; reads use `crm:dashboard:read`, mutations `crm:work` and the existing cross-origin guard. These are CRM-wide administrator permissions, not per-account tenancy. If resource tenancy is introduced, owner lookups and attachment operations must be scoped accordingly.
- Audit identity is the verified `mobileSessionId`. Invalid/absent bearer returns `401 {"error":"authentication_required"}`; insufficient scope remains 403 and authentication service failure 503.
- Object PUT completes before inserting metadata. A partial unique index handles concurrent deduplication. Losing uploads delete their own object, never the winner's. An uncertain DB failure leaves a possible orphan for reconciliation, rather than deleting bytes that might already be committed.
- DELETE tombstones before deleting bytes; retry reattempts object deletion even for a tombstone. Missing ID returns 204. Authorized administrators can clean attachments whose owner was deleted. Files of deleted accounts cannot be read or newly uploaded.
- Downloads stream through the authenticated same-host route with `private, no-store`, `nosniff`, and attachment disposition. No public URL is returned. Attachment disposition differs deliberately from the guide's inline example to avoid inline rendering of untrusted content.
- MIME allowlist is not malware/content verification; octet-stream is allowed by the supplied contract, so an `.exe` extension alone does **not** guarantee 415. Antivirus/quarantine policy remains unresolved. Empty files return 400, oversized files 413.
- Multipart envelopes are bounded at 21 MiB before parsing, files at 20 MiB. Duplicate owner/file form fields are rejected.

## Why activation is blocked on Vercel

Vercel Functions have a 4.5 MB incoming body limit and no persistent writable filesystem:
https://vercel.com/docs/functions/limitations#request-body-size
https://vercel.com/docs/functions/runtimes#file-system-support

R2 or Blob behind a Vercel upload route does not bypass the incoming limit. Direct-to-storage uploads require a client/contract change (currently forbidden by the single-host rule). A compatible upstream upload service under the same public hostname would need its own implementation, routing and E2E validation. This PR does not provision one.

## Safe rollout

1. Back up D1 and private R2. Apply generated migration `0018_woozy_ted_forrester.sql` once through the existing D1 migration workflow. Never apply the guide's conflicting `CREATE TABLE attachments`/`ADD phone` statements.
2. Deploy routes on the existing compatible Workers/D1/R2 stack without changing `crm.27pm.org` routing in this PR. Ensure the R2 bucket has no public access. No `node:fs` or Node-only runtime is required.
3. Leave `ATTACHMENTS_ENABLED=0` (default). The capabilities endpoint returns false; other attachment endpoints return 503 when disabled. No queued iOS uploads should be drained.
4. Before activation, resolve the Vercel-vs-Workers deployment architecture, verify 20 MiB multipart over `crm.27pm.org`, authenticated owner access, concurrent dedup, exact download bytes, delete retries, 401/403/error mapping, backup restoration and iOS offline replay. Source review and local tests are not end-to-end evidence.
5. Only on a validated Workers deployment set `MOBILE_ATTACHMENTS_RUNTIME=cloudflare-r2` and `ATTACHMENTS_ENABLED=1`. The capability additionally checks DB table and bucket methods. It is always false if `VERCEL` is set. These settings assert the operator has validated the upload path; they do not detect proxy limits or prove storage write health.
6. Monitor errors and disable the flag to stop new operations if necessary. Dashboard address/city SELECTs require the migration first. Do not merge/deploy code first against an unmigrated DB.

## Operations still required

- D1 + object backup and restoration testing; soft-deleted file content is only recoverable from a backup.
- Reconciliation task for orphaned objects older than seven days, failed tombstone deletion and missing objects; no cron is provisioned here.
- Quotas, volume alerts, retention policy and abuse controls; no alert or billing resource is changed.
- Malware scanning/content verification policy. File types alone provide no content safety guarantee.
- Reference iOS contract and Swift decoder verification: the separate `ios-27pm-crm` repository was not inspected. This implementation is based on the supplied guide, not a confirmed copy of the reference contract.

## Validation

Nine focused tests cover migration compatibility, feature gating, multipart limits, owner lookup, concurrent deduplication, byte-identical private downloads, deletion retries, storage failures and route auth wiring. Route wiring tests are source checks, not live bearer-session E2E tests.

Local typecheck, lint and vinext build pass. Full suite: 374/415 pass, 41 fail. Baseline main: 365/406 pass, the same 41 failures; no new failing tests. Focused attachment/security tests: 23/23 pass. Production HTTP and iOS validation remain pending. No migration, environment mutation or deployment is performed by this PR preparation.
