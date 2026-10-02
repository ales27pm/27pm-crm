import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("mobile authentication migrations store only token hashes and enforce session lineage", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  const directory = new URL("../drizzle/", import.meta.url);
  const names = (await readdir(directory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const name of names) {
    const migration = await readFile(new URL(name, directory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }

  assert.deepEqual(
    database.prepare("PRAGMA table_info('mobile_authorization_grants')").all().map((column) => column.name),
    ["id", "code_hash", "operator_email", "client_id", "redirect_uri", "code_challenge", "scopes", "device_name", "expires_at", "consumed_at", "consumed_session_id", "created_at"],
  );
  assert.deepEqual(
    database.prepare("PRAGMA table_info('mobile_sessions')").all().map((column) => column.name),
    ["id", "authorization_grant_id", "operator_email", "client_id", "device_name", "scopes", "refresh_token_hash", "expires_at", "last_refreshed_at", "revoked_at", "created_at", "updated_at"],
  );
  assert.deepEqual(
    database.prepare("PRAGMA table_info('mobile_refresh_tokens')").all().map((column) => column.name),
    ["token_hash", "session_id", "issued_at", "rotated_at"],
  );
  const hash = "a".repeat(64);
  database.prepare(`INSERT INTO mobile_authorization_grants
    (id, code_hash, operator_email, client_id, redirect_uri, code_challenge, scopes, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run("grant-one", hash, "alexis@27pm.org", "org.27pm.crm.mobile", "https://crm.27pm.org/mobile/oauth/callback", "c".repeat(43), "crm:dashboard:read crm:work", "2026-10-01T12:05:00.000Z");
  const insertSession = database.prepare(`INSERT INTO mobile_sessions
    (id, authorization_grant_id, operator_email, client_id, scopes,
     refresh_token_hash, expires_at, last_refreshed_at)
    VALUES (?, 'grant-one', 'alexis@27pm.org', 'org.27pm.crm.mobile',
            'crm:dashboard:read crm:work', ?, '2026-11-01T12:00:00.000Z',
            '2026-10-01T12:00:00.000Z')`);
  insertSession.run("session-one", "b".repeat(64));
  database.prepare(`INSERT INTO mobile_refresh_tokens
    (token_hash, session_id, issued_at) VALUES (?, 'session-one', ?)`)
    .run("c".repeat(64), "2026-10-01T12:00:00.000Z");
  assert.throws(() => database.prepare(`INSERT INTO mobile_refresh_tokens
    (token_hash, session_id, issued_at) VALUES (?, 'session-one', ?)`)
    .run("e".repeat(64), "2026-10-01T12:01:00.000Z"), /unique constraint failed/iu);
  database.prepare("UPDATE mobile_refresh_tokens SET rotated_at=? WHERE token_hash=?")
    .run("2026-10-01T12:01:00.000Z", "c".repeat(64));
  database.prepare(`INSERT INTO mobile_refresh_tokens
    (token_hash, session_id, issued_at) VALUES (?, 'session-one', ?)`)
    .run("e".repeat(64), "2026-10-01T12:01:00.000Z");
  assert.throws(() => insertSession.run("session-two", "d".repeat(64)), /unique constraint failed/iu);
  assert.throws(() => database.prepare(`INSERT INTO mobile_refresh_tokens
    (token_hash, session_id, issued_at) VALUES ('raw-token', 'session-one', ?)`)
    .run("2026-10-01T12:00:00.000Z"), /check constraint failed/iu);
  assert.throws(() => database.prepare(`INSERT INTO mobile_authorization_grants
    (id, code_hash, operator_email, client_id, redirect_uri, code_challenge, scopes, expires_at)
    VALUES ('bad-hash', 'raw-code', 'alexis@27pm.org', 'org.27pm.crm.mobile',
            'https://crm.27pm.org/mobile/oauth/callback', ?, 'crm:dashboard:read crm:work',
            '2026-10-01T12:05:00.000Z')`).run("c".repeat(43)), /check constraint failed/iu);
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});
