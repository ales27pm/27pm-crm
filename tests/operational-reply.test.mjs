import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  advanceOperationalReplyAuthorization,
  loadOperationalReplyEvidence,
  OPERATIONAL_REPLY_MAX_AGE_MS,
  operationalReplyApprovalDigest,
  operationalReplyApprovalMatches,
} from "../lib/operational-reply.ts";
import { operationalReplyContent } from "../lib/operational-reply-content.ts";

const now = new Date("2026-09-14T23:30:00.000Z");
const operatorEmail = "operator@27pm.org";
const approvedText = `Bonjour,

Merci pour votre réponse au sujet de notre demande technique.

Alexis
27PM`;

test("authorizes one recent exact operational reply and records its inbound evidence", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOperationalConversation(database);
  const db = d1Adapter(database);

  const evidence = await loadOperationalReplyEvidence(db, {
    conversationId: "conversation-operations",
    conversationSubject: "Aide",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    recipient: "isabel@example.com",
  }, now);

  assert.deepEqual(evidence, {
    conversationId: "conversation-operations",
    conversationSubject: "Aide",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    contactId: "contact-isabel",
    contactComplianceVersion: 1,
    recipient: "isabel@example.com",
    inboundMessageId: "message-isabel-inbound",
    inboundExternalMessageId: "inbound-isabel@example.com",
    inboundOccurredAt: "2026-09-14T22:19:08.000Z",
    inboundCreatedAt: "2026-09-14 22:19:22",
  });

  const approvalDigest = await digestFor(evidence);
  insertPendingCommand(database, "command-operations", evidence, {
    approvalDigest,
  });

  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-operations", evidence, approvalDigest, operatorEmail,
    "pending", "authorized", now,
  ), true);
  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-operations", evidence, approvalDigest, operatorEmail,
    "authorized", "dispatching", now,
  ), true);
  assert.deepEqual(
    plain(database.prepare(`SELECT status, authorized_at AS authorizedAt,
      dispatched_at AS dispatchedAt FROM send_commands
      WHERE id='command-operations'`).get()),
    {
      status: "dispatching",
      authorizedAt: now.toISOString(),
      dispatchedAt: now.toISOString(),
    },
  );
  assert.deepEqual(
    JSON.parse(database.prepare(`SELECT compliance_snapshot_json AS snapshot
      FROM send_commands WHERE id='command-operations'`).get().snapshot),
    {
      decision: {
        allowed: true,
        kind: "solicited_operational_reply",
        evaluatedAt: now.toISOString(),
      },
      approvalDigest,
      operator: { email: operatorEmail },
      evidence: { operationalReply: evidence },
    },
  );
});

test("fails closed for stale, mismatched, suppressed, or already-answered operational mail", async (t) => {
  const cases = [
    ["stale", (database) => database.prepare(
      "UPDATE messages SET created_at=? WHERE id='message-isabel-inbound'",
    ).run(new Date(now.valueOf() - OPERATIONAL_REPLY_MAX_AGE_MS - 1).toISOString())],
    ["wrong sender", (database) => database.prepare(
      "UPDATE messages SET sender='other@example.com' WHERE id='message-isabel-inbound'",
    ).run()],
    ["divergent Reply-To", (database) => database.prepare(
      "UPDATE messages SET reply_to='other@example.com' WHERE id='message-isabel-inbound'",
    ).run()],
    ["wrong inbound status", (database) => database.prepare(
      "UPDATE messages SET status='accepted' WHERE id='message-isabel-inbound'",
    ).run()],
    ["wrong inbound transport", (database) => database.prepare(
      "UPDATE messages SET transport_provider='cakemail' WHERE id='message-isabel-inbound'",
    ).run()],
    ["inactive mailbox", (database) => database.prepare(
      "UPDATE mailboxes SET is_active=0 WHERE id='mailbox_admin'",
    ).run()],
    ["suppressed", (database) => database.prepare(`INSERT INTO contact_suppressions
      (id, channel, address_normalized, scope, category, reason, evidence_ref,
       requested_at, effective_at, created_by)
      VALUES ('suppressed-isabel', 'email', 'isabel@example.com', 'category',
        'prospecting', 'unsubscribe', 'test', ?, ?, 'test')`
    ).run(now.toISOString(), now.toISOString())],
    ["already answered", (database) => database.prepare(`INSERT INTO messages
      (id, conversation_id, mailbox_id, direction, sender, recipients_json,
       external_message_id, status, occurred_at, created_at)
      VALUES ('message-isabel-outbound', 'conversation-operations', 'mailbox_admin',
        'outbound', 'admin@27pm.org', '["isabel@example.com"]',
        'outbound-isabel@27pm.org', 'accepted', '2026-09-14T23:00:00.000Z',
        '2026-09-14 23:00:00')`
    ).run()],
  ];

  for (const [label, mutate] of cases) {
    const database = await migratedDatabase();
    t.after(() => database.close());
    seedOperationalConversation(database);
    mutate(database);
    assert.equal(await loadOperationalReplyEvidence(d1Adapter(database), {
      conversationId: "conversation-operations",
      conversationSubject: "Aide",
      mailboxId: "mailbox_admin",
      mailboxAddress: "admin@27pm.org",
      recipient: "isabel@example.com",
    }, now), null, label);
  }

  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOperationalConversation(database);
  assert.equal(await loadOperationalReplyEvidence(d1Adapter(database), {
    conversationId: "conversation-operations",
    conversationSubject: "Sujet divergent",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    recipient: "isabel@example.com",
  }, now), null, "wrong subject");
});

