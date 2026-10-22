# Step 02 — execution environment and access

- Read window: `2026-10-07T23:54:08Z`–`2026-10-08T00:02:30Z`
- Mutations: one short-lived Sites source credential and one temporary source checkout; no deployment, environment, DNS, database, bucket, or scanner mutation
- Secret handling: secret values, tokens, cookies, raw captures, and private inventories are excluded from this directory

## Sites / current data service

Authenticated reads of exact Sites project `appgprj_6a8d706605548191a846e670fafdc72b` succeeded.

| Item | Observed state |
| --- | --- |
| Site | active, title `27PM CRM`, slug `crm-27pm`, current live URL `https://api.crm.27pm.org` |
| Latest version | version 37; source commit `a0034239fd1ba18af24fa7dfe88f157613804702`; archive `sha256:d17c…`; deployment `appgdep_6ac1d2a1fdcc819193da53decd283cd2` |
| Provider worker | `site---6a8d706605548191a846e670fafdc72b` |
| Active domains | `crm.27pm.org`, `api.crm.27pm.org`, `files.crm.27pm.org` |
| Environment | revision 38; `CRM_PUBLIC_ORIGIN=https://crm.27pm.org`; secret values were not read or recorded |
| Logical resources | D1 binding `DB`; R2 binding `BUCKET` |
| Database schema | existing mail `attachments` and mobile-auth tables are present; `mobile_attachments` is absent |

The Sites source checkout at version 37 contains migrations only through 0018 and has no native attachment routes. The available Sites control surface exposes logical binding names and table/schema reads, but not the physical D1 ID, private R2 bucket identity/inventory, scanner binding, export/restore controls, or underlying provider settings. Its generated local configuration uses placeholder resource identities and is not production evidence.

## Vercel / exact public origin

Pagination completed across the full Vercel project and alias inventories.

| Item | Observed state |
| --- | --- |
| Project | `27pm-crm`, `prj_mJiEYM824c43AE34kIvDFa0kGhNt` |
| Exact alias | `crm.27pm.org` → `dpl_7iR8XYw11qEKG5kYNV7HWm2mqq4d` |
| Production artifact | READY, target production, CLI source, immutable URL `27pm-gy6i2ldl4-ales27pmyolocam-9201s-projects.vercel.app`; source SHA `UNKNOWN` because returned metadata is empty |
| PR preview | `dpl_BG5gpqHiS9J2CQWotaZFnCosjWHW`, READY, Git source SHA `7d39658483641aeb1813a10ab6beb69b560103a3` |
| Native environment names | none of `ATTACHMENTS_ENABLED`, `NATIVE_GATEWAY_ENABLED`, `MOBILE_ATTACHMENTS_RUNTIME`, `MOBILE_ATTACHMENTS_SCAN_POLICY`, `ANTIMALWARE`, or `CRM_BACKEND` is configured in the returned metadata |

Live transport checks used normal TLS and redirects disabled. An independent `https://api.github.com/zen` control returned HTTP 200 in the same runtime.

| Request | Status | Redirects | Observation |
| --- | ---: | ---: | --- |
| `GET https://crm.27pm.org/api/health` | 200 | 0 | Vercel response, private/no-store |
| `GET https://crm.27pm.org/api/mobile/capabilities` | 404 | 0 | Native production route absent |
| `GET https://api.crm.27pm.org/api/health` | 200 | 0 | Cloudflare/Sites response |
| `GET https://api.crm.27pm.org/api/mobile/capabilities` | 404 | 0 | Native Sites route absent |
| `GET https://api.crm.27pm.org/api/mobile/attachments` | 404 | 0 | Native Sites route absent |
| `GET https://api.crm.27pm.org/api/admin/database-health` without auth | 401 | 0 | Authentication remains enforced |

## Other provider connection

The connected Cloudflare account was fully paginated: no Workers, no D1 databases, and no zones were present. R2 returned provider error 10042 (“enable R2”), which is not an empty bucket listing. This account therefore cannot identify the Sites-owned resources. Local Wrangler is unauthenticated.

## iOS / Xcode

Authenticated repository and code searches found no accessible `ales27pm/ios-27pm-crm`, renamed equivalent, or `docs/crm-27pm-org-api-contract.md`. No CRM Xcode project/workspace exists locally. The Xcode test bridge has no configured workspace/scheme/destination, and simulator discovery fails because this host has neither `xcodebuild` nor `xcrun`. Historical naming (`27pm CRM`, `App27pmCRM.xcodeproj`) is not current accessible-source evidence.

## Exact blockers

1. Connect the Sites/Cloudflare infrastructure control plane that owns the project, then resume with the first successful authenticated reads of the deployed Worker version/settings and the physical `DB`, `BUCKET`, `CRM_BACKEND`, and `ANTIMALWARE` bindings.
2. Connect/authenticate the actual Rork `27pm CRM` workspace or grant/export its source repository, and connect a macOS Xcode runner. Resume with the API contract read, app network/queue source read, and workspace/scheme/destination discovery.

## Result

`[STEP 02] BLOCKED` — the public host, Vercel artifact, Sites worker/version, and logical resources were identified, but the required physical storage/scanner/backend identities and real iOS execution environment are inaccessible through the connected control planes.
