import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createAccount, createContact, deleteAccount, deleteContact, emailContactability, parseAccountInput, parseContactInput, phoneContactability, updateAccount, updateContact } from "../lib/crm-accounts.ts";
import { createInteraction, parseInteractionInput } from "../lib/crm-prospects.ts";

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

test("legacy organization keys stay canonical across case variants", async (t) => {
  const database = new DatabaseSync(":memory:"); t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await migrateThrough(database, 3);
  database.prepare("INSERT INTO contacts (id, email, organization) VALUES (?, ?, ?), (?, ?, ?)").run("legacy-a", "a@example.com", "Acme", "legacy-b", "b@example.com", "ACME");
  await migrateThrough(database, 4, 4);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM organizations WHERE external_key LIKE 'legacy:%'").get().count, 1);
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("creates separate account, opportunity and strictly verified contact", async (t) => {
  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Atelier Signal", sourceLabel: "Recherche opérateur", sourceUrl: "https://example.com/about", sourceDate: "2026-08-29", score: 87, priority: "high", budgetMinCents: 100_000, budgetMaxCents: 200_000, nextStep: "Qualifier" });
  assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const contact = parseContactInput({ organizationId: created.id, name: "Camille Fortin", email: "CAMILLE@ATELIER.EXAMPLE", role: "Direction", sourceLabel: "Page équipe", sourceUrl: "https://example.com/team", sourceDate: "2026-08-29", contactBasis: "legitimate_interest", roleRelevance: "relevant", dnclStatus: "not_applicable", emailStatus: "valid", validated: true });
  assert.equal(contact.ok, true); if (!contact.ok) return;
  const saved = await createContact(db, contact.value, "operator@27pm.org", new Date("2026-08-29T14:00:00.000Z"));
  assert.ok(saved);
  assert.deepEqual({ ...database.prepare(`SELECT organization_id AS organizationId, display_name AS name, email, role, source_url AS sourceUrl, validated_at AS validatedAt FROM contacts WHERE id=?`).get(saved.id) }, { organizationId: created.id, name: "Camille Fortin", email: "camille@atelier.example", role: "Direction", sourceUrl: "https://example.com/team", validatedAt: "2026-08-29T14:00:00.000Z" });
  assert.deepEqual({ ...database.prepare("SELECT organization_id AS organizationId, contact_id AS contactId FROM deals WHERE id=?").get(created.dealId) }, { organizationId: created.id, contactId: saved.id });
  assert.equal(database.prepare("SELECT contact_id AS contactId FROM conversations WHERE id=?").get(created.conversationId).contactId, saved.id);
});

test("rejects unverified provenance and suppression cancels contact actions", async (t) => {
  assert.deepEqual(parseContactInput({ organizationId: "org-1", name: "Personne", email: "person@example.com", role: "Direction", validated: true }), { ok: false, code: "contact_source_required" });
  assert.deepEqual(parseAccountInput({ name: "Date impossible", sourceLabel: "Test", sourceDate: "2026-02-31" }), { ok: false, code: "account_source_date_invalid" });
  const normalizedUnsubscribe = parseContactInput({ organizationId: "org-1", name: "Personne", email: "person@example.com", role: "Direction", sourceLabel: "Test", sourceUrl: "https://example.com", sourceDate: "2026-08-29", contactBasis: "explicit_consent", roleRelevance: "relevant", dnclStatus: "not_applicable", emailStatus: "unsubscribed", unsubscribed: false, validated: true });
  assert.equal(normalizedUnsubscribe.ok, true);
  if (normalizedUnsubscribe.ok) assert.equal(normalizedUnsubscribe.value.unsubscribed, true);
  const base = { contactId: "contact-1", organizationId: "org-1", phone: "+15145550123", validatedAt: "2026-08-29", contactBasis: "legitimate_interest", roleRelevance: "relevant", emailStatus: "valid", unsubscribedAt: null, doNotCall: 0, doNotContact: 0, deletedAt: null, organizationDoNotContact: 0, organizationDeletedAt: null };
  assert.equal(emailContactability(base), null);
  assert.equal(emailContactability({ ...base, unsubscribedAt: "2026-08-29" }), "contact_unsubscribed");
  assert.equal(emailContactability({ ...base, organizationDoNotContact: 1 }), "contact_suppressed");
  assert.equal(phoneContactability({ ...base, dnclStatus: "not_checked" }), "contact_dncl_unchecked");
  assert.equal(phoneContactability({ ...base, dnclStatus: "listed" }), "contact_dncl_listed");

  const database = await migratedDatabase(); t.after(() => database.close()); const db = d1Adapter(database);
  const account = parseAccountInput({ name: "Blocage Test", sourceLabel: "Test", nextStep: "Relancer" }); assert.equal(account.ok, true); if (!account.ok) return;
  const created = await createAccount(db, account.value, "operator@27pm.org");
  const contact = parseContactInput({ organizationId: created.id, name: "Contact Test", email: "block@example.com", role: "Direction", sourceLabel: "Test", sourceUrl: "https://example.com", sourceDate: "2026-08-29", contactBasis: "explicit_consent", roleRelevance: "relevant", dnclStatus: "not_applicable", emailStatus: "valid", validated: true }); assert.equal(contact.ok, true); if (!contact.ok) return;
  const saved = await createContact(db, contact.value, "operator@27pm.org"); assert.ok(saved);
  database.prepare("UPDATE deals SET contact_id=? WHERE id=?").run(saved.id, created.dealId);
  database.prepare("INSERT INTO tasks (id, deal_id, conversation_id, title, contact_action) VALUES ('task-block', ?, ?, 'Relancer', 1)").run(created.dealId, created.conversationId);
  const suppressed = parseContactInput({ ...contact.value, unsubscribed: true, validated: true }); assert.equal(suppressed.ok, true); if (!suppressed.ok) return;
  await updateContact(db, saved.id, suppressed.value, "operator@27pm.org", new Date("2026-08-30T00:00:00.000Z"));
  assert.equal(database.prepare("SELECT status FROM tasks WHERE id='task-block'").get().status, "cancelled");
  await updateContact(db, saved.id, contact.value, "operator@27pm.org", new Date("2026-08-31T00:00:00.000Z"));
  assert.deepEqual({ ...database.prepare("SELECT unsubscribed_at AS unsubscribedAt, do_not_contact AS doNotContact, email_status AS emailStatus FROM contacts WHERE id=?").get(saved.id) }, { unsubscribedAt: "2026-08-30T00:00:00.000Z", doNotContact: 1, emailStatus: "unsubscribed" });
  const changedIdentity = parseContactInput({ ...contact.value, email: "replacement@example.com", validated: true }); assert.equal(changedIdentity.ok, true);
  if (changedIdentity.ok) assert.equal(await updateContact(db, saved.id, changedIdentity.value, "operator@27pm.org"), "blocked_identity_change");

  const blockedAccount = parseAccountInput({ ...account.value, doNotContact: true }); assert.equal(blockedAccount.ok, true); if (!blockedAccount.ok) return;
  await updateAccount(db, created.id, blockedAccount.value, "operator@27pm.org");
  await updateAccount(db, created.id, account.value, "operator@27pm.org");
  assert.equal(database.prepare("SELECT do_not_contact AS blocked FROM organizations WHERE id=?").get(created.id).blocked, 1);

  assert.equal(await deleteContact(db, saved.id, "operator@27pm.org", new Date("2026-09-01T00:00:00.000Z")), true);
  assert.equal(database.prepare("SELECT contact_id AS contactId FROM deals WHERE id=?").get(created.dealId).contactId, null);
  assert.equal(emailContactability({ ...base, deletedAt: "2026-09-01T00:00:00.000Z" }), "contact_deleted");
  assert.equal(await deleteAccount(db, created.id, "operator@27pm.org", new Date("2026-09-02T00:00:00.000Z")), true);
  assert.equal(database.prepare("SELECT do_not_contact AS blocked, deleted_at AS deletedAt FROM organizations WHERE id=?").get(created.id).blocked, 1);
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
