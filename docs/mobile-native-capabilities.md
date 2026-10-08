# Native mobile capabilities: implementation and release gates

This extends draft PR #4 on top of `79b06091765b47b4918e9c42a27af8f19b0b706a`.
It changes source and local tests only. No production migration, deployment,
secret, environment value, domain, storage resource, or scheduled job is changed.
The default remains **attachments disabled**. Do not merge as an activation step.

## Architecture and contract

The client-facing host remains `crm.27pm.org`; no subdomain, literal IP,
public object URL, or cross-host redirect is added for native attachments.
The existing implementation is App Router source targeting Workers/D1 (`DB`)
and private R2 (`BUCKET`), not a writable Next.js filesystem. Web Crypto and
Web Streams require neither `node:fs` nor a Node-only upload runtime.

Vercel's BFF remains an independent safety boundary: it replaces a successful
upstream capabilities response with `{"attachments":false}` and returns 503 for
native attachment routes without forwarding their body. Adding R2 behind a
Vercel Function does not remove that function's 4.5 MB request limit. Native
uploads require 20 MiB (20,971,520 bytes), plus the multipart envelope. A verified
same-public-host Worker route, or an explicitly coordinated client-contract
change, is still required before activation. No routing change is made here.

Official platform references:
- https://vercel.com/docs/functions/limitations#request-body-size
- https://developers.cloudflare.com/r2/api/workers/workers-api-reference/

The reference `ios-27pm-crm/docs/crm-27pm-org-api-contract.md` could not be
retrieved through the connected GitHub account. Client behavior described below
is from the supplied guide, not an independent verification of Swift source.
In particular, verify handling of quarantine (`423`) before enabling uploads.

## Existing endpoints retained

| Method and path | Success | Guard |
| --- | --- | --- |
| GET /api/mobile/capabilities | 200, attachments boolean | Device bearer, dashboard-read scope |
| POST /api/mobile/attachments | 200, id | Device bearer, work scope |
| GET /api/mobile/attachments?ownerKind=&ownerId= | 200, attachments array | Device bearer, dashboard-read scope |
| DELETE /api/mobile/attachments/{id} | 204, including missing id | Device bearer, work scope |
| GET /api/mobile/attachments/{id}/file | 200, authenticated private stream | Device bearer, dashboard-read scope |

All responses are private/no-store. Mutations retain the existing cross-origin
guard. Read permission is `crm:dashboard:read`; mutation permission is
`crm:work`. These are CRM-wide administrator scopes, not tenant-specific ACLs.
Missing/invalid authentication is 401, denied scope is 403, infrastructure
failure is 503. Never trigger token rotation for a storage or validation error.
New metadata records the verified device-session reference, not a supplied
client identity. No interaction-logging endpoint is introduced.

The authenticated list includes the lowercase content `sha256` alongside the
public attachment metadata. It never includes an R2 key or storage URL. The
digest lets a native client safely recover a lost upload acknowledgement when
owner-scoped deduplication retained an older filename from another device.

## Migrations and dashboard

`0018_married_praxagora` is reserved for `internal_api_nonces`; leave it unchanged.
`0019_milky_maestro` adds `organizations.address`, `organizations.city`, and
`mobile_attachments`. Do not recreate the existing email `attachments` table or
add `contacts.phone` again. The dashboard already exposes these fields in the
feature branch. Address editing/import and the iOS local-address merge are not
implemented by this server-side patch.

Run migrations only through the established migration process, once, against an
identified database with a tested backup. A nullable SQLite ADD COLUMN does not
justify promising zero locks, zero traffic impact, or safe deployment in arbitrary
order. The dashboard selects the new columns: migrate before deploying that code.

The read-only capability probe now checks columns required from 0018/0019,
contact phone, and the exact partial unique dedup index. It never reads customer
rows and never applies SQL migrations. This checks structural prerequisites,
not the migration ledger, backup availability, bucket permissions, or live
transport/scanner health. A partial or incompatible schema stays unavailable.

## Upload, integrity and retry behavior

Multipart accepts exactly one `ownerKind`, `ownerId`, and `file`, with no extra
metadata fields. The entire encoded body is bounded at 21 MiB before parsing;
the file itself is limited to 20 MiB. Invalid lengths, mismatched declared
lengths, encoded bodies, duplicate fields and non-multipart input are refused.
Empty files return 400, oversized files 413, disallowed types 415, missing
owners 404. No storage key, checksum, scanner verdict or audit identity is
accepted from the client.

MIME allowlisting is supplemented with executable-name/magic rejection and
basic format signatures. An executable cannot bypass the prefilter just by
claiming image/jpeg or application/octet-stream. This is not antivirus scanning
or a complete format parser. UTF-8 is required for declared text/plain and
text/csv. Unsupported binary content can remain octet-stream, still quarantined.

R2 PUT receives the native `sha256` option. Only after PUT completes is D1
metadata inserted. The existing partial unique index arbitrates simultaneous
identical uploads. A return of the existing id also requires the actual R2
object to match the database key, length and native checksum. Missing or
inconsistent storage fails with 503 rather than falsely marking an iOS item
synced. Custom metadata containing a checksum is not sufficient proof.

