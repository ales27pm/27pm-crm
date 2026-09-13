import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  CakemailUnknownSendResolutionError,
  listUnknownCakemailSends,
  parseCakemailUnknownSendResolutionRequest,
  resolveUnknownCakemailSend,
} from "../lib/cakemail-unknown-send-resolution.ts";

const COMMAND_ID = "bb24a285-f750-4a1f-887a-d317605962ba";
const PROVIDER_ID = "68bafc3e-2b5a-48b8-a62a-e3ecfe7c94df";
const EXTERNAL_ID = "cakemail.50f8f14b-dc70-4415-a587-235a86e833d3@27pm.org";
const OBSERVED_AT = "2026-09-12T17:00:00.000Z";

test("parses an explicit evidence-bound resolution without accepting secrets", () => {
  const accepted = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload({ providerMessageId: PROVIDER_ID.toUpperCase() }),
    "OPERATOR@27pm.org",
    new Date("2026-09-12T17:01:00.000Z"),
  );
  assert.deepEqual(accepted, {
    commandId: COMMAND_ID,
    externalMessageId: EXTERNAL_ID,
    resolution: "accepted",
    providerMessageId: PROVIDER_ID,
    verifiedMessageIdHeader: `<${EXTERNAL_ID}>`,
    providerObservedAt: OBSERVED_AT,
    evidenceReference: "Cakemail log export sha256:example-evidence",
    actorEmail: "operator@27pm.org",
  });

  for (const payload of [
    resolutionPayload({ confirmed: false }),
    resolutionPayload({ externalMessageId: "other@27pm.org" }),
    resolutionPayload({ providerMessageId: "not-a-provider-uuid" }),
    resolutionPayload({ verifiedMessageIdHeader: "another-message@27pm.org" }),
    resolutionPayload({ verifiedMessageIdHeader: EXTERNAL_ID }),
    resolutionPayload({ evidenceReference: `log ck_pat_${"a".repeat(40)}` }),
    resolutionPayload({ providerObservedAt: "2026-09-12T17:10:00.000Z" }),
    resolutionPayload({
      resolution: "rejected",
      providerMessageId: PROVIDER_ID,
      verifiedMessageIdHeader: undefined,
    }),
  ]) {
    assert.equal(
      parseCakemailUnknownSendResolutionRequest(
        payload,
        "operator@27pm.org",
        new Date("2026-09-12T17:01:00.000Z"),
      ),
      null,
    );
  }
});

test("resolves an unknown accepted outcome exactly once without redispatch", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedUnknownCommand(database, COMMAND_ID);
  const db = d1Adapter(database);
  const input = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload(),
    "operator@27pm.org",
    new Date("2026-09-12T17:01:00.000Z"),
  );
  assert.ok(input);

  assert.deepEqual(await listUnknownCakemailSends(db), [
    {
      commandId: COMMAND_ID,
      externalMessageId: EXTERNAL_ID,
      mailboxId: "mailbox_bonjour",
      contactId: "contact-unknown-resolution",
      mailboxAddress: "bonjour@27pm.org",
      recipient: "unknown@example.com",
      subject: "Analyse Web",
      contentMode: "html",
      dispatchedAt: "2026-09-12T16:59:00.000Z",
      snapshotValid: true,
      createdAt: database
        .prepare("SELECT created_at AS value FROM send_commands WHERE id = ?")
        .get(COMMAND_ID).value,
      updatedAt: database
        .prepare("SELECT updated_at AS value FROM send_commands WHERE id = ?")
        .get(COMMAND_ID).value,
    },
  ]);

  const resolved = await resolveUnknownCakemailSend(db, input);
  const repeated = await resolveUnknownCakemailSend(db, input);
  assert.deepEqual(
    { ...resolved, conversationId: Boolean(resolved.conversationId) },
    {
      resolved: true,
      resolution: "accepted",
      providerMessageId: PROVIDER_ID,
      externalMessageId: EXTERNAL_ID,
      conversationId: true,
      crmRecorded: true,
      idempotent: false,
    },
  );
  assert.equal(repeated.idempotent, true);
  assert.equal(repeated.crmRecorded, true);
  assert.deepEqual(await listUnknownCakemailSends(db), []);
  assert.deepEqual(
    plain(
      database
        .prepare(
          `SELECT status, provider_message_id AS providerMessageId,
                  response_status AS responseStatus, failure_code AS failureCode
           FROM send_commands WHERE id = ?`,
        )
        .get(COMMAND_ID),
    ),
    {
      status: "sent",
      providerMessageId: PROVIDER_ID,
      responseStatus: null,
      failureCode: null,
    },
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM messages
         WHERE transport_provider = 'cakemail' AND provider_message_id = ?`,
      )
      .get(PROVIDER_ID).count,
    1,
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_entries
         WHERE action = 'integration.cakemail.outcome_resolved'
           AND entity_id = ?`,
      )
      .get(COMMAND_ID).count,
    1,
  );
});

