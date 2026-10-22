# Step 07 — actual iOS integration

## Source and artifact identity

- Recovered source: `/home/ales27pm/ios-27pm-crm-rork-recovery` and byte-identical iMac copy `/Users/ales27pm/Developer/27pm-crm-ios`.
- A final `rsync -anrc --delete` comparison at `2026-10-08T07:26Z`, excluding only `.build/` and `.DS_Store`, exited `0` and emitted no content differences.
- Manifest: `ios-source-manifest.sha256`, 59 files, sorted relative-path SHA-256 list.
- Manifest aggregate (SHA-256 of the exact 59 manifest lines): `bff94c7bc17cb98b6dfd92d12abfa7bf2b5a07ce8b171382ca2b52f785726bc7`.
- Contract: `docs/crm-27pm-org-api-contract.md`, SHA-256 `05731cf30c6eb7b6728bb44f30802a55758d76ae00384c493cc0cfff19e740b6`.
- Release simulator executable: `/Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T063433Z-DerivedData/Build/Products/Release-iphonesimulator/App27pmCRM.app/App27pmCRM`, SHA-256 `adc79f1d968973c657bbd20e48c13ef89b14e6147ce3a93e22fe3a3600bce74c`, bundle `org.27pm.crm.mobile`, version `1.0.0 (2)`.

The source is not currently in an accessible Git repository; this identity is a content manifest, not a Git commit. The Release output is an iOS Simulator build signed only to run locally. It is not an App Store archive, TestFlight upload or physical-device acceptance result.

## Integrated behavior

- `423 attachment_quarantined` is interpreted before token-refresh handling, preserves original bytes/local ID/server ID/queue state, shows `En vérification / fichier bloqué`, defers download and honors bounded `Retry-After` with 30–3600 seconds plus exponential fallback capped at 1800 seconds.
- Only a first `401` refreshes and replays once. A second `401` requires authentication. `403`, `423`, storage failures and `5xx` do not rotate credentials.
- Refresh token rotation is global single-flight. Delayed 401 responses bind to their exact rejected bearer and cannot consume another rotating token or purge a newer session.
- Upload acknowledgement is persisted before upload queue removal; restart repair does not repost an acknowledged upload. Interrupted acknowledgement/replay reconciles through authenticated metadata and SHA-256 without duplicate acknowledgement.
- Downloads compare retained original length and SHA-256. Redirects are refused and the effective origin remains exactly `https://crm.27pm.org`.
- Deletes persist tombstones before local removal, are idempotent across 204/404, protect shared deduplicated IDs and keep a durable bounded retry when list visibility is delayed.
- Overlapping drains coalesce into a guaranteed follow-up pass. Offline/online recovery reprobes capability before draining.
- Logout captures the bearer, purges tokens/UI/cache synchronously, then attempts remote revocation. Dashboard successes/errors are bound to the logical authentication epoch, so a suspended old-session response cannot restore customer data after logout.

## Executed tests

Focused session-race command, first attempt at UTC `2026-10-08T07:19:23Z` and corrected attempt at `2026-10-08T07:20:12Z`:

```sh
xcodebuild test -project /Users/ales27pm/Developer/27pm-crm-ios/App27pmCRM.xcodeproj \
  -scheme App27pmCRM \
  -destination 'platform=iOS Simulator,id=710EFEFE-73D8-400B-B5D1-D5F43662B536' \
  -derivedDataPath /Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T063433Z-DerivedData \
  -resultBundlePath /Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T072012Z-session-races-focused.xcresult \
  -parallel-testing-enabled NO \
  -only-testing:App27pmCRMTests/AttachmentSyncCoordinatorTests \
  -only-testing:App27pmCRMTests/DeviceAuthRefreshTests \
  -only-testing:App27pmCRMTests/ReminderPlannerTests
```