An uncertain INSERT result never deletes potentially committed bytes. A losing
concurrent upload may clean only its own unreferenced key; failed cleanup leaves
an orphan, not a broken winning attachment. Tombstoning must be confirmed before
object deletion. Retrying DELETE reattempts deletion even for a tombstone. An
invalid key cannot cross from the native namespace into email attachment objects.

## Quarantine and scanner producer contract

Every uploaded object starts with server-controlled R2 custom metadata:

```text
scanStatus=unscanned
scanPolicy=sha256-bound-r2-v1
```

An independent trusted scanner must inspect the full current object and, only on
success, publish:

```text
scanStatus=clean
scanPolicy=sha256-bound-r2-v1
scanSha256=<lowercase SHA-256 of the bytes actually scanned>
```

No scanner service, scan-complete API, public metadata writer, or manual bypass
is implemented. Never mark a file clean merely from MIME, extension, database
metadata, or an upload succeeding. Restrict scanner writes to the private
bucket. When updating R2 metadata via a full object rewrite, preserve and
resubmit the native SHA-256; verify it against the bytes scanned. Replaced
content requires a new scan, and errors/malware remain quarantined.

Download checks the metadata and bytes from the **same R2 GET**, including the
native SHA-256, length, object key, scan policy and hash-bound clean verdict.
No verdict, pending/error/infected verdict, or verdict for another hash returns
`423 {"error":"attachment_quarantined"}`. Missing bytes/native checksum or an
integrity mismatch returns `503 {"error":"attachment_storage_unavailable"}`.
Rejected object streams are cancelled before any binary response is returned.
Successful downloads are attachment-disposition streams with private/no-store,
nosniff, no-referrer, same-origin resource policy, and a restrictive CSP. No
public ETag or storage URL is exposed. LIST retains metadata for quarantined
files without exposing storage keys or scanner internals.

## Activation remains a separate operation

Source defaults:

```text
ATTACHMENTS_ENABLED=0
MOBILE_ATTACHMENTS_RUNTIME=
MOBILE_ATTACHMENTS_SCAN_POLICY=
```

A compatible Worker requires the explicit runtime `cloudflare-r2` and scan
policy `sha256-bound-r2-v1` in addition to the enable flag. These are operator
attestations, **not proof that a scanner, transport or backups work**. Never set
them to make a test pass. The Vercel guard stays false independently. This patch
does not set any production flag or drain a device queue.

Before considering activation: identify the Worker and its DB/BUCKET; verify the
migration ledger and schema; establish/restoration-test D1 plus R2 backups;
integrate and test the scanner including failures; validate 20 MiB multipart and
downloads on the one public hostname without redirects; verify real bearer
401/403 behavior, concurrency, interrupted upload replay, deletion replay,
quarantine handling and iOS offline/online synchronization. Run those tests on
isolated fixtures first, with the production capability still disabled.

Do not use a real customer owner id for write tests. Use a disposable account
and file. Local test mocks are not evidence of production health or iOS behavior.

## Recovery and operations still required

A source snapshot or Vercel rollback is not a D1/R2 backup. Taking an object copy
first and a later database export is not enough: an upload between them can
leave the database referencing a missing backed-up object. Coordinate a write
barrier or an immutable/versioned object inventory covering the DB snapshot;
retain bytes needed by the backup/soft-delete retention policy. Test complete
restoration and record hashes, counts, timestamps and the actual restore steps.

No cron, purge, retention period, quota or monitoring configuration is provisioned.
A future reconciler must conservatively handle uncertain uploads, losing-upload
orphans, tombstones with failed object deletion and missing active objects.
Never purge solely because an object is absent from one stale database snapshot.
Coordinate the grace period and restored snapshots before enabling deletion.

## Validation of this hardening change

The tests execute the unchanged 0018/0019 SQL in disposable in-memory SQLite and
use a bucket test double modeling native R2 checksums and trusted scan metadata.
The test-only `markClean` helper is not deployed. Tests cover quarantine,
integrity tampering, missing objects, concurrent dedup, unknown post-commit
errors, tombstone failures, schema/index drift, exact size boundaries,
executable disguises and strict multipart validation. Existing tests retain
owner isolation, repeat delete/reupload, private headers and route auth wiring.
Route auth-wiring checks are source assertions, not bearer-session E2E tests.

Local run: 37 targeted tests passed (27 new and 10 retained), no failures or
skips, with Node 22.16.0 and native TypeScript transformation. Because the
container cannot fetch the complete repository/dependencies, the unchanged BFF
module was verified against its Git blob hash and its transport unit test ran
with unused authentication imports replaced by throwing test doubles. Real
authentication was not tested. The standard repository command remains
`node --import tsx --test tests/mobile-attachments*.test.mjs`; this command was
not used in the offline container. The offline loader is not part of the PR.

A complete package install, full-suite run, native Next/Vercel build and live
HTTP/iOS verification are separate release gates. Do not reuse validation
counts from an earlier commit as evidence for this change. No GitHub Actions
run is requested by this work.
