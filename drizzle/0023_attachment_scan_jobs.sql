CREATE TABLE attachment_scan_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  attachment_id TEXT NOT NULL UNIQUE REFERENCES attachment_v2_objects(id),
  storage_key TEXT NOT NULL,
  object_version TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK(length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  byte_size INTEGER NOT NULL CHECK(byte_size>0 AND byte_size<=20971520),
  policy TEXT NOT NULL CHECK(policy='sha256-bound-r2-pull-v2'),
  generation INTEGER NOT NULL DEFAULT 0 CHECK(generation>=0),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','completed','blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count>=0 AND attempt_count<=5),
  available_at TEXT NOT NULL,
  scanner_id TEXT,
  lease_token_hash TEXT CHECK(lease_token_hash IS NULL OR (length(lease_token_hash)=64 AND lease_token_hash NOT GLOB '*[^0-9a-f]*')),
  lease_started_at TEXT,
  lease_expires_at TEXT,
  receipt_key TEXT,
  result_digest TEXT CHECK(result_digest IS NULL OR (length(result_digest)=64 AND result_digest NOT GLOB '*[^0-9a-f]*')),
  result_status TEXT CHECK(result_status IS NULL OR result_status IN ('clean','infected')),
  scanned_at TEXT,
  signature_updated_at TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK(state!='leased' OR (scanner_id IS NOT NULL AND lease_token_hash IS NOT NULL AND lease_started_at IS NOT NULL AND lease_expires_at>lease_started_at)),
  CHECK(state!='completed' OR (receipt_key IS NOT NULL AND result_digest IS NOT NULL AND result_status IS NOT NULL AND scanned_at IS NOT NULL AND signature_updated_at IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX attachment_scan_jobs_claim_idx ON attachment_scan_jobs(state,available_at,lease_expires_at);
--> statement-breakpoint
CREATE TABLE attachment_scanner_heartbeats (
  scanner_id TEXT PRIMARY KEY NOT NULL,
  engine_version TEXT NOT NULL,
  signature_version TEXT NOT NULL,
  signature_updated_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE attachment_scanner_request_nonces (
  nonce TEXT PRIMARY KEY NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX attachment_scanner_request_nonces_expiry_idx ON attachment_scanner_request_nonces(expires_at);
