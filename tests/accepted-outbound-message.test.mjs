import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { recordAcceptedOutboundMessage } from "../lib/accepted-outbound-message.ts";

test("repairs an accepted send after a partial CRM write and remains idempotent", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedAcceptedSend(database);
  const failure = { failFirstBatch: true, batchCalls: 0 };
  const db = d1Adapter(database, failure);
  const input = {
    commandId: "command-accepted-repair",
    contactId: "contact-repair",
    provider: "cakemail",
    providerMessageId: "68bafc3e-2b5a-48b8-a62a-e3ecfe7c94df",
    externalMessageId: "accepted-repair@27pm.org",
    mailbox: {
      id: "mailbox_bonjour",
      address: "bonjour@27pm.org",
      purpose: "sales",
    },
    recipient: "REPAIR@example.com",
    subject: "Analyse Web",
    text: "Une courte analyse.",
    html: "<p>Une courte analyse.</p>",
    actorEmail: "operator@27pm.org",
    occurredAt: "2026-09-12T14:30:00.000Z",
  };

  await assert.rejects(
    recordAcceptedOutboundMessage(db, input),
    /injected_batch_failure/u,
  );

  assert.equal(repairConversationCount(database), 1);
  assert.equal(repairDealCount(database), 1);
  assert.equal(repairMessageCount(database), 0);
  assert.equal(repairAuditCount(database), 0);
  const partialConversation = database
    .prepare(
      `SELECT id, thread_key AS threadKey
       FROM conversations
       WHERE mailbox_id = 'mailbox_bonjour'
         AND thread_key = 'message:accepted-repair@27pm.org'`,
    )
    .get();
  assert.deepEqual({ ...partialConversation }, {
    id: partialConversation.id,
    threadKey: "message:accepted-repair@27pm.org",
  });

  database
    .prepare("UPDATE contacts SET email = 'renamed@example.com' WHERE id = 'contact-repair'")
    .run();
  database
    .prepare(
      `INSERT INTO contacts (id, email, organization_id)
       VALUES ('contact-reassigned', 'repair@example.com', 'org-repair')`,
    )
    .run();

  const repairedConversationId = await recordAcceptedOutboundMessage(db, input);
  const idempotentConversationId = await recordAcceptedOutboundMessage(db, input);
  await assert.rejects(
    recordAcceptedOutboundMessage(db, {
      ...input,
      externalMessageId: "different-external-id@27pm.org",
    }),
    /accepted_message_provider_identity_conflict/u,
  );

  assert.equal(repairedConversationId, partialConversation.id);
  assert.equal(idempotentConversationId, repairedConversationId);
  assert.equal(failure.batchCalls, 2);
  assert.equal(repairConversationCount(database), 1);
  assert.equal(repairDealCount(database), 1);
  assert.equal(repairMessageCount(database), 1);
  assert.equal(repairAuditCount(database), 1);

  const recordDigest = createHash("sha256")
    .update(`${input.provider}\u0000${input.providerMessageId}`)
    .digest("hex");
  assert.equal(
    database
      .prepare(
        `SELECT id FROM messages
         WHERE transport_provider = 'cakemail' AND provider_message_id = ?`,
      )
      .get(input.providerMessageId).id,
    `accepted-message:${recordDigest}`,
  );
  assert.equal(
    database
      .prepare(
        `SELECT id FROM audit_entries
         WHERE action = 'message.sent' AND actor_email = 'operator@27pm.org'`,
      )
      .get().id,
    `accepted-message-audit:${recordDigest}`,
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE provider_message_id = ?`,
      )
      .get(input.providerMessageId).count,
    2,
  );

  assert.deepEqual(
    plain(
      database
        .prepare(
          `SELECT conversation_id AS conversationId,
                  transport_provider AS provider,
                  provider_message_id AS providerMessageId,
                  external_message_id AS externalMessageId,
                  recipients_json AS recipientsJson,
                  status, occurred_at AS occurredAt
           FROM messages
           WHERE transport_provider = 'cakemail'`,
        )
        .get(),
    ),
    {
      conversationId: repairedConversationId,
      provider: "cakemail",
      providerMessageId: input.providerMessageId,
      externalMessageId: input.externalMessageId,
      recipientsJson: '["repair@example.com"]',
      status: "accepted",
      occurredAt: input.occurredAt,
    },
  );
  assert.deepEqual(
    plain(
      database
        .prepare(
          `SELECT conversation_id AS conversationId, failure_code AS failureCode
           FROM send_commands WHERE id = 'command-accepted-repair'`,
        )
        .get(),
    ),
    { conversationId: repairedConversationId, failureCode: null },
  );
  assert.equal(
    database
      .prepare("SELECT last_contact_at AS value FROM contacts WHERE id = 'contact-repair'")
      .get().value,
    input.occurredAt,
  );
  assert.equal(
    database
      .prepare("SELECT last_contact_at AS value FROM contacts WHERE id = 'contact-reassigned'")
      .get().value,
    null,
  );
  assert.equal(
    database
      .prepare("SELECT contact_id AS contactId FROM conversations WHERE id = ?")
      .get(repairedConversationId).contactId,
    input.contactId,
  );
  assert.equal(
    database
      .prepare("SELECT last_contact_at AS value FROM organizations WHERE id = 'org-repair'")
      .get().value,
    input.occurredAt,
  );
  assert.equal(
    database
      .prepare("SELECT actor_email AS actor FROM audit_entries")
      .get().actor,
    input.actorEmail,
  );
  assert.deepEqual(database.prepare("PRAGMA foreign_key_check").all(), []);
});

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const migrationName of migrationNames) {
    const migration = await readFile(
      new URL(migrationName, migrationDirectory),
      "utf8",
    );
    for (const statement of migration.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
  return database;
}

function seedAcceptedSend(database) {
  database
    .prepare(
      `INSERT INTO organizations
        (id, external_key, name, source_label)
       VALUES ('org-repair', 'test:accepted-repair', 'Réparation', 'Test')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO contacts
        (id, email, organization_id)
       VALUES ('contact-repair', 'repair@example.com', 'org-repair')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO send_commands
        (id, transport_provider, idempotency_key, request_hash, mailbox_id,
         status, contact_id, provider_message_id, external_message_id,
         response_status, failure_code)
       VALUES ('command-accepted-repair', 'cakemail', 'accepted-repair-key',
               'accepted-repair-hash', 'mailbox_bonjour', 'sent',
               'contact-repair',
               '68bafc3e-2b5a-48b8-a62a-e3ecfe7c94df',
               'accepted-repair@27pm.org', 201,
               'post_acceptance_persistence_failure')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, transport_provider,
         provider_message_id, external_message_id, sender, recipients_json,
         status, occurred_at)
       VALUES ('message-provider-scope-sentinel', 'conversation-cohort-s-huot',
               'mailbox_bonjour', 'outbound', 'mailgun',
               '68bafc3e-2b5a-48b8-a62a-e3ecfe7c94df',
               'mailgun-provider-scope-sentinel@27pm.org',
               'bonjour@27pm.org', '["sentinel@example.com"]', 'accepted',
               '2026-09-12T14:00:00.000Z')`,
    )
    .run();
}

function repairConversationCount(database) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM conversations
       WHERE thread_key = 'message:accepted-repair@27pm.org'`,
    )
    .get().count;
}

