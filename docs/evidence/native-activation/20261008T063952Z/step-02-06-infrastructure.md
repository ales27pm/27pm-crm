# Steps 02, 04, 05 and 06 — infrastructure boundary

## Step 02 — environment and access

- UTC reads: `2026-10-08T06:03:45Z` and `2026-10-08T06:31:51Z`.
- Environment: Linux implementation host plus iMac `macOS 15.7.9`, Xcode `26.3 (17C529)`, Swift `6.2.4` over the existing private SSH/Tailscale path.
- Local hosting contract at candidate parent: `.openai/hosting.json` names Sites project `appgprj_6a8d706605548191a846e670fafdc72b`, logical D1 binding `DB` and logical R2 binding `BUCKET`. Logical names are not physical resource identities.
- Redacted operation: `npx --no-install wrangler whoami`; exit `0`, observed `not authenticated`. No Cloudflare provider credential variables were printed or decrypted.
- The runtime has no Vercel CLI/project link and no native Sites administration action. Therefore full alias pagination, immutable production-deployment reread and the exact existing Worker/D1/R2/service-binding inventory cannot be refreshed here.
- Public DNS and HTTP still terminate at Vercel. Exact probe operation: `curl` with normal TLS verification, `--max-redirs 0`, bounded connect/total timeout and discarded response body. Independent Cloudflare control: HTTP `200`, redirects `0`, TLS verify result `0`. CRM capability: HTTP `404`, effective URL `https://crm.27pm.org/api/mobile/capabilities`, redirects `0`, TLS verify result `0`.
- Actual iOS source: authenticated Rork project `27pm CRM`, recovered root `ios-27pm-crm/`; the candidate repository names `ales27pm/ios-27pm-crm` and `27pm/ios-27pm-crm` both returned authenticated GitHub `404` and repository/code inventory found no accessible replacement.
- Usable app workspace: `/Users/ales27pm/Developer/27pm-crm-ios/App27pmCRM.xcodeproj`; scheme `App27pmCRM`; iPhone 16 simulator `710EFEFE-73D8-400B-B5D1-D5F43662B536`, iOS `26.3.1`; deployment target iOS 18; bundle `org.27pm.crm.mobile`, version `1.0.0 (2)`.

[STEP 02] BLOCKED — iOS source/workspace/runner are resolved, but public gateway ownership, the existing data Worker, physical D1/private R2, scanner service binding and authorized release control are not linked by an authenticated authoritative read; mutation performed: recovered source copied into a new isolated iMac directory, preserving the pre-Step07 backup at `/Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T021416Z-pre-step07/`.

## Step 04 — backup and real restore

The reviewed procedure requires a coordinated source-derived D1 export and R2 inventory (key/version/length/SHA-256), restoration into isolated real D1/private R2 resources, relational/schema checks, every active native/email attachment reference checked against restored bytes, rescanning restored versions and measured recovery time. No owning physical resource is accessible, so no export was taken and no disposable provider resource was created. The offline verifier remains an additional check only and was not misrepresented as a real restore.

[STEP 04] BLOCKED — no coherent real D1/private-R2 restore evidence; mutation performed: none.

## Step 05 — migrations

The candidate still preserves `0018_married_praxagora` for `internal_api_nonces` and `0019_milky_maestro` for organization `address`/`city` plus `mobile_attachments`; existing email attachments and `contacts.phone` are not recreated. Local health validation checks the exact nullable `TEXT` shape and partial unique deduplication index. The authoritative remote schema and real migration ledger could not be read, and Step 04 did not pass.

[STEP 05] NOT_RUN — no rehearsal or production migration; mutation performed: none.

## Step 06 — private scanner

Local Python harness tests exercise fail-closed reporting and fixture construction only. No deployed ClamAV provenance/version/configuration/signature freshness, verified Unix socket, restricted adapter identity, secret-store token, `ANTIMALWARE` service binding, real `/health`, scan or object-bound receipt was available. No shared production scanner was interrupted.

[STEP 06] BLOCKED — zero real-engine/binding controls are claimed; mutation performed: none.
