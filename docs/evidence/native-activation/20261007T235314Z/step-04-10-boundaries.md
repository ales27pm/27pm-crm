# Steps 04–10 — production boundaries and dependent gates

This file records why dependent mutations were not attempted after Step 02 failed. No production write, migration, scan, deploy, flag change, upload, deletion, or rollback was performed.

## Step 04 — backup and restoration

`BLOCKED`. The connected control surfaces cannot export the physical Sites D1 database, enumerate/version the private R2 bucket, coordinate a coherent snapshot, provision an approved isolated real restore, or compare restored bytes to a source-derived inventory. The offline verifier was tested locally, but a synthetic/SQLite-only result cannot satisfy this gate.

Resume only after the owning Sites infrastructure control plane provides the physical resources and approved backup/restore path. If a write/delete freeze is required, obtain a specific maintenance approval before that availability-impacting operation.

## Step 05 — migrations

`NOT_RUN`. The authenticated Sites schema read proves `mobile_attachments` is absent, but Step 04 did not pass and the available control plane does not expose the production ledger or approved migration runner. Migration 0019 was not applied. Existing tables and customer data were not touched.

## Step 06 — private scanner

`BLOCKED`. No real scanner host/socket, `ANTIMALWARE` binding, service identity, or secret-store connection is accessible. Local commands found no `clamd`, `clamdscan`, or `freshclam`; the common socket is absent. At `2026-10-07T23:59:22Z`, the redacted verifier command

`python3 services/antimalware/verify_engine.py --socket <verified-private-socket>`

terminated with exit 1 against the unavailable local socket, executed zero controls, and reported `daemon_unavailable_or_signatures_invalid`. This is a failed availability check, not scanner evidence. Official ClamAV documentation read during this run lists 1.5.4 as the current stable release and 1.4.6 as LTS; the eventual deployed version and signatures must be verified on the actual host.

## Step 07 — real iOS integration

`BLOCKED`. The repository contains only an explicitly unwired Swift policy package. The actual app source/API contract and a usable macOS/Xcode destination are unavailable. No app code, token handling, queue state, device/simulator build, or distribution artifact was changed.

## Step 08 — exact-host restricted canary

`BLOCKED`. Both public native route probes return 404. `worker/native-gateway.ts` is not wired into a deployable Worker entry. Current flags are global, and no supported restriction covers every attachment endpoint. Enabling globally first would violate the required test order. No fixture identity, upload, download, delete, or fault injection was attempted.

The smallest safe routing prerequisite is a reviewed gateway deployment bound privately to the existing Sites data Worker plus an approved restriction enforced across capabilities, collection, item, file, and delete routes for run-specific disposable identities.

The supported mobile issuer also always grants the exact pair `crm:dashboard:read crm:work`. Local verification now handles an attenuated, signed token safely—active session first, then 403 for a missing mutation scope—but no supported production contract can issue that token. A live test must not manufacture one with the signing secret. The auth contract must add an approved least-privilege issuance path, or the acceptance criterion must be resolved explicitly, before the live 403 case can run.

## Step 09 — operational readiness and candidate publication

`NOT_RUN`. Monitoring, real restore/rollback rehearsal, scanner deployment, iOS integration, and canary gates are incomplete. No PR push or provider deployment was made, which also avoided triggering GitHub Actions or an untested Vercel preview.

## Step 10 — activation / production acceptance

`NOT_RUN`. No native attachment flags or runtime-policy values were set. Production still returns 404 for the native capability route, Sites version 37 lacks the routes and schema, and the exact 20 MiB authenticated upload/download acceptance was not attempted. There was nothing to roll back.

## Reusable diagnostic lesson

A logical binding name or placeholder local configuration is not a physical resource identity. A provider account with an empty inventory does not prove a Sites-owned service is absent, and R2 error 10042 is not a bucket listing. When a required provider boundary is inaccessible, stop dependent writes and identify the first authoritative read that must succeed.
