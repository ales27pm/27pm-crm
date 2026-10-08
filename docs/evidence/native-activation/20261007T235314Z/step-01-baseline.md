# Step 01 — branch, contract, and baseline

- Run ID: `20261007T235314Z`
- Read window: `2026-10-07T23:53:14Z`–`2026-10-08T00:00:09Z`
- Environment: local Linux checkout plus authenticated GitHub reads
- Mutation: created a separate worktree only; the original checkout was not changed

## Identity reads

| Read | Result |
| --- | --- |
| `date -u` | Run started at `2026-10-07T23:53:14Z` |
| `git status --porcelain=v1` in the original checkout | Clean |
| `git rev-parse HEAD` in the original checkout | `3cae59b5d852acea17fc976b339200ebf4b2eac1` (`main`) |
| `gh pr view 4 --repo ales27pm/27pm-crm ...` | PR is OPEN, draft, unmerged; base `main`; head `vercel-agent/mobile-native-capabilities`; head OID `7d39658483641aeb1813a10ab6beb69b560103a3` |

The worktree used for inspection and validation is:

`/home/ales27pm/.codex/worktrees/native-activation-20261007/27pm-crm`

It was created at the exact PR head. The PR was 5 commits ahead of and 0 behind `main`, with 82 changed files (+17,055/−189). The current body, all eight issue comments, the diff, and marker comment `6008748674` were read before any write. There were no reviews or inline review comments.

## Contract findings

- `.openai/hosting.json:2-4` declares only logical Sites bindings (`DB`, `BUCKET`), not physical resource identities.
- `lib/mobile-attachments.ts:36-67` computes readiness from global flags plus schema probes; `lib/mobile-attachments-api.ts:10-33` also requires real bindings and authentication.
- `docs/native-antimalware-rollout.md:53-74` and `lib/mobile-antimalware.ts:95-210` define the current version/SHA-256/length-bound private receipt trust boundary. The older metadata-only prose in `docs/mobile-native-capabilities.md:100-129` is superseded and was not restored.
- `lib/vercel-api-proxy.ts:54-73` preserves the Vercel file-route guard and forces attachment capability false on that path.
- `worker/native-gateway.ts:1-96` contains the intended exact-host gateway, but `worker/index.ts:1-8,41-70` does not import it and the repository contains no deployable Wrangler configuration for it.
- Backend and gateway flags are global (`lib/mobile-attachments.ts:36-43`, `worker/native-gateway.ts:33,82`); no all-endpoint restricted canary mechanism exists.
- Migration 0019 is defined by `drizzle/0019_milky_maestro.sql:1-21`, including the partial unique deduplication index on line 18. The runtime readiness probe is not proof of the remote migration ledger.
- `integrations/ios/NativeAttachmentPolicy/Sources/NativeAttachmentPolicy/AttachmentHTTPPolicy.swift:3-4` explicitly says the package is not wired into the application.

## Workflow boundary

`.github/workflows/verify.yml:3-7` triggers on every pull-request synchronization and pushes to `main`. Historical `[skip ci]` commits did not create Actions runs, but provider checks still ran, so publication is not trigger-free. No GitHub Actions were invoked by this run.

## Result

`[STEP 01] PASS` — current identities and contracts were recorded, draft/unmerged state was confirmed, the original checkout was preserved, and stale discussion was separated from the current SQL/source contract.
