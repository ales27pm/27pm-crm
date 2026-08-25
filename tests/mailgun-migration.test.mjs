import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

test("generated D1 migration seeds both identities and enforces idempotency", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const migrationName of migrationNames) {
    const migration = await readFile(new URL(migrationName, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }

  assert.deepEqual(
    database
      .prepare(
        "SELECT id, address, purpose FROM mailboxes ORDER BY address",
      )
      .all()
      .map((row) => ({ ...row })),
    [
      {
        id: "mailbox_admin",
        address: "admin@27pm.org",
        purpose: "operations",
      },
      {
        id: "mailbox_bonjour",
        address: "bonjour@27pm.org",
        purpose: "sales",
      },
    ],
  );

  assert.ok(
    database
      .prepare("PRAGMA table_info(deals)")
      .all()
      .some((column) => column.name === "note" && column.notnull === 1),
  );

  const insertReceipt = database.prepare(
    `INSERT INTO webhook_receipts
      (kind, signature_token, signature_timestamp, callback_key)
     VALUES (?, ?, ?, ?)`,
  );
  insertReceipt.run("inbound", "token-one", 1_800_000_000, "inbound:one");
  assert.throws(
    () => insertReceipt.run("event", "token-one", 1_800_000_001, "event:two"),
    /unique constraint failed/i,
  );
  assert.throws(
    () => insertReceipt.run("inbound", "token-two", 1_800_000_002, "inbound:one"),
    /unique constraint failed/i,
  );

  const insertSendCommand = database.prepare(
    `INSERT INTO send_commands
      (id, idempotency_key, request_hash, mailbox_id)
     VALUES (?, ?, ?, 'mailbox_bonjour')`,
  );
  insertSendCommand.run("command-one", "send:unique:0001", "hash-one");
  assert.throws(
    () => insertSendCommand.run("command-two", "send:unique:0001", "hash-two"),
    /unique constraint failed/i,
  );

  database.close();
});
