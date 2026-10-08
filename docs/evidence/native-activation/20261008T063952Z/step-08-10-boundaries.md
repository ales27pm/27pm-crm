# Steps 08–10 — transport, operations and activation boundary

## Step 08 — exact public-host transport

At `2026-10-08T06:31:51Z`, an independent network control returned HTTP 200 while `GET https://crm.27pm.org/api/mobile/capabilities` returned HTTP 404 with normal TLS verification, zero redirects and the same effective URL. This is a real server response, not a DNS/tool failure. Public DNS/header inspection identifies Vercel as the current terminator; no attached native gateway deployment was proven.

No supported restricted canary exists in the accessible control plane. No customer identity was used, no bearer was forged, no magic header/debug endpoint was added, and no write request was sent. Consequently none of the required real-auth 401/403/capability/upload/boundary/list/download/423/dedup/interrupted-ACK/delete/DNS64 observations is claimed. Unit/simulator evidence is kept separate.

[STEP 08] BLOCKED — smallest safe resume arrangement: an access-controlled canary routing every reviewed native endpoint through `worker/native-gateway.ts` and the private `CRM_BACKEND` binding to isolated restored resources, with disposable identities issued by the real auth contract; mutation performed: read-only probes only.

## Step 09 — operational readiness/publication

Source documents define conservative disable/rollback and retention/reconciliation boundaries, but no provider-backed quota, backlog alert, persistent-quarantine monitor, real restore rehearsal, scanner deployment or gateway rollback was observable. The tested CRM code commit `5e22d1258beb5df994173bee0243d3ac35d8ebe8` was published to the review branch without merging, but it was not deployed to production. The recovered iOS source has no accessible repository/review branch. A simulator binary is not a deployable TestFlight identity. Read-only iMac inspection found three local signing identities, no connected App Store Connect API environment and no reviewed TestFlight export-options plist, so no archive/upload was attempted.

The only repository workflow is `.github/workflows/verify.yml`, triggered by `pull_request` and pushes to `main`. Prior `[skip ci]` publication produced no new GitHub Actions run but did produce a Vercel preview; external integrations remain independent. The latest user instruction keeps PR #4 ready for review, not draft, while still prohibiting merge until gates pass.

[STEP 09] BLOCKED — immutable real deployment identities and operational controls do not exist for every component; mutation performed: no production deployment or merge.

## Step 10 — activation

Required Steps 02, 04, 06, 08 and 09 are not PASS. `ATTACHMENTS_ENABLED`, `NATIVE_GATEWAY_ENABLED`, `MOBILE_ATTACHMENTS_RUNTIME` and `MOBILE_ATTACHMENTS_SCAN_POLICY` were not changed. No D1 migration, R2 object, scanner configuration, DNS/route, Vercel alias or production deployment was changed. The observable capability endpoint remained HTTP 404, so no rollback was necessary.

[STEP 10] NOT_RUN — production native attachments were not activated and their state is not inferred from flags alone; mutation performed: none.