test("revokes dispatch when the operations mailbox is disabled after authorization", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOperationalConversation(database);
  const db = d1Adapter(database);
  const evidence = await loadEvidence(db);
  assert.ok(evidence);
  const approvalDigest = await digestFor(evidence);
  insertPendingCommand(database, "command-mailbox-revoked", evidence, {
    approvalDigest,
  });

  assert.equal(await advanceOperationalReplyAuthorization(
    db,
    "command-mailbox-revoked",
    evidence,
    approvalDigest,
    operatorEmail,
    "pending",
    "authorized",
    now,
  ), true);
  database.prepare(
    "UPDATE mailboxes SET is_active=0 WHERE id='mailbox_admin'",
  ).run();
  assert.equal(await advanceOperationalReplyAuthorization(
    db,
    "command-mailbox-revoked",
    evidence,
    approvalDigest,
    operatorEmail,
    "authorized",
    "dispatching",
    now,
  ), false);
  assert.equal(database.prepare(
    "SELECT status FROM send_commands WHERE id='command-mailbox-revoked'",
  ).get().status, "authorized");
});

test("uses server row order to reject a later message with the same created_at", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOperationalConversation(database);
  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, transport_provider, sender,
     recipients_json, external_message_id, status, occurred_at, created_at)
    VALUES ('message-same-time-outbound', 'conversation-operations',
      'mailbox_admin', 'outbound', 'mailgun', 'admin@27pm.org',
      '["isabel@example.com"]', 'same-time-outbound@27pm.org', 'accepted',
      '2026-09-14T22:19:22.000Z', '2026-09-14 22:19:22')`).run();

  assert.equal(await loadOperationalReplyEvidence(d1Adapter(database), {
    conversationId: "conversation-operations",
    conversationSubject: "Aide",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    recipient: "isabel@example.com",
  }, now), null);
});

test("revalidates the exact inbound message and contact state before each transition", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOperationalConversation(database);
  const db = d1Adapter(database);
  const evidence = await loadOperationalReplyEvidence(db, {
    conversationId: "conversation-operations",
    conversationSubject: "Aide",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    recipient: "isabel@example.com",
  }, now);
  assert.ok(evidence);

  const approvalDigest = await digestFor(evidence);
  insertPendingCommand(database, "command-operations", evidence, {
    approvalDigest,
  });
  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, sender, recipients_json,
     external_message_id, status, occurred_at, created_at)
    VALUES ('message-newer', 'conversation-operations', 'mailbox_admin',
      'outbound', 'admin@27pm.org', '["isabel@example.com"]',
      'newer@27pm.org', 'accepted', '2026-09-14T23:00:00.000Z',
      '2026-09-14 23:00:00')`).run();

  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-operations", evidence, approvalDigest, operatorEmail,
    "pending", "authorized", now,
  ), false);
  assert.equal(database.prepare(
    "SELECT status FROM send_commands WHERE id='command-operations'",
  ).get().status, "pending");
});

