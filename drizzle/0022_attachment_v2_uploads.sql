-- Resumable attachment transport. Existing email attachments remain untouched.
CREATE TABLE attachment_v2_objects (
  id text PRIMARY KEY NOT NULL,
  owner_kind text NOT NULL CHECK (owner_kind IN ('account','deal','conversation')),
  owner_id text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  sha256 text NOT NULL CHECK (length(sha256) = 64),
  storage_key text NOT NULL UNIQUE,
  object_version text NOT NULL,
  created_by text NOT NULL,
  created_at text NOT NULL,
  deleted_at text
);
--> statement-breakpoint
CREATE UNIQUE INDEX attachment_v2_active_dedup ON attachment_v2_objects(owner_kind,owner_id,sha256) WHERE deleted_at IS NULL;
--> statement-breakpoint
CREATE TABLE attachment_v2_uploads (
  id text PRIMARY KEY NOT NULL,
  creator text NOT NULL,
  session_id text NOT NULL,
  idempotency_key text NOT NULL,
  manifest_json text NOT NULL,
  manifest_sha256 text NOT NULL,
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520),
  state text NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','finalizing','committed','cancelled')),
  attachment_id text REFERENCES attachment_v2_objects(id),
  lease_owner text,
  lease_expires_at text,
  created_at text NOT NULL,
  expires_at text NOT NULL,
  UNIQUE(creator,session_id,idempotency_key)
);
--> statement-breakpoint
CREATE INDEX attachment_v2_upload_quota ON attachment_v2_uploads(creator,created_at,state,expires_at);
--> statement-breakpoint
CREATE TABLE attachment_v2_chunks (
  upload_id text NOT NULL REFERENCES attachment_v2_uploads(id),
  part_index integer NOT NULL CHECK (part_index >= 0 AND part_index < 10),
  byte_size integer NOT NULL CHECK (byte_size > 0 AND byte_size <= 2097152),
  sha256 text NOT NULL,
  storage_key text NOT NULL UNIQUE,
  object_version text NOT NULL,
  etag text NOT NULL,
  created_at text NOT NULL,
  PRIMARY KEY(upload_id,part_index)
);