The first attempt exited `65` at compilation because `AuthenticationReplayGate.run` accepted two closures as non-escaping while retaining them in an escaping operation. No test executed. Result bundle: `20261008T071923Z-session-races-focused.xcresult`; log SHA-256 `8ad472cb5746ef9b8b3cc88280ba1c45ceb993fe89b0a2344107d4971ffe16e6`. The minimal correction marked only `authenticationEpoch` and `sessionIsAuthenticated` as `@escaping`; the same focused boundary was rerun rather than treating the failed compile as evidence. The corrected attempt exited `0`, `** TEST SUCCEEDED **`: 41/41 passed, comprising 23 `AttachmentSyncCoordinatorTests`, 12 `DeviceAuthRefreshTests` Swift Testing executions and 6 `ReminderPlannerTests`, with 0 failed/skipped. Corrected log SHA-256: `9f138b0a41c62b977d5fe3f3e5df28ad9789cda0bb5721ed62291c70ff6e16bd`.

Full command, UTC `2026-10-08T07:21:18Z`, using the same source and DerivedData:

```sh
xcodebuild test -project /Users/ales27pm/Developer/27pm-crm-ios/App27pmCRM.xcodeproj \
  -scheme App27pmCRM \
  -destination 'platform=iOS Simulator,id=710EFEFE-73D8-400B-B5D1-D5F43662B536' \
  -derivedDataPath /Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T063433Z-DerivedData \
  -resultBundlePath /Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T072118Z-step07-final.xcresult \
  -parallel-testing-enabled NO
```

Exit `0`, `** TEST SUCCEEDED **`; Xcode result summary from `2026-10-08T07:21:29Z` through `07:23:32Z`: iPhone 16 / iOS 26.3.1 / x86_64, 123 passing device/configuration executions, 120 unique tests, 0 failed, 0 skipped. This comprises 48 XCTest unit/integration executions, 68 Swift Testing executions and 7 UI executions. Log SHA-256: `999395268edd638a245a8baa33879cbf3651b24a026d001e37203e75d198baa4`.

Release simulator command, UTC `2026-10-08T07:24:23Z`:

```sh
xcodebuild build -project /Users/ales27pm/Developer/27pm-crm-ios/App27pmCRM.xcodeproj \
  -scheme App27pmCRM -configuration Release \
  -destination 'platform=iOS Simulator,id=710EFEFE-73D8-400B-B5D1-D5F43662B536' \
  -derivedDataPath /Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T063433Z-DerivedData \
  -resultBundlePath /Users/ales27pm/Developer/27pm-crm-ios-test-results/20261008T072423Z-step07-release.xcresult
```

Exit `0`, `** BUILD SUCCEEDED **`; Xcode build summary from `2026-10-08T07:24:43Z` through `07:25:28Z` reported status `succeeded`, 0 errors and 8 warnings. Log SHA-256 `b1687308ce68fbf9b7c50b0c94e1f81ca8531a5890db5c3441197dd75cc50689`; executable SHA-256 `adc79f1d968973c657bbd20e48c13ef89b14e6147ce3a93e22fe3a3600bce74c`. The warnings are retained technical debt in camera Sendability, mail deprecation, presentation-anchor isolation, place-cache isolation and a non-fatal dSYM module-cache path; this run does not claim a warning-free build.

An earlier remote-shell invocation at `2026-10-08T07:24:04Z` incorrectly escaped `2>&1`, causing Xcode to receive it as an unknown build action. It exited `65` before compilation and created only a failed `.xcresult` plus 515-byte log. The authoritative state was inspected, the quoting mechanism was corrected, and the build was rerun once at the new `072423Z` paths above. Reusable diagnostic: apply redirection in the remote shell, outside the quoted Xcode argument vector, and never reuse a partially written result path.

TestFlight readiness was inspected without printing credential values at `2026-10-08T07:30Z`. The iMac reports three valid local code-signing identities, but no `/Users/ales27pm/.private_keys/appstoreconnect.env` connection and no TestFlight `ExportOptions` plist in the recovered source. Accordingly, no build number was changed and no archive, IPA, App Store Connect upload, TestFlight assignment or beta-review submission was attempted. Resume only with an owner-authorized App Store Connect API credential connection stored outside the repository and a reviewed export contract; then require `ARCHIVE SUCCEEDED`, upload/export success, API-visible processing state and ultimately `VALID` before calling the build delivered.

[STEP 07] PASS — actual app integration and executable app tests demonstrate the required local state, retry, acknowledgement, authentication and deletion behavior. Live production upload/download and a signed physical-device/TestFlight build remain separate Step 08–10 evidence; mutation performed: isolated recovered source, iMac project copy and simulator result artifacts only.