test("binds authorization to the operator and exact inbound snapshot", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOperationalConversation(database);
  const db = d1Adapter(database);
  const evidence = await loadEvidence(db);
  assert.ok(evidence);
  const approvalDigest = await digestFor(evidence);

  insertPendingCommand(database, "command-wrong-operator", evidence, {
    approvalDigest,
    operatorEmail: "other@27pm.org",
  });
  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-wrong-operator", evidence, approvalDigest, operatorEmail,
    "pending", "authorized", now,
  ), false);
  database.prepare(
    "UPDATE send_commands SET status='cancelled' WHERE id='command-wrong-operator'",
  ).run();

  insertPendingCommand(database, "command-wrong-evidence", evidence, {
    approvalDigest,
    inboundMessageId: "different-inbound-message",
  });
  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-wrong-evidence", evidence, approvalDigest, operatorEmail,
    "pending", "authorized", now,
  ), false);
  database.prepare(
    "UPDATE send_commands SET status='cancelled' WHERE id='command-wrong-evidence'",
  ).run();

  insertPendingCommand(database, "command-wrong-digest", evidence, {
    approvalDigest: "f".repeat(64),
  });
  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-wrong-digest", evidence, approvalDigest, operatorEmail,
    "pending", "authorized", now,
  ), false);
});