test("records a provider-verified rejection and refuses conflicting resolution", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedUnknownCommand(database, COMMAND_ID);
  const db = d1Adapter(database);
  const rejected = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload({
      resolution: "rejected",
      providerMessageId: undefined,
      verifiedMessageIdHeader: undefined,
    }),
    "operator@27pm.org",
    new Date("2026-09-12T17:01:00.000Z"),
  );
  assert.ok(rejected);

  const result = await resolveUnknownCakemailSend(db, rejected);
  assert.deepEqual(result, {
    resolved: true,
    resolution: "rejected",
    providerMessageId: null,
    externalMessageId: EXTERNAL_ID,
    conversationId: null,
    crmRecorded: false,
    idempotent: false,
  });
  assert.equal(
    database
      .prepare("SELECT failure_code AS value FROM send_commands WHERE id = ?")
      .get(COMMAND_ID).value,
    "transport_rejected_verified",
  );

  const accepted = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload(),
    "operator@27pm.org",
    new Date("2026-09-12T17:01:00.000Z"),
  );
  await assert.rejects(
    resolveUnknownCakemailSend(db, accepted),
    (error) =>
      error instanceof CakemailUnknownSendResolutionError &&
      error.status === 409 &&
      error.code === "cakemail_resolution_state_changed",
  );
});

test("rejects evidence outside the dispatch window and a reused provider identity", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedUnknownCommand(database, COMMAND_ID);
  const db = d1Adapter(database);
  const tooEarly = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload({ providerObservedAt: "2026-09-12T16:58:59.999Z" }),
    "operator@27pm.org",
    new Date("2026-09-12T17:01:00.000Z"),
  );
  assert.ok(tooEarly);
  await assert.rejects(
    resolveUnknownCakemailSend(db, tooEarly),
    (error) =>
      error instanceof CakemailUnknownSendResolutionError &&
      error.code === "cakemail_resolution_evidence_time_invalid",
  );

  database
    .prepare(
      `INSERT INTO messages
        (id, conversation_id, mailbox_id, direction, transport_provider,
         provider_message_id, external_message_id, sender, recipients_json,
         status, occurred_at)
       VALUES ('provider-id-conflict', 'conversation-cohort-s-huot',
               'mailbox_bonjour', 'outbound', 'cakemail', ?,
               'different-provider-message@27pm.org', 'bonjour@27pm.org',
               '["other@example.com"]', 'accepted',
               '2026-09-12T16:59:30.000Z')`,
    )
    .run(PROVIDER_ID);
  const accepted = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload(),
    "operator@27pm.org",
    new Date("2026-09-12T17:01:00.000Z"),
  );
  assert.ok(accepted);
  await assert.rejects(
    resolveUnknownCakemailSend(db, accepted),
    (error) =>
      error instanceof CakemailUnknownSendResolutionError &&
      error.code === "cakemail_provider_message_conflict",
  );
  assert.deepEqual(
    plain(
      database
        .prepare("SELECT status, failure_code AS failureCode FROM send_commands WHERE id = ?")
        .get(COMMAND_ID),
    ),
    { status: "dispatching", failureCode: "transport_outcome_unknown" },
  );
});

test("recovers the stale unmarked state left by two failed post-acceptance writes", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedUnknownCommand(database, COMMAND_ID, { failureCode: null });
  const db = d1Adapter(database);
  assert.deepEqual(
    await listUnknownCakemailSends(
      db,
      new Date("2026-09-12T17:03:59.999Z"),
    ),
    [],
  );
  assert.equal(
    (
      await listUnknownCakemailSends(
        db,
        new Date("2026-09-12T17:04:00.000Z"),
      )
    ).length,
    1,
  );

  const accepted = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload(),
    "operator@27pm.org",
    new Date("2026-09-12T17:04:00.000Z"),
  );
  assert.ok(accepted);
  const result = await resolveUnknownCakemailSend(
    db,
    accepted,
    new Date("2026-09-12T17:04:00.000Z"),
  );
  assert.equal(result.resolution, "accepted");
  assert.equal(result.crmRecorded, true);
  assert.deepEqual(
    plain(
      database
        .prepare(
          `SELECT status, provider_message_id AS providerMessageId,
                  failure_code AS failureCode
           FROM send_commands WHERE id = ?`,
        )
        .get(COMMAND_ID),
    ),
    { status: "sent", providerMessageId: PROVIDER_ID, failureCode: null },
  );
});

