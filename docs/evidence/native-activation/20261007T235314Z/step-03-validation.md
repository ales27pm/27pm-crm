# Step 03 — reproduced gaps, minimal fixes, and local validation

- Candidate base: PR head `7d39658483641aeb1813a10ab6beb69b560103a3`
- Local scoped patch digest: `sha256:88607129c079418b77d5cd71a759df1457e8dddb3a846f23b5314d0d8f5fa316`
- Environment: isolated Linux worktree; production secrets and resources were not used
- Mutation: scoped local source, test, documentation, and evidence edits only; no commit, push, deployment, migration, or feature flag change

## Defects reproduced and fixed locally

### Migration 0019 health evidence

A regression written against the existing source initially failed because the database-health module had no migration 0019 evidence contract. The minimal fix:

- makes the operator-only health route collect read-only `PRAGMA`/`sqlite_schema` evidence for `organizations` and `mobile_attachments`;
- requires the exact 11 attachment columns, the two named CHECK constraints, all three named indexes, and the precise partial deduplication predicate;
- makes overall health degrade when 0019 evidence is absent or drifted;
- updates the operations runbook to preserve D1 rows and R2 objects during compatible code rollback and to distinguish structural health from ledger, restore, scanner, and live-file proof.

The focused post-fix database-health suite passed 11/11. Production was not queried through this new code and migration 0019 was not applied.

### Executable authentication and multipart boundary

The prior attachment tests source-matched authorization and sent only length-correct bytes to a stub gateway backend. A new integration regression now invokes the native gateway, the actual attachment POST route, a real signed device token, a real multipart `FormData` body, the SQLite test database, and the R2 test double. It proves:

- malformed bearer → 401 and no row;
- correctly signed read-only bearer tied to an active stored full-scope session on POST → 403 `mobile_scope_forbidden` and no row/object;
- the same attenuated bearer with an unknown or revoked session → 401;
- normal issued bearer → one durable ID/row/object with byte-identical content;
- reordered, duplicated, unknown, and empty signed scope sets remain invalid.

To make the documented 403 code path fail closed, token verification recognizes only the read scope, work scope, or their canonical pair; the token must first attenuate an active stored full-scope session. Normal production issuance remains both scopes, and database/grant constraints were not broadened. The focused post-fix auth/gateway suite passed 80/80. Because the supported issuer still cannot issue a least-privilege token, this regression is code evidence only: the required live 403 acceptance remains blocked and no production token may be forged for it. Test doubles remain unit/integration-test evidence only, not live storage or scanner evidence.

## Exact final validation

| UTC window | Command | Exit | Measured result |
| --- | --- | ---: | --- |
| 00:09:57–00:10:09Z | `npm run install:ci` | 0 | integrity preflight passed; exactly one bounded `npm ci`; 514 packages installed |
| 00:21:32–00:21:45Z | `npm run lint` | 0 | 0 errors; one pre-existing warning at `worker/native-gateway.ts:96` |
| 00:21:32–00:21:42Z | `npm run typecheck` | 0 | TypeScript check passed |
| 00:21:32–00:21:39Z | `npm run test:unit` | 0 | 554 tests passed; 0 failed/cancelled/skipped/todo |
| 00:21:49–00:21:56Z | `npm run build` | 0 | Sites/Vinext production build passed and emitted native routes |
| 00:21:56–00:22:01Z | `npm run build:vercel` | 0 | native Next.js/Vercel build passed and emitted native routes |
| 00:21:32–00:21:33Z | `python3 -m unittest discover -s services/antimalware -p 'test_*.py' -v` | 0 | 20 tests passed |
| 00:21:32–00:21:33Z | `python3 -m unittest discover -s tests -p 'test_native_backup.py' -v` | 0 | 10 tests passed |
| 00:21:32–00:21:33Z | `swift test --package-path integrations/ios/NativeAttachmentPolicy --jobs 2` | 127 | `swift: command not found` |

All timestamps are on `2026-10-08` UTC. Generated Python caches were removed after validation. `git diff --check` passed.

An intermediate post-build typecheck exposed mixed ignored `.next` types from the two build systems. Inspection showed a Next validator importing Vinext-generated route declarations, not a source error. The exact ignored `.next` and `dist` outputs were removed, the Vercel types were regenerated, and the required clean-artifact typecheck passed before the final suite above. Blind retries were avoided; the final builds then ran sequentially.

## Result

`[STEP 03] BLOCKED` — every available JavaScript/TypeScript/Python suite and both production builds passed on the local candidate, but the required Swift package command is unavailable and the real application/Xcode tests from Step 07 cannot run. A required unavailable test is not reported as PASS.
