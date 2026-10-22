# Native branch consolidation — October 22, 2026

PR #4 (`9e07ac5`) predates the Exchange integration, the resumable native
attachment transport and the iOS app now on main. The merge keeps the current
mail UI, Exchange schema and sending controls, Google account chooser, trusted
MCP origin, protected credential-object namespace, proxy header sanitization,
bounded v2 request bodies and v2 Worker dispatch.

The old multipart mobile API, `mobile_attachments` table and duplicate migration
`0019_milky_maestro` are superseded by `attachment_v2_*` and migrations 0022/0023.
The proposed private gateway is superseded by the same-host chunked transport.
The Swift HTTP policy package already exists under
`mobile/ios/Packages/NativeAttachmentPolicy`; no second package is added.
The unnegotiated capability endpoint remains false. No merge action applies
migrations, changes feature flags or starts a scanner.

## Retained source

`services/antimalware/server.py` provides the private loopback ClamD adapter used
by the existing outbound agent. It accepts authenticated bounded raw bytes,
checks the exact SHA-256 and daemon response, and rejects stale or changing
signatures. `clamd.conf.example` and `verify_engine.py` supply the reviewed
configuration example and synthetic controls. Use the current
[outbound-agent runbook](../services/antimalware/OUTBOUND_AGENT.md) for routing,
credentials and activation. The older tunnel/service-binding design is historical.

The mobile auth changes permit only canonical signed scope subsets of a current
full-scope session. A read-only token cannot perform work mutations. Both the API
guard and the v2 Worker validate the session before returning a scope denial;
unknown, expired or revoked sessions return 401. Stored grants and refreshable
sessions retain the existing exact full-scope requirement.

## Offline backup verification

`scripts/verify-native-backup.py` restores an already supplied SQL export into
disposable in-memory SQLite and hashes each declared copied object. It checks
the current v2 and scanner schema, table counts, all native-file references
(including tombstoned objects retained for recovery),
staging chunk references and mail-attachment references. It rejects missing or
corrupt bytes, duplicate keys, unsafe paths, external SQLite attachments and
legacy mail rows without a stored digest. The manifest must include all copied
R2 objects; this check cannot authenticate that inventory's source or prove
completeness of credential objects, physical D1 identity or live restore rights.

```sh
python3 -B scripts/verify-native-backup.py \
  --sql /private/backup/database.sql \
  --manifest /private/backup/manifest.json \
  --objects /private/backup/r2-copies
```

Manifest version 1 contains `databaseSha256`, `tableCounts` for every non-SQLite
internal table, and `objects` entries with `key`, relative `file`, lowercase
`sha256` and integer `byteSize`. The report always keeps `productionVerified`
and `cloudflareRestoreTested` false. Restored R2 versions must be scanned again;
copied receipts never establish reusable clean approval.

## Local checks

```sh
npm run check
python3 -B -m unittest discover -s services/antimalware -p 'test_*.py'
python3 -B -m unittest discover -s tests -p 'test_native_backup.py'
```

The Python suite uses a controllable fake ClamD and synthetic backup objects.
It proves protocol and failure behavior, not actual antivirus detection.
The real-engine controls require a separately installed engine:

```sh
python3 -B services/antimalware/verify_engine.py --socket /private/clamd.sock
```

The dated files under `docs/evidence/native-activation` remain evidence of their
original source, infrastructure and iOS boundaries. They are not current live
state or production/iPhone qualification for this merge.