function repairDealCount(database) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM deals
       WHERE conversation_id IN (
         SELECT id FROM conversations
         WHERE thread_key = 'message:accepted-repair@27pm.org'
       )`,
    )
    .get().count;
}

function repairMessageCount(database) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM messages
       WHERE transport_provider = 'cakemail'
         AND provider_message_id = '68bafc3e-2b5a-48b8-a62a-e3ecfe7c94df'`,
    )
    .get().count;
}

function repairAuditCount(database) {
  return database
    .prepare(
      `SELECT COUNT(*) AS count FROM audit_entries
       WHERE action = 'message.sent' AND actor_email = 'operator@27pm.org'`,
    )
    .get().count;
}

function d1Adapter(database, failure) {
  return {
    prepare(query) {
      return preparedQuery(database, query, []);
    },
    async batch(statements) {
      failure.batchCalls += 1;
      database.exec("BEGIN");
      try {
        const results = [];
        for (let index = 0; index < statements.length; index += 1) {
          results.push(await statements[index].run());
          if (failure.failFirstBatch && index === 0) {
            failure.failFirstBatch = false;
            throw new Error("injected_batch_failure");
          }
        }
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function preparedQuery(database, query, bindings) {
  return {
    bind(...values) {
      return preparedQuery(database, query, values);
    },
    async first() {
      return database.prepare(query).get(...bindings) ?? null;
    },
    async all() {
      return {
        results: database.prepare(query).all(...bindings),
        success: true,
      };
    },
    async run() {
      const result = database.prepare(query).run(...bindings);
      return {
        success: true,
        meta: { changes: Number(result.changes) },
      };
    },
  };
}

function plain(value) {
  return value ? { ...value } : null;
}
