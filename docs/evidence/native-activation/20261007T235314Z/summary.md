# Native attachment activation — run `20261007T235314Z`

**Outcome: BLOCKED — NOT ACTIVATED**

- Run window: `2026-10-07T23:53:14Z`–`2026-10-08T00:25:49Z`
- Last successful numbered step: Step 01
- Production native state: inactive by observable route/schema/configuration state; exact-host capability is HTTP 404, Sites version 37 has no native routes, `mobile_attachments` is absent, and native activation keys are absent
- Remote PR candidate: `7d39658483641aeb1813a10ab6beb69b560103a3`
- Scoped local patch: `sha256:88607129c079418b77d5cd71a759df1457e8dddb3a846f23b5314d0d8f5fa316` atop that SHA; uncommitted and unpublished
- Published run record: [existing PR comment 6008748674](https://github.com/ales27pm/27pm-crm/pull/4#issuecomment-6008748674)

[STEP 01] PASS — refreshed the branch, PR, discussion, diff, workflow triggers, and current contracts; expected an OPEN, draft, unmerged PR and preserved checkout; observed PR #4 OPEN/draft/unmerged at `7d39658483641aeb1813a10ab6beb69b560103a3`, original `main` clean at `3cae59b5d852acea17fc976b339200ebf4b2eac1`, and stale discussion separated from current SQL/scanner contracts; evidence: `step-01-baseline.md`; mutation performed: separate clean worktree only.

[STEP 02] BLOCKED — authenticated the Sites, Vercel, GitHub, and available Cloudflare control planes and searched for the actual iOS workspace; expected physical Worker/D1/R2/backend/scanner identities plus real iOS/Xcode execution access; observed Sites v37 and its provider worker, exact Vercel production/preview artifacts, and logical `DB`/`BUCKET`, but no physical D1/R2 identities, private backend/scanner bindings, accessible app source/contract, or macOS runner; evidence: `step-02-environment.md`; mutation performed: short-lived Sites source credential and temporary source checkout, with no provider configuration change.

[STEP 03] BLOCKED — reproduced and fixed narrow candidate defects, then ran the required local commands; expected all required suites/builds on the exact candidate; observed install/lint/typecheck/554 unit tests/both builds/20 scanner tests/10 backup tests pass, but `swift test` exit 127 because Swift/Xcode is unavailable; evidence: `step-03-validation.md`; mutation performed: scoped uncommitted local source, tests, runbook, and evidence only.

[STEP 04] BLOCKED — read available backup procedures and control surfaces; expected a coherent source-derived production D1/private-R2 snapshot restored to isolated real provider resources; observed no owning export, inventory, coordination, or isolated real restore controls; evidence: `step-04-10-boundaries.md`; mutation performed: none.

[STEP 05] NOT_RUN — compared the live schema and reviewed migration/ledger source; expected Step 04 PASS before rehearsing and applying only pending migration 0019; observed live `mobile_attachments` absent and no authoritative remote ledger/approved runner access, so migration was not rehearsed or applied; evidence: `step-02-environment.md` and `step-04-10-boundaries.md`; mutation performed: none.

[STEP 06] BLOCKED — checked for the real scanner service/binding and ran the verifier only against the unavailable local socket; expected seven real engine controls plus private binding/receipt/failure evidence; observed no scanner host/socket/service identity/binding and verifier exit 1 with zero controls; evidence: `step-04-10-boundaries.md`; mutation performed: none.

[STEP 07] BLOCKED — searched accessible repositories, local workspaces, and Xcode bridge configuration; expected the actual app, API contract, workspace/scheme/destination, and executable app-level tests; observed only the explicitly unwired Swift package, no accessible CRM app/contract, and no `swift`, `xcodebuild`, or `xcrun`; evidence: `step-02-environment.md` and `step-04-10-boundaries.md`; mutation performed: none.

[STEP 08] BLOCKED — probed the exact public host without redirects and inspected gateway/canary/auth contracts; expected a restricted all-endpoint canary through the existing data Worker and a supported least-privilege bearer; observed native routes HTTP 404, unattached gateway source, global-only flags, no safe all-endpoint restriction, and an issuer that always grants both scopes; evidence: `step-02-environment.md` and `step-04-10-boundaries.md`; mutation performed: none.

[STEP 09] NOT_RUN — assessed operations, rollback, workflow triggers, and publication boundaries; expected every preceding gate PASS before publishing/deploying immutable artifacts; observed missing real monitoring/restore/rollback/scanner/iOS/canary evidence, so no commit, push, preview update, deployment, or promotion was performed; evidence: `step-01-baseline.md` and `step-04-10-boundaries.md`; mutation performed: none.

[STEP 10] NOT_RUN — rechecked production capability and configuration; expected all pre-activation gates PASS before changing flags and performing exact-size production acceptance; observed final `GET https://crm.27pm.org/api/mobile/capabilities` HTTP 404 with zero redirects at `2026-10-08T00:25:03Z`; evidence: `step-04-10-boundaries.md`; mutation performed: none, and no rollback was required.

[STEP 11] PASS — reread and idempotently updated existing marker comment `6008748674`, then reread PR/comment/remote branch and Actions history; expected one run marker and PR OPEN/draft/unmerged at the intended head without a new Actions run; observed at `2026-10-08T00:25:49Z` marker count 1, prior history preserved, remote branch and PR head both `7d39658483641aeb1813a10ab6beb69b560103a3`, `state=open`, `draft=true`, `merged=false`, and no run newer than 2026-10-04; evidence: this summary and the linked PR comment; mutation performed: one edit to the existing comment only.

Publication diagnostic: the first PTY upload was rejected HTTP 400 and an attempted local encoder was unavailable before any request. Each time the comment was reread and confirmed unchanged before changing the transport. Sending the same marker-bound payload through `gh api --raw-field` with locally encoded UTF-8 succeeded; the final reread proved one marker, so no duplicate or partial write was hidden.

## Local fixes retained for review

- Exact migration 0019 structural evidence in the operator-only database-health route, including nullable organization column shape and the partial deduplication predicate.
- Active-session-first mobile authorization with fail-closed canonical scope attenuation; unknown/revoked sessions stay 401 and scope denial is 403 only after session validation.
- Gateway-to-real-route multipart/auth regression with byte-identical test storage persistence.
- Restore/rollback runbook requiring coordinated real D1 and private R2 recovery proof.

These changes are not deployed and are not part of the remote PR head. Local test doubles do not prove live storage, scanner, transport, or iOS behavior.

## Exact resume boundary

Connect the owning Sites infrastructure controls and the actual Rork/Xcode workspace; the first required reads are the physical `DB`, `BUCKET`, `CRM_BACKEND`, and `ANTIMALWARE` bindings, followed by the real iOS API contract/workspace/scheme/destination. Resolve the supported least-privilege issuance contract before the live 403 test. Do not paste credentials into chat.
