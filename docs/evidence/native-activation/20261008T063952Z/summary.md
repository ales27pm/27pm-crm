# Native attachment activation — run `20261008T063952Z`

**Outcome: BLOCKED — NOT ACTIVATED**

- Evidence bundle created: `2026-10-08T06:39:52Z` UTC
- Candidate parent at evidence creation: `8305ac3803a35775a4731e97c7bbdcef7eebb3a1`
- Tested CRM code commit: `5e22d1258beb5df994173bee0243d3ac35d8ebe8`
- Last successful numbered gate: Step 11 (publication only; activation gates remain blocked)
- Production state: native attachment capability is not active; the exact public endpoint returned HTTP 404 with zero redirects and successful TLS verification at `2026-10-08T06:31:51Z`
- iOS source identity: `sha256:bff94c7bc17cb98b6dfd92d12abfa7bf2b5a07ce8b171382ca2b52f785726bc7`
- iOS Release simulator binary: `sha256:adc79f1d968973c657bbd20e48c13ef89b14e6147ce3a93e22fe3a3600bce74c`
- No production, D1, R2, scanner, DNS, Vercel alias, feature-flag, migration, merge, TestFlight or physical-device mutation was performed.

[STEP 01] PASS — refreshed Git, PR, discussion, diff and workflow state; expected an open/unmerged review branch with pre-existing work preserved; observed PR #4 OPEN, non-draft and unmerged at `8305ac3803a35775a4731e97c7bbdcef7eebb3a1`, with local and remote heads equal before this follow-up; evidence: this file and authenticated `gh pr view` at `2026-10-08T06:31:51Z`; mutation performed: none. The non-draft state is an explicit later user instruction to publish for review and supersedes the original draft-only constraint; it does not authorize merge or production activation.

[STEP 02] BLOCKED — refreshed available GitHub, public-origin, local hosting and provider-CLI state while resolving the actual iOS source and runner; expected the existing public gateway, data Worker, physical D1/R2, scanner binding and deployment control; observed the real Rork workspace and working iMac/Xcode runner, but the exact Sites/Cloudflare resources remain unreadable from this runtime and Vercel control-plane pagination is unavailable; evidence: `step-02-06-infrastructure.md`; mutation performed: recovered source was copied to an isolated iMac directory, with no provider mutation.

[STEP 03] PASS — ran the current committed-lockfile install, lint, typecheck, unit suites, builds, scanner harness tests, backup-verifier tests and the byte-identical Swift package on macOS; expected every required local command to exit 0 on candidate code; observed all exit 0, including 555 Node unit tests, 20 antimalware tests, 11 backup-verifier tests and 8 Swift package tests; evidence: `step-03-validation.md`; mutation performed: local dependency/build artifacts only.

[STEP 04] BLOCKED — required a coordinated source-derived snapshot and restore into isolated real D1/private R2 resources; expected authoritative source counts, object lengths/hashes, restored integrity and recovery duration; observed no authenticated access to the owning physical resources, so no production export or real provider restore occurred; evidence: `step-02-06-infrastructure.md`; mutation performed: none.

[STEP 05] NOT_RUN — required Step 04 PASS before migration rehearsal/application; expected authoritative remote ledger/schema comparison and a one-time 0019 application if pending; observed no owning D1/ledger access, so no migration was rehearsed or applied; evidence: `step-02-06-infrastructure.md`; mutation performed: none.

[STEP 06] BLOCKED — required the deployed private ClamAV engine, socket, signatures, adapter binding and receipt/failure controls; expected all seven real engine controls plus private `/health` and through-binding scans; observed only passing harness tests and no access to the real scanner host/binding; evidence: `step-02-06-infrastructure.md`; mutation performed: none.

[STEP 07] PASS — integrated the reviewed policy into the actual recovered app, copied it to the iMac, and ran package, focused, full app and Release simulator validation; expected preserved originals/IDs, bounded 423 retry, exactly one 401 replay, durable acknowledgement/restart/delete recovery, no duplicate upload, exact origin and executable app tests; observed 8/8 package tests, 41/41 focused session-race tests, 123 passing executions (120 unique) with zero failures/skips across unit/integration/UI, and a successful Release simulator build with 0 errors; evidence: `step-07-ios-integration.md` and `ios-source-manifest.sha256`; mutation performed: isolated recovered iOS source and local simulator artifacts only, not TestFlight or an App Store archive.

[STEP 08] BLOCKED — required a restricted real-auth canary across every attachment endpoint at `https://crm.27pm.org`; expected authenticated 20 MiB upload/download, quarantine, deduplication, deletion, no redirects, no Vercel file transit and real IPv6-only/DNS64 flow; observed exact-host HTTP 404 and no safe deployed canary/control-plane access; evidence: `step-08-10-boundaries.md`; mutation performed: read-only public probes only.

[STEP 09] BLOCKED — required operational monitoring/rollback plus immutable CRM, gateway, scanner and iOS review artifacts deployed through the owning infrastructure; expected all preceding gates PASS; observed local candidate validation and simulator artifacts, but no real restore/scanner/canary, no iOS source repository/branch and no authorized provider deployment identity; evidence: `step-08-10-boundaries.md`; mutation performed: none in production.

[STEP 10] NOT_RUN — activation is authorized only after all pre-activation gates pass; expected verified bindings/migrations/scanner/artifacts followed by exact-size production acceptance; observed blocked Steps 02, 04, 06, 08 and 09, so flags were not changed and production remained HTTP 404; evidence: `step-08-10-boundaries.md`; mutation performed: none and no rollback was required.

[STEP 11] PASS — published tested CRM code commit `5e22d1258beb5df994173bee0243d3ac35d8ebe8` and this sanitized evidence bundle by normal fast-forward pushes, then reread the remote branch, checks and PR state; expected one idempotent update to existing comment `6008748674`, no duplicate status comment, no GitHub Actions run, and PR #4 OPEN/ready/unmerged; observed those conditions after publication. The final evidence-only head is recorded in the PR readback/comment rather than inside this self-referential commit. Evidence: this file plus `https://github.com/ales27pm/27pm-crm/pull/4#issuecomment-6008748674`; mutation performed: two scoped branch commits, one existing-comment update and no merge/deployment/activation.

## Exact resume boundary

Connect the administrative control plane for Sites project `appgprj_6a8d706605548191a846e670fafdc72b` (or the owning Cloudflare account) with permission to read and deploy the existing Worker, physical D1, private R2, routes, service bindings and secret names. The first successful read must identify the actual data Worker and the physical resources behind `DB`, `BUCKET`, `CRM_BACKEND` and `ANTIMALWARE`; do not paste credentials in chat. Separately, select an existing accessible GitHub repository for the recovered iOS source or explicitly authorize creation of one so the tested source can receive a review branch. Apple owner signing/TestFlight access is only needed after the source review and real infrastructure gates pass.