test("authorizes only the oldest pending command for one inbound, then allows a later inbound", async (t) => {
  const database = await migratedDatabase();
  t.after(() => database.close());
  seedOperationalConversation(database);
  const db = d1Adapter(database);
  const firstEvidence = await loadEvidence(db);
  assert.ok(firstEvidence);
  const firstDigest = await digestFor(firstEvidence);

  insertPendingCommand(database, "command-first", firstEvidence, {
    approvalDigest: firstDigest,
    createdAt: "2026-09-14 23:20:00",
  });
  insertPendingCommand(database, "command-second", firstEvidence, {
    approvalDigest: firstDigest,
    createdAt: "2026-09-14 23:21:00",
  });
  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-first", firstEvidence, firstDigest, operatorEmail,
    "pending", "authorized", now,
  ), true);
  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-second", firstEvidence, firstDigest, operatorEmail,
    "pending", "authorized", now,
  ), false);

  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, transport_provider, sender,
     recipients_json, external_message_id, text_body, status, occurred_at,
     created_at)
    VALUES ('message-isabel-follow-up', 'conversation-operations',
      'mailbox_admin', 'inbound', 'mailgun', 'isabel@example.com',
      '["admin@27pm.org"]', 'inbound-follow-up@example.com',
      'Voici une précision.', 'received', '2026-09-14T23:25:00.000Z',
      '2026-09-14 23:25:01')`).run();
  const laterEvidence = await loadEvidence(db);
  assert.ok(laterEvidence);
  assert.equal(laterEvidence.inboundMessageId, "message-isabel-follow-up");
  const laterDigest = await digestFor(laterEvidence);
  insertPendingCommand(database, "command-follow-up", laterEvidence, {
    approvalDigest: laterDigest,
    createdAt: "2026-09-14 23:26:00",
  });
  assert.equal(await advanceOperationalReplyAuthorization(
    db, "command-follow-up", laterEvidence, laterDigest, operatorEmail,
    "pending", "authorized", now,
  ), true);
});

test("approval digest deterministically binds every operational reply field", async () => {
  const approval = {
    conversationId: "conversation-operations",
    conversationSubject: "Aide",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    recipient: "isabel@example.com",
    inboundMessageId: "message-isabel-inbound",
    inboundExternalMessageId: "inbound-isabel@example.com",
    text: approvedText,
  };
  const expected = createHash("sha256").update(JSON.stringify({
    version: 1,
    ...approval,
  })).digest("hex");
  const actual = await operationalReplyApprovalDigest(approval);
  assert.equal(actual, expected);
  assert.equal(await operationalReplyApprovalDigest({ ...approval }), actual);
  assert.match(actual, /^[a-f0-9]{64}$/u);

  for (const field of Object.keys(approval)) {
    assert.notEqual(
      await operationalReplyApprovalDigest({
        ...approval,
        [field]: `${approval[field]}!`,
      }),
      actual,
      field,
    );
  }
});

test("approval configuration fails closed when absent, malformed, or mismatched", async () => {
  const evidence = {
    conversationId: "conversation-operations",
    conversationSubject: "Aide",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    recipient: "isabel@example.com",
    inboundMessageId: "message-isabel-inbound",
    inboundExternalMessageId: "inbound-isabel@example.com",
  };
  const digest = await digestFor(evidence);
  assert.equal(operationalReplyApprovalMatches(digest, digest), true);
  assert.equal(operationalReplyApprovalMatches(digest, null), false);
  assert.equal(operationalReplyApprovalMatches(digest, "0".repeat(64)), false);
  assert.equal(operationalReplyApprovalMatches(digest, digest.toUpperCase()), false);
  assert.equal(operationalReplyApprovalMatches(digest, digest.slice(1)), false);
});

test("preserves the exact approved text and adds no unsubscribe metadata", () => {
  const text = "Bonjour Isabel,\n\nMerci & <à bientôt>.";
  assert.deepEqual(operationalReplyContent(text), {
    text,
    html: "<p>Bonjour Isabel,</p><p>Merci &amp; &lt;à bientôt&gt;.</p>",
    unsubscribeUrl: undefined,
  });
  assert.doesNotMatch(JSON.stringify(operationalReplyContent(text)), /unsubscribe|désabonn/iu);
  const approved = operationalReplyContent(approvedText);
  assert.equal(approved.text, approvedText);
  assert.equal(approved.unsubscribeUrl, undefined);
  assert.match(approved.html, /notre demande technique/u);
  assert.match(approved.html, /Alexis<br>27PM/u);
  assert.doesNotMatch(approved.html, /se désabonner|List-Unsubscribe/iu);
  assert.throws(
    () => operationalReplyContent(`${text}\n`),
    /operational_reply_content_invalid/u,
  );
});

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

function seedOperationalConversation(database) {
  database.prepare(`INSERT INTO contacts
    (id, email, display_name, email_status, compliance_version)
    VALUES ('contact-isabel', 'isabel@example.com', 'Isabel', 'unknown', 1)`).run();
  database.prepare(`INSERT INTO conversations
    (id, mailbox_id, contact_id, subject, normalized_subject, thread_key,
     last_message_at)
    VALUES ('conversation-operations', 'mailbox_admin', 'contact-isabel',
      'Aide', 'aide', 'operations:isabel', '2026-09-14T22:19:08.000Z')`).run();
  database.prepare(`INSERT INTO messages
    (id, conversation_id, mailbox_id, direction, transport_provider, sender,
     recipients_json, external_message_id, text_body, status, occurred_at, created_at)
    VALUES ('message-isabel-inbound', 'conversation-operations', 'mailbox_admin',
      'inbound', 'mailgun', 'isabel@example.com', '["admin@27pm.org"]',
      'inbound-isabel@example.com', 'Vous pouvez simplement répondre.',
      'received', '2026-09-14T22:19:08.000Z',
      '2026-09-14 22:19:22')`).run();
}

async function loadEvidence(db) {
  return loadOperationalReplyEvidence(db, {
    conversationId: "conversation-operations",
    conversationSubject: "Aide",
    mailboxId: "mailbox_admin",
    mailboxAddress: "admin@27pm.org",
    recipient: "isabel@example.com",
  }, now);
}

function digestFor(evidence, text = approvedText) {
  return operationalReplyApprovalDigest({
    conversationId: evidence.conversationId,
    conversationSubject: evidence.conversationSubject,
    mailboxId: evidence.mailboxId,
    mailboxAddress: evidence.mailboxAddress,
    recipient: evidence.recipient,
    inboundMessageId: evidence.inboundMessageId,
    inboundExternalMessageId: evidence.inboundExternalMessageId,
    text,
  });
}

function insertPendingCommand(database, id, evidence, options = {}) {
  const snapshot = {
    decision: {
      allowed: true,
      kind: "solicited_operational_reply",
      evaluatedAt: now.toISOString(),
    },
    approvalDigest: options.approvalDigest,
    operator: { email: options.operatorEmail ?? operatorEmail },
    evidence: {
      operationalReply: {
        ...evidence,
        inboundMessageId:
          options.inboundMessageId ?? evidence.inboundMessageId,
      },
    },
  };
  database.prepare(`INSERT INTO send_commands
    (id, transport_provider, idempotency_key, request_hash, mailbox_id,
     conversation_id, status, contact_id, contact_compliance_version,
     operator_confirmed_at, compliance_snapshot_json, created_at)
    VALUES (?, 'mailgun', ?, ?, 'mailbox_admin', 'conversation-operations',
      'pending', 'contact-isabel', 1, ?, ?, ?)`).run(
    id,
    `${id}-key`,
    `${id}-hash`,
    now.toISOString(),
    JSON.stringify(snapshot),
    options.createdAt ?? "2026-09-14 23:29:00",
  );
}

function d1Adapter(database) {
  return {
    prepare(query) {
      return d1Statement(database, query, []);
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

function d1Statement(database, query, bindings) {
  return {
    bind(...values) {
      return d1Statement(database, query, values);
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
  return value ? { ...value } : value;
}
