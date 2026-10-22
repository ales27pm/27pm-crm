# Step 03 — local validation

Candidate source was tested on Linux at parent `8305ac3803a35775a4731e97c7bbdcef7eebb3a1` plus the scoped checksum-list patch and the Python 3.14 backup-verifier compatibility correction. The later evidence/runbook files do not affect application code. Every Linux command below was rerun on the final pre-publication source between `2026-10-08T07:28Z` and `07:30Z`.

| UTC window | Environment | Exact operation | Exit | Measured result |
| --- | --- | --- | ---: | --- |
| 2026-10-08T07:28–07:30Z | Linux / Node lockfile | `npm run install:ci` | 0 | 514 locked packages installed |
| 2026-10-08T07:28–07:30Z | Linux | `npm run lint` | 0 | no errors; one pre-existing `worker/native-gateway.ts:96` anonymous-default-export warning |
| 2026-10-08T07:28–07:30Z | Linux | `npm run typecheck` | 0 | strict typecheck passed |
| 2026-10-08T07:28–07:30Z | Linux | `npm run test:unit` | 0 | 555 passed, 0 failed |
| 2026-10-08T07:28–07:30Z | Linux | `npm run build` | 0 | application build passed |
| 2026-10-08T07:28–07:30Z | Linux | `npm run build:vercel` | 0 | Vercel build passed |
| 2026-10-08T07:28–07:30Z | Linux / Python | `python3 -m unittest discover -s services/antimalware -p 'test_*.py' -v` | 0 | 20 passed |
| 2026-10-08T07:28–07:30Z | Linux / Python 3.14 | `python3 -m unittest discover -s tests -p 'test_native_backup.py' -v` | 0 | 11 passed |
| 2026-10-08T06:28:51Z | iMac / Swift 6.2.4 | `swift test --package-path /Users/ales27pm/Developer/27pm-crm-ios/Packages/NativeAttachmentPolicy --jobs 2` | 0 | 8 passed, 0 failed |

The iMac package was content-compared against `integrations/ios/NativeAttachmentPolicy` before execution; no source difference was observed. Raw iMac package log (private operator storage): `/Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T062851Z-native-policy.log`, SHA-256 `1c500220936368ae2dacfa035ef55685753de1244fc85776dc7e37fba1aaa086`. Test doubles are unit evidence, not live D1/R2/scanner/transport evidence.

The new list regression proves an authenticated owner-scoped list exposes only the canonical lowercase content SHA-256 plus public metadata, never an R2 storage key/URL, and fails closed when persisted digest shape is invalid. Existing coverage for inherited R2 accessors, receipt validation, scanner readiness, multipart limits, durable acknowledgement, deduplication and deletion races remains passing.

The backup-verifier regression substitutes a SQLite connection without `enable_load_extension`, reproducing Python 3.14's optional API boundary. It failed before the correction with `AttributeError`, then passed after the verifier guarded that optional method; the independent authorizer-based denial remains in force.

[STEP 03] PASS — all required repository-local commands passed on the candidate code; mutation performed: dependency/build caches and scoped source/tests/docs only.
