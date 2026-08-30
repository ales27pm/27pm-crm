import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { classifyAccountImportResult } from "../lib/account-import.ts";
import { advanceSendAuthorization, loadComplianceConfiguration, loadContactCompliance } from "../lib/compliance.ts";
import { createAccount, createContact, deleteAccount, deleteContact, normalizePhone, parseAccountInput, parseContactInput, updateAccount, updateContact } from "../lib/crm-accounts.ts";
import { createInteraction, parseInteractionInput } from "../lib/crm-prospects.ts";
import { applyEmailUnsubscribe } from "../lib/unsubscribe.ts";

test("migration seeds the ordered account cohort without personal contacts", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close());
  const rows = database.prepare(`SELECT name, score, priority, budget_min_cents AS budgetMin, budget_max_cents AS budgetMax, source_url AS sourceUrl, source_date AS sourceDate FROM organizations WHERE external_key LIKE 'initial-cohort:%' ORDER BY sort_order`).all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { name: "S.Huot", score: 96, priority: "very_high", budgetMin: 2_000_000, budgetMax: 3_500_000, sourceUrl: null, sourceDate: null },
    { name: "JAMEC", score: 94, priority: "very_high", budgetMin: 2_500_000, budgetMax: 4_000_000, sourceUrl: null, sourceDate: null },
    { name: "Vallée", score: 92, priority: "high", budgetMin: 2_500_000, budgetMax: 4_000_000, sourceUrl: null, sourceDate: null },
    { name: "Machineries Pronovost", score: 89, priority: "high", budgetMin: 3_000_000, budgetMax: 5_000_000, sourceUrl: null, sourceDate: null },
    { name: "Groupe Industriel Interprovincial", score: 83, priority: "high", budgetMin: 1_200_000, budgetMax: 2_200_000, sourceUrl: null, sourceDate: null },
  ]);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM contacts WHERE organization_id IN (SELECT id FROM organizations WHERE external_key LIKE 'initial-cohort:%')`).get().count, 0);
  assert.equal(database.prepare(`SELECT COUNT(*) AS count FROM account_imports WHERE import_key='initial-cohort:v1'`).get().count, 1);
  assert.deepEqual({ ...database.prepare(`SELECT COUNT(*) AS count, SUM(contact_action) AS contactActions FROM tasks WHERE id LIKE 'task-cohort-%'`).get() }, { count: 5, contactActions: 0 });
});

test("phone identities use one durable E.164 representation", () => {
  assert.equal(normalizePhone("(514) 555-0123"), "+15145550123");
  assert.equal(normalizePhone("1-514-555-0123"), "+15145550123");
  assert.equal(normalizePhone("+33 1 42 68 53 00"), "+33142685300");
  assert.equal(normalizePhone("poste 123"), null);
});

test("legacy organization keys stay canonical across case variants", async (t) => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await migrateThrough(database, 3);
  database.prepare("INSERT INTO contacts (id, email, organization) VALUES (?, ?, ?), (?, ?, ?)").run("legacy-a", "a@example.com", "Acme", "legacy-b", "b@example.com", "ACME");
  await migrateThrough(database, 4, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM organizations WHERE external_key LIKE 'legacy:%'").get().count, 1);
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("compliance migration is additive, fail-closed and preserves immutable evidence", async (t) => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await migrateThrough(database, 5);
  database.prepare("INSERT INTO contacts (id, email, phone, display_name, role, source_url, source_date, role_relevance, email_status, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run("legacy-proof", "legacy@example.com", "+15145550123", "Contact hérité", "Direction", "https://example.com", "2026-08-01", "relevant", "valid", "2026-08-01T00:00:00.000Z", "legacy-phone-duplicate", "legacy-two@example.com", "+15145550123", "Deuxième contact", "Direction", "https://example.com", "2026-08-01", "relevant", "valid", "2026-08-01T00:00:00.000Z");
  database.prepare("INSERT INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json) VALUES ('audit-before', 'operator@27pm.org', 'test', 'contact', 'legacy-proof', '{}')").run();
  database.prepare("INSERT INTO webhook_receipts (kind, signature_token, signature_timestamp, callback_key) VALUES ('event', 'legacy-token', 1, 'legacy-callback')").run();
  database.prepare("INSERT INTO organizations (id, external_key, name, source_label) VALUES ('org-linked', 'test:linked', 'Compte lié', 'Test')").run();
  database.prepare("UPDATE contacts SET organization_id='org-linked' WHERE id='legacy-proof'").run();
  database.prepare("INSERT INTO conversations (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, last_message_at) VALUES ('conversation-linked', 'mailbox_bonjour', 'legacy-proof', 'Lié', 'lié', 'test:linked', '2026-08-01')").run();
  database.prepare("INSERT INTO deals (id, conversation_id, organization_id, contact_id) VALUES ('deal-linked', 'conversation-linked', 'org-linked', 'legacy-proof')").run();
  await migrateThrough(database, 8, 6);

  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.deepEqual({ ...database.prepare("SELECT lawful_basis AS lawfulBasis, evidence_ref AS evidenceRef FROM contact_channel_compliance WHERE contact_id='legacy-proof' AND channel='email'").get() }, { lawfulBasis: "none", evidenceRef: null });
  assert.deepEqual({ ...database.prepare("SELECT request_hash AS requestHash FROM account_imports WHERE import_key='initial-cohort:v1'").get() }, { requestHash: null });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contact_channel_compliance WHERE channel='phone' AND address_normalized='+15145550123'").get().count, 1);
  assert.deepEqual({ ...database.prepare("SELECT status, processed_at AS processedAt FROM webhook_receipts WHERE callback_key='legacy-callback'").get() }, { status: "processed", processedAt: database.prepare("SELECT received_at AS receivedAt FROM webhook_receipts WHERE callback_key='legacy-callback'").get().receivedAt });
  assert.deepEqual({ ...database.prepare("SELECT conversation.contact_id AS conversationContact, deal.contact_id AS dealContact FROM conversations conversation JOIN deals deal ON deal.conversation_id=conversation.id WHERE conversation.id='conversation-linked'").get() }, { conversationContact: "legacy-proof", dealContact: "legacy-proof" });
  assert.throws(() => database.prepare("UPDATE audit_entries SET action='changed' WHERE id='audit-before'").run(), /audit_entries_are_immutable/u);
  assert.throws(() => database.prepare("UPDATE contacts SET qualification_mode='unreviewed' WHERE id='legacy-proof'").run(), /contacts_qualification_mode_check/u);
  assert.throws(() => database.prepare("UPDATE contacts SET personal_data_category='sensitive' WHERE id='legacy-proof'").run(), /contacts_personal_data_category_check/u);

  database.prepare("INSERT INTO contact_suppressions (id, channel, address_normalized, reason, evidence_ref, requested_at, effective_at, created_by) VALUES ('suppression-test', 'email', 'blocked@example.com', 'unsubscribe', 'proof:test', '2026-08-29', '2026-08-29', 'operator@27pm.org')").run();
  assert.throws(() => database.prepare("DELETE FROM contact_suppressions WHERE id='suppression-test'").run(), /contact_suppressions_are_immutable/u);
  database.prepare("INSERT INTO contacts (id, email) VALUES ('contact-blocked', 'blocked@example.com')").run();
  assert.throws(() => database.prepare("INSERT INTO contact_channel_compliance (id, contact_id, channel, address_normalized) VALUES ('channel-blocked', 'contact-blocked', 'email', 'blocked@example.com')").run(), /suppressed_channel_reimport_blocked/u);
});

test("creates separate account, opportunity and strictly verified contact", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Atelier Signal", sourceLabel: "Recherche opérateur", sourceUrl: "https://example.com/about", sourceDate: "2026-08-29", score: 87, priority: "high", budgetMinCents: 100_000, budgetMaxCents: 200_000, nextStep: "Qualifier" });
  assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const contact = parseContactInput(validContactPayload({ organizationId: created.id, name: "Camille Fortin", email: "CAMILLE@ATELIER.EXAMPLE", role: "Direction", sourceUrl: "https://example.com/team" }));
  assert.equal(contact.ok, true); if (!contact.ok) return;
  const saved = await createContact(db, contact.value, "operator@27pm.org", new Date("2026-08-29T14:00:00.000Z"));
  assert.ok(saved);
  assert.deepEqual({ ...database.prepare(`SELECT organization_id AS organizationId, display_name AS name, email, role, source_url AS sourceUrl, validated_at AS validatedAt FROM contacts WHERE id=?`).get(saved.id) }, { organizationId: created.id, name: "Camille Fortin", email: "camille@atelier.example", role: "Direction", sourceUrl: "https://example.com/team", validatedAt: "2026-08-29T14:00:00.000Z" });
  const auditDetails = JSON.parse(database.prepare("SELECT details_json AS details FROM audit_entries WHERE action='contact.created' AND entity_id=?").get(saved.id).details);
  assert.equal(auditDetails.evidenceSnapshot.basisEvidenceRef, "preuve:consentement:test");
  assert.equal(auditDetails.evidenceSnapshot.sourceUrl, "https://example.com/team");
  assert.deepEqual({ ...database.prepare("SELECT organization_id AS organizationId, contact_id AS contactId FROM deals WHERE id=?").get(created.dealId) }, { organizationId: created.id, contactId: saved.id });
  assert.equal(database.prepare("SELECT contact_id AS contactId FROM conversations WHERE id=?").get(created.conversationId).contactId, saved.id);
});

test("rejects unverified provenance and suppression cancels contact actions", async (t) => {
  assert.deepEqual(parseContactInput({ organizationId: "org-1", name: "Personne", email: "person@example.com", role: "Direction", validated: true }), { ok: false, code: "contact_source_required" });
  assert.deepEqual(parseContactInput(validContactPayload({ personalDataCategory: undefined })), { ok: false, code: "contact_privacy_classification_required" });
  assert.deepEqual(parseContactInput(validContactPayload({ qualificationMode: undefined })), { ok: false, code: "contact_privacy_classification_required" });
  assert.deepEqual(parseAccountInput({ name: "Date impossible", sourceLabel: "Test", sourceDate: "2026-02-31" }), { ok: false, code: "account_source_date_invalid" });
  const normalizedUnsubscribe = parseContactInput(validContactPayload({ emailStatus: "unsubscribed", unsubscribed: false }));
  assert.equal(normalizedUnsubscribe.ok, true);
  if (normalizedUnsubscribe.ok) assert.equal(normalizedUnsubscribe.value.unsubscribed, true);
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Blocage Test", sourceLabel: "Test", nextStep: "Relancer" }); assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const contact = parseContactInput(validContactPayload({ organizationId: created.id, name: "Contact Test", email: "block@example.com" })); assert.equal(contact.ok, true); if (!contact.ok) return;
  const saved = await createContact(db, contact.value, "operator@27pm.org"); assert.ok(saved);
  database.prepare("UPDATE deals SET contact_id=? WHERE id=?").run(saved.id, created.dealId);
  database.prepare("INSERT INTO tasks (id, deal_id, conversation_id, title, contact_action) VALUES ('task-block', ?, ?, 'Relancer', 1)").run(created.dealId, created.conversationId);
  const suppressed = parseContactInput({ ...contact.value, unsubscribed: true, validated: true }); assert.equal(suppressed.ok, true); if (!suppressed.ok) return;
  await updateContact(db, saved.id, suppressed.value, "operator@27pm.org", new Date("2026-08-30T00:00:00.000Z"));
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='task-block'").get().status, "cancelled");
  assert.equal(await updateContact(db, saved.id, contact.value, "operator@27pm.org", new Date("2026-08-31T00:00:00.000Z")), "blocked_record_locked");
  assert.deepEqual({ ...database.prepare("SELECT unsubscribed_at AS unsubscribedAt, do_not_contact AS doNotContact, email_status AS emailStatus FROM contacts WHERE id=?").get(saved.id) }, { unsubscribedAt: "2026-08-30T00:00:00.000Z", doNotContact: 1, emailStatus: "unsubscribed" });
  const changedIdentity = parseContactInput({ ...contact.value, email: "replacement@example.com", validated: true }); assert.equal(changedIdentity.ok, true);
  if (changedIdentity.ok) assert.equal(await updateContact(db, saved.id, changedIdentity.value, "operator@27pm.org"), "blocked_record_locked");

  const blockedAccount = parseAccountInput({ ...account.value, doNotContact: true }); assert.equal(blockedAccount.ok, true); if (!blockedAccount.ok) return;
  await updateAccount(db, created.id, blockedAccount.value, "operator@27pm.org");
  await updateAccount(db, created.id, account.value, "operator@27pm.org");
  assert.equal(database.prepare("SELECT do_not_contact AS blocked FROM organizations WHERE id=?").get(created.id).blocked, 1);

  assert.equal(await deleteContact(db, saved.id, "operator@27pm.org", new Date("2026-09-01T00:00:00.000Z")), true);
  assert.equal(database.prepare("SELECT contact_id AS contactId FROM deals WHERE id=?").get(created.dealId).contactId, null);
  database.prepare("INSERT INTO tasks (id, conversation_id, title, contact_action) VALUES ('account-conversation-only', ?, 'Relance orpheline', 1)").run(created.conversationId);
  database.prepare("INSERT INTO tasks (id, conversation_id, title, contact_action, status) VALUES ('account-history-done', ?, 'Relance accomplie', 1, 'done')").run(created.conversationId);
  assert.equal(await deleteAccount(db, created.id, "operator@27pm.org", new Date("2026-09-02T00:00:00.000Z")), true);
  assert.equal(database.prepare("SELECT do_not_contact AS blocked, deleted_at AS deletedAt FROM organizations WHERE id=?").get(created.id).blocked, 1);
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='account-conversation-only'").get().status, "cancelled");
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='account-history-done'").get().status, "done");
});

test("do-not-call is durable and scoped to one contact and one channel", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Portée téléphone", sourceLabel: "Test" }); assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const firstParsed = parseContactInput(validContactPayload({ organizationId: created.id, email: "phone-one@example.com", phone: "+15145550111", dnclStatus: "not_listed", dnclCheckedAt: "2026-08-29", dnclEvidenceRef: "proof:dncl:one", phoneEvidenceRef: "proof:phone:one", recipientTimezone: "America/Toronto" })); assert.equal(firstParsed.ok, true); if (!firstParsed.ok) return;
  const first = await createContact(db, firstParsed.value, "operator@27pm.org"); assert.ok(first);
  const secondParsed = parseContactInput(validContactPayload({ organizationId: created.id, email: "phone-two@example.com" })); assert.equal(secondParsed.ok, true); if (!secondParsed.ok) return;
  const second = await createContact(db, secondParsed.value, "operator@27pm.org"); assert.ok(second);
  database.prepare("INSERT INTO conversations (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, last_message_at) VALUES ('conversation-second', 'mailbox_bonjour', ?, 'Second', 'second', 'test:second', '2026-08-29')").run(second.id);
  database.prepare("INSERT INTO deals (id, conversation_id, organization_id, contact_id) VALUES ('deal-second', 'conversation-second', ?, ?)").run(created.id, second.id);
  database.prepare("INSERT INTO tasks (id, deal_id, title, contact_action, contact_channel) VALUES ('first-email', ?, 'Courriel 1', 1, 'email'), ('first-phone', ?, 'Appel 1', 1, 'phone'), ('first-done', ?, 'Appel terminé', 1, 'phone')").run(created.dealId, created.dealId, created.dealId);
  database.prepare("UPDATE tasks SET status='done' WHERE id='first-done'").run();
  database.prepare("INSERT INTO tasks (id, deal_id, title, contact_action, contact_channel) VALUES ('second-phone', 'deal-second', 'Appel 2', 1, 'phone')").run();
  const blockedPhone = parseContactInput({ ...firstParsed.value, doNotCall: true, validated: true }); assert.equal(blockedPhone.ok, true); if (!blockedPhone.ok) return;
  assert.equal(await updateContact(db, first.id, blockedPhone.value, "operator@27pm.org"), "updated");
  assert.deepEqual(database.prepare("SELECT id, status FROM tasks WHERE id IN ('first-email','first-phone','first-done','second-phone') ORDER BY id").all().map((row) => ({ ...row })), [
    { id: "first-done", status: "done" }, { id: "first-email", status: "open" }, { id: "first-phone", status: "cancelled" }, { id: "second-phone", status: "open" },
  ]);
  const changedEmail = parseContactInput({ ...firstParsed.value, email: "phone-one-updated@example.com", doNotCall: false, validated: true }); assert.equal(changedEmail.ok, true); if (!changedEmail.ok) return;
  assert.equal(await updateContact(db, first.id, changedEmail.value, "operator@27pm.org"), "updated");
  assert.deepEqual({ ...database.prepare("SELECT email, do_not_call AS doNotCall FROM contacts WHERE id=?").get(first.id) }, { email: "phone-one-updated@example.com", doNotCall: 1 });
});

test("account suppression cancels a contact conversation without a deal", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Conversation sans deal", sourceLabel: "Test" }); assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const parsed = parseContactInput(validContactPayload({ organizationId: created.id, email: "no-deal@example.com" })); assert.equal(parsed.ok, true); if (!parsed.ok) return;
  const contact = await createContact(db, parsed.value, "operator@27pm.org"); assert.ok(contact);
  database.prepare("INSERT INTO conversations (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, last_message_at) VALUES ('conversation-no-deal', 'mailbox_bonjour', ?, 'Sans deal', 'sans deal', 'test:no-deal', '2026-08-29')").run(contact.id);
  database.prepare("INSERT INTO tasks (id, conversation_id, title, contact_action) VALUES ('task-no-deal', 'conversation-no-deal', 'Relancer', 1)").run();
  const blocked = parseAccountInput({ ...account.value, doNotContact: true }); assert.equal(blocked.ok, true); if (!blocked.ok) return;
  await updateAccount(db, created.id, blocked.value, "operator@27pm.org");
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='task-no-deal'").get().status, "cancelled");
});

test("records an account interaction without sending a message", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const parsed = parseInteractionInput({ dealId: "deal-cohort-s-huot", kind: "note", summary: "Compte à valider avant toute approche." }, new Date("2026-08-29T16:00:00.000Z"));
  assert.equal(parsed.ok, true); if (!parsed.ok) return;
  const result = await createInteraction(db, parsed.value, "operator@27pm.org");
  assert.ok(result);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
  assert.equal(database.prepare("SELECT organization_id AS organizationId FROM interactions WHERE id=?").get(result.id).organizationId, "org-cohort-s-huot");
});

test("public unsubscribe application is immediate and idempotent", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Désabonnement Test", sourceLabel: "Test" }); assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const parsed = parseContactInput(validContactPayload({ organizationId: created.id, email: "unsubscribe@example.com" })); assert.equal(parsed.ok, true); if (!parsed.ok) return;
  const contact = await createContact(db, parsed.value, "operator@27pm.org", new Date("2026-08-29T00:00:00.000Z")); assert.ok(contact);
  database.prepare("INSERT INTO tasks (id, deal_id, conversation_id, title, contact_action, contact_channel) VALUES ('unsubscribe-task', ?, ?, 'Relancer', 1, 'email')").run(created.dealId, created.conversationId);
  database.prepare("INSERT INTO tasks (id, deal_id, conversation_id, title, contact_action, contact_channel) VALUES ('unsubscribe-phone-task', ?, ?, 'Appeler', 1, 'phone')").run(created.dealId, created.conversationId);

  const input = { contactId: contact.id, email: "unsubscribe@example.com", scope: "global", category: "all", evidenceRef: "unsubscribe-token-sha256:test" };
  assert.deepEqual(await applyEmailUnsubscribe(db, input, new Date("2026-08-30T00:00:00.000Z")), { applied: true, idempotent: false });
  const version = database.prepare("SELECT compliance_version AS version FROM contacts WHERE id=?").get(contact.id).version;
  assert.deepEqual(await applyEmailUnsubscribe(db, input, new Date("2026-08-31T00:00:00.000Z")), { applied: true, idempotent: true });
  assert.equal(database.prepare("SELECT compliance_version AS version FROM contacts WHERE id=?").get(contact.id).version, version);
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='unsubscribe-task'").get().status, "cancelled");
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='unsubscribe-phone-task'").get().status, "cancelled");
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contact_suppressions WHERE address_normalized='unsubscribe@example.com'").get().count, 1);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM audit_entries WHERE action='contact.unsubscribed' AND entity_id=?").get(contact.id).count, 1);
});

test("unsubscribe preserves historical identity and category scope", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Portée Désabonnement", sourceLabel: "Test" }); assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const oldParsed = parseContactInput(validContactPayload({ organizationId: created.id, email: "old@example.com" })); assert.equal(oldParsed.ok, true); if (!oldParsed.ok) return;
  const oldContact = await createContact(db, oldParsed.value, "operator@27pm.org"); assert.ok(oldContact);
  database.prepare("UPDATE contacts SET email='new@example.com' WHERE id=?").run(oldContact.id);
  database.prepare("UPDATE contact_channel_compliance SET address_normalized='new@example.com' WHERE contact_id=? AND channel='email'").run(oldContact.id);
  await applyEmailUnsubscribe(db, { contactId: oldContact.id, email: "old@example.com", scope: "global", category: "all", evidenceRef: "old-token" });
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM contact_suppressions WHERE address_normalized='old@example.com'").get().count, 1);
  assert.deepEqual({ ...database.prepare("SELECT email, do_not_contact AS blocked FROM contacts WHERE id=?").get(oldContact.id) }, { email: "new@example.com", blocked: 0 });

  const categoryParsed = parseContactInput(validContactPayload({ organizationId: created.id, email: "category@example.com" })); assert.equal(categoryParsed.ok, true); if (!categoryParsed.ok) return;
  const categoryContact = await createContact(db, categoryParsed.value, "operator@27pm.org"); assert.ok(categoryContact);
  await applyEmailUnsubscribe(db, { contactId: categoryContact.id, email: "category@example.com", scope: "category", category: "prospecting", evidenceRef: "category-token" });
  assert.deepEqual({ ...database.prepare("SELECT email_status AS status, do_not_contact AS blocked, unsubscribed_at AS unsubscribedAt FROM contacts WHERE id=?").get(categoryContact.id) }, { status: "valid", blocked: 0, unsubscribedAt: null });
  assert.equal((await loadContactCompliance(db, "email", "category@example.com", "prospecting"))?.suppressionCount, 1);
  assert.equal((await loadContactCompliance(db, "email", "category@example.com", "operational"))?.suppressionCount, 0);
});

test("atomic authorization refuses a contact whose account changed after evaluation", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Course Autorisation", sourceLabel: "Test" }); assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const parsed = parseContactInput(validContactPayload({ organizationId: created.id, email: "atomic@example.com" })); assert.equal(parsed.ok, true); if (!parsed.ok) return;
  const saved = await createContact(db, parsed.value, "operator@27pm.org"); assert.ok(saved);
  const contact = await loadContactCompliance(db, "email", "atomic@example.com");
  const configuration = await loadComplianceConfiguration(db);
  assert.ok(contact);
  database.prepare("INSERT INTO send_commands (id, idempotency_key, request_hash, mailbox_id, status) VALUES ('send-atomic', 'atomic-key', 'atomic-hash', 'mailbox_bonjour', 'pending')").run();
  database.prepare("UPDATE organizations SET do_not_contact=1 WHERE id=?").run(created.id);
  assert.equal(await advanceSendAuthorization(db, "send-atomic", contact, configuration, "pending", "authorized", { allowed: true, reasons: [], evaluatedAt: "2026-08-29T00:00:00.000Z", contactVersion: contact.complianceVersion, configurationVersion: configuration.version }, "operator@27pm.org"), false);
  assert.equal(database.prepare("SELECT status FROM send_commands WHERE id='send-atomic'").get().status, "pending");
});

test("a losing concurrent import is classified as key reuse", () => {
  assert.deepEqual(classifyAccountImportResult({ id: "winner", recordCount: 1, requestHash: "hash-a" }, "loser", "hash-b"), { kind: "reused" });
  assert.deepEqual(classifyAccountImportResult({ id: "winner", recordCount: 1, requestHash: "hash-a" }, "loser", "hash-a"), { kind: "accepted", imported: false, recordCount: 1 });
});

async function migratedDatabase() {
  const database = new DatabaseSync(":memory:"); database.exec("PRAGMA foreign_keys = ON");
  await migrateThrough(database);
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
  return database;
}

async function migrateThrough(database, end = Number.POSITIVE_INFINITY, start = 0) {
  const migrationDirectory = new URL("../drizzle/", import.meta.url);
  const migrationNames = (await readdir(migrationDirectory)).filter((name) => /^\d+_.+\.sql$/u.test(name)).sort();
  for (const migrationName of migrationNames) {
    const index = Number(migrationName.slice(0, 4));
    if (index < start || index > end) continue;
    const migration = await readFile(new URL(migrationName, migrationDirectory), "utf8");
    for (const statement of migration.split("--> statement-breakpoint")) if (statement.trim()) database.exec(statement);
  }
}

function d1Adapter(database) { return { prepare(query) { return preparedQuery(database, query, []); }, async batch(statements) { const results = []; database.exec("BEGIN"); try { for (const statement of statements) results.push(await statement.run()); database.exec("COMMIT"); return results; } catch (error) { database.exec("ROLLBACK"); throw error; } } }; }
function preparedQuery(database, query, bindings) { return { bind(...values) { return preparedQuery(database, query, values); }, async first() { return database.prepare(query).get(...bindings) ?? null; }, async all() { return { results: database.prepare(query).all(...bindings), success: true }; }, async run() { const result = database.prepare(query).run(...bindings); return { success: true, meta: { changes: Number(result.changes) } }; } }; }

function validContactPayload(overrides = {}) {
  return {
    organizationId: "org-1",
    name: "Personne vérifiée",
    email: "person@example.com",
    role: "Direction numérique",
    sourceLabel: "Preuve opérateur",
    sourceUrl: "https://example.com/contact",
    sourceDate: "2026-08-29",
    provenanceType: "first_party_inbound",
    evidenceRef: "preuve:source:test",
    lawfulBasis: "explicit_consent",
    basisEvidenceRef: "preuve:consentement:test",
    roleRelevance: "relevant",
    roleRelevanceDetail: "Responsable des services numériques concernés.",
    personalDataCategory: "work_contact",
    qualificationMode: "manual",
    dnclStatus: "not_applicable",
    emailStatus: "valid",
    validated: true,
    ...overrides,
  };
}
