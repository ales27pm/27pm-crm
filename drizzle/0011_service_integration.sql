CREATE TABLE integration_operations (
  id TEXT PRIMARY KEY NOT NULL,
  subject TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_json TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1 CHECK (valid=1),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(subject,idempotency_key)
);
--> statement-breakpoint
CREATE TABLE integration_documents (
  id TEXT PRIMARY KEY NOT NULL,
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  media_type TEXT NOT NULL DEFAULT 'text/markdown' CHECK (media_type='text/markdown'),
  status TEXT NOT NULL DEFAULT 'prepared' CHECK (status='prepared'),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
--> statement-breakpoint
CREATE INDEX integration_documents_deal_idx ON integration_documents(deal_id);