test("rolls back the resolution state when its audit write fails", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedUnknownCommand(database, COMMAND_ID);
  const input = parseCakemailUnknownSendResolutionRequest(
    resolutionPayload(),
    "operator@27pm.org",
    new Date("2026-09-12T17:01:00.000Z"),
  );
  assert.ok(input);
  await assert.rejects(
    resolveUnknownCakemailSend(
      d1Adapter(database, { failResolutionAudit: true }),
      input,
    ),
    /injected_resolution_audit_failure/u,
  );
  assert.deepEqual(
    plain(
      database
        .prepare(
          `SELECT status, provider_message_id AS providerMessageId,
                  failure_code AS failureCode
           FROM send_commands WHERE id = ?`,
        )
        .get(COMMAND_ID),
    ),
    {
      status: "dispatching",
      providerMessageId: null,
      failureCode: "transport_outcome_unknown",
    },
  );
  assert.equal(
    database
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_entries
         WHERE action = 'integration.cakemail.outcome_resolved'`,
      )
      .get().count,
    0,
  );
});

function resolutionPayload(patch = {}) {
  return {
    confirmed: true,
    commandId: COMMAND_ID,
    externalMessageId: EXTERNAL_ID,
    resolution: "accepted",
    providerMessageId: PROVIDER_ID,
    verifiedMessageIdHeader: `<${EXTERNAL_ID}>`,
    providerObservedAt: OBSERVED_AT,
    evidenceReference: "Cakemail log export sha256:example-evidence",
    ...patch,
  };
}

async function migratedDatabase() {
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
  return database;
}

function seedUnknownCommand(database, commandId, options = {}) {
  database
    .prepare(
      `INSERT INTO organizations
        (id, external_key, name, source_label)
       VALUES ('org-unknown-resolution', 'test:unknown-resolution',
               'Résolution inconnue', 'Test')`,
    )
    .run();
  database
    .prepare(
      `INSERT INTO contacts (id, email, organization_id)
       VALUES ('contact-unknown-resolution', 'unknown@example.com',
               'org-unknown-resolution')`,
    )
    .run();
  const snapshot = JSON.stringify({
    version: 1,
    requestHash: "a".repeat(64),
    provider: "cakemail",
    contactId: "contact-unknown-resolution",
    mailbox: {
      id: "mailbox_bonjour",
      address: "bonjour@27pm.org",
      purpose: "sales",
    },
    recipient: "unknown@example.com",
    subject: "Analyse Web",
    contentMode: "html",
    text: null,
    html: "<p>Une courte analyse.</p>",
    actorEmail: "operator@27pm.org",
    conversationId: null,
    occurredAt: "2026-09-12T16:59:00.000Z",
  });
  database
    .prepare(
      `INSERT INTO send_commands
        (id, transport_provider, idempotency_key, request_hash, mailbox_id,
         status, contact_id, dispatched_at, message_snapshot_json,
         external_message_id, response_status, failure_code)
       VALUES (?, 'cakemail', ?, ?, 'mailbox_bonjour', 'dispatching',
               'contact-unknown-resolution', '2026-09-12T16:59:00.000Z', ?,
               ?, ?, ?)`,
    )
    .run(
      commandId,
      `unknown-resolution:${commandId}`,
      "a".repeat(64),
      snapshot,
      EXTERNAL_ID,
      options.failureCode === null ? null : 503,
      options.failureCode === null
        ? null
        : "transport_outcome_unknown",
    );
}

function d1Adapter(database, failure = {}) {
  return {
    prepare(query) {
      return preparedQuery(database, query, []);
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (let index = 0; index < statements.length; index += 1) {
          if (failure.failResolutionAudit && index === 1) {
            failure.failResolutionAudit = false;
            throw new Error("injected_resolution_audit_failure");
          }
          results.push(await statements[index].run());
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
      return { results: database.prepare(query).all(...bindings), success: true };
    },
    async run() {
      const result = database.prepare(query).run(...bindings);
      return { success: true, meta: { changes: Number(result.changes) } };
    },
  };
}

function plain(value) {
  return value ? { ...value } : null;
}
