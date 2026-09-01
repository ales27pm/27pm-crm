import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  OUTREACH_CADENCE,
  buildOutreachSteps,
  outreachStepTiming,
} from "../lib/outreach-strategy.ts";
import {
  replaceZonedDate,
  zonedDateValue,
  zonedLocalDateTimeIso,
} from "../lib/zoned-date-time.ts";
import { uniqueOperationTimestamp } from "../lib/operation-stamp.ts";
import { outreachErrorMessage } from "../lib/outreach-errors.ts";
import { OUTREACH_CONTACT_COMPLIANCE_SQL } from "../lib/outreach-readiness-sql.ts";

const migrationDirectory = new URL("../drizzle/", import.meta.url);

test("builds a cautious three-email cadence on business days", () => {
  const steps = buildOutreachSteps({
    strategyId: "strategy-test",
    startAt: "2026-09-02T13:30:00.000Z",
    contactReady: false,
    recipientTimezone: "America/Toronto",
  });

  assert.equal(OUTREACH_CADENCE.length, 6);
  assert.deepEqual(
    steps.map((step) => [step.actionType, step.scheduledAt.slice(0, 10), step.status]),
    [
      ["research", "2026-08-31", "planned"],
      ["review", "2026-09-01", "planned"],
      ["email", "2026-09-02", "blocked"],
      ["email", "2026-09-09", "blocked"],
      ["email", "2026-09-18", "blocked"],
      ["nurture", "2026-09-21", "planned"],
    ],
  );
  assert.equal(steps.filter((step) => step.requiresContact).length, 3);
  assert.equal(new Set(steps.map((step) => step.id)).size, steps.length);
});

test("converts the recipient wall time with its IANA timezone", () => {
  assert.equal(zonedLocalDateTimeIso("2026-09-02T09:30", "America/Toronto"), "2026-09-02T13:30:00.000Z");
  assert.equal(zonedLocalDateTimeIso("2026-12-02T09:30", "America/Toronto"), "2026-12-02T14:30:00.000Z");
  assert.equal(zonedLocalDateTimeIso("2026-09-02T09:30", "Fuseau/Invalide"), null);
  assert.equal(zonedDateValue("2026-09-02T00:30:00.000Z", "America/Vancouver"), "2026-09-01");
  assert.equal(replaceZonedDate("2026-09-02T00:30:00.000Z", "2026-09-03", "America/Vancouver"), "2026-09-04T00:30:00.000Z");
  const lateMonday = zonedLocalDateTimeIso("2026-09-07T22:00", "America/Toronto");
  assert.ok(lateMonday);
  const lateSteps = buildOutreachSteps({
    strategyId: "strategy-late",
    startAt: lateMonday,
    contactReady: true,
    recipientTimezone: "America/Toronto",
  });
  assert.equal(zonedDateValue(lateSteps[1].scheduledAt, "America/Toronto"), "2026-09-04");
  assert.equal(zonedDateValue(lateSteps[2].scheduledAt, "America/Toronto"), "2026-09-07");
});

test("labels scheduled strategy work as overdue or due today", () => {
  const now = new Date("2026-09-02T13:00:00.000Z");
  assert.equal(outreachStepTiming("2026-09-02T12:59:00.000Z", "America/Toronto", now), "overdue");
  assert.equal(outreachStepTiming("2026-09-02T15:00:00.000Z", "America/Toronto", now), "today");
  assert.equal(outreachStepTiming("2026-09-03T13:30:00.000Z", "America/Toronto", now), "upcoming");
  assert.equal(outreachStepTiming("invalid", "America/Toronto", now), "invalid");
});

test("operation guards are unique while remaining valid timestamps", () => {
  const now = new Date("2026-08-31T12:00:00.123Z");
  const first = uniqueOperationTimestamp(now);
  const second = uniqueOperationTimestamp(now);
  assert.notEqual(first, second);
  assert.equal(new Date(first).toISOString(), now.toISOString());
  assert.match(first, /^2026-08-31T12:00:00\.123\d{24}Z$/u);
});

test("translates one or several compliance blocks into actionable French", () => {
  assert.equal(
    outreachErrorMessage("contact_unvalidated,role_relevance_unproven,email_status_not_valid,email_lawful_basis_missing"),
    "La validation du contact ou du canal est absente ou périmée. · La pertinence professionnelle du rôle n’est pas démontrée. · L’adresse courriel n’est pas encore validée. · Le fondement LCAP n’est pas documenté.",
  );
  assert.equal(
    outreachErrorMessage("outreach_strategy_frozen"),
    "Ce plan est en lecture seule. Réactivez-le avant de modifier ses étapes.",
  );
});

test("translates every error emitted by outreach routes and readiness", async () => {
  const routeSources = await Promise.all([
    readFile(new URL("../app/api/strategies/[strategyId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/strategies/[strategyId]/steps/[stepId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contacts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/contacts/[id]/route.ts", import.meta.url), "utf8"),
  ]);
  const emittedCodes = new Set([
    "authentication_required",
    "operator_forbidden",
    "allowlist_unconfigured",
    "email_address_missing",
    "phone_address_missing",
    "contact_id_invalid",
    "contact_not_found",
    "contact_or_account_not_found",
    ...routeSources.flatMap((source) =>
      [...source.matchAll(/jsonError\([^\n]*?"([a-z_]+)"/gu)].map((match) => match[1])),
  ]);

  for (const code of emittedCodes) {
    assert.notEqual(outreachErrorMessage(code), code.replaceAll("_", " "), `missing French label for ${code}`);
  }
});

test("migration creates one personalized plan per approved account without sending data", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await migrate(database);

  assert.equal(count(database, "outreach_strategies"), 5);
  assert.equal(count(database, "outreach_steps"), 30);
  assert.equal(count(database, "outreach_steps", "requires_contact=1 AND status='blocked'"), 15);
  assert.equal(count(database, "outreach_steps", "requires_contact=0 AND status='planned'"), 15);
  assert.equal(count(database, "messages"), 0);
  assert.equal(count(database, "send_commands"), 0);
  assert.equal(count(database, "contacts", "id LIKE 'contact-public-%'"), 6);
  assert.equal(count(database, "contacts", "id LIKE 'contact-public-%' AND email_status='unknown' AND contact_basis='unknown'"), 6);
  assert.equal(count(database, "contact_channel_compliance", "contact_id LIKE 'contact-public-%' AND lawful_basis='none' AND status='unknown'"), 6);
  assert.equal(count(database, "contact_channel_compliance", "contact_id LIKE 'contact-public-%' AND provenance_type='recipient_published'"), 6);
  assert.deepEqual(
    { ...database.prepare(`SELECT role, source_url AS sourceUrl FROM contacts WHERE id='contact-public-jamec-daniel'`).get() },
    { role: "Contact professionnel JAMEC — rôle actuel à confirmer", sourceUrl: "https://jamec.ca/carrieres/" },
  );
  assert.equal(count(database, "contacts", "email IN ('mtremblay@shuot.com','steve@groupeinter.com')"), 0);

  const plans = database.prepare(
    `SELECT organization_id AS organizationId, target_role AS targetRole,
            opening_angle AS openingAngle, recommended_start_at AS recommendedStartAt,
            recipient_timezone AS recipientTimezone
       FROM outreach_strategies ORDER BY recommended_start_at`,
  ).all();
  assert.deepEqual(plans.map((plan) => plan.organizationId), [
    "org-cohort-s-huot",
    "org-cohort-jamec",
    "org-cohort-vallee",
    "org-cohort-pronovost",
    "org-cohort-gii",
  ]);
  assert.match(plans[0].targetRole, /direction|présidence/iu);
  assert.match(plans[0].openingAngle, /usine|industrielle/iu);
  assert.match(plans[1].openingAngle, /vendeur technique|équipement/iu);
  assert.equal(database.prepare(`SELECT contact.email FROM outreach_strategies strategy
    JOIN contacts contact ON contact.id=strategy.contact_id
    WHERE strategy.organization_id='org-cohort-jamec'`).get().email, "info@jamec.ca");
  assert.equal(database.prepare(`SELECT research_source AS researchSource FROM outreach_strategies
    WHERE organization_id='org-cohort-jamec'`).get().researchSource,
    "Document utilisateur et pages publiques officielles JAMEC");
  assert.deepEqual(
    { ...database.prepare(`SELECT target_name AS targetName, target_role AS targetRole
      FROM outreach_strategies WHERE organization_id='org-cohort-pronovost'`).get() },
    { targetName: "Dave Barclay ou Simon Pronovost", targetRole: "Direction générale ou direction des ventes" },
  );
  for (const plan of plans) {
    const actual = database.prepare(
      `SELECT action_type AS actionType, scheduled_at AS scheduledAt, status
         FROM outreach_steps WHERE strategy_id=(
           SELECT id FROM outreach_strategies WHERE organization_id=?
         ) ORDER BY sequence_index`,
    ).all(plan.organizationId);
    const expected = buildOutreachSteps({
      strategyId: "comparison-only",
      startAt: plan.recommendedStartAt,
      contactReady: false,
      recipientTimezone: plan.recipientTimezone,
    }).map(({ actionType, scheduledAt, status }) => ({ actionType, scheduledAt, status }));
    assert.deepEqual(actual.map((row) => ({ ...row })), expected);
  }
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("migration reuses a matching existing contact without overwriting its evidence", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await migrate(database, 9);
  database.prepare(`INSERT INTO contacts
      (id, email, display_name, organization, organization_id, source, email_status)
    VALUES ('existing-shuot', 'info@shuot.com', 'Route déjà documentée', 'S.Huot',
      'org-cohort-s-huot', 'Dossier opérateur existant', 'valid')`).run();

  await migrate(database, 10, 10);

  assert.deepEqual(
    { ...database.prepare(`SELECT id, display_name AS displayName, source, email_status AS emailStatus
      FROM contacts WHERE email='info@shuot.com'`).get() },
    {
      id: "existing-shuot",
      displayName: "Route déjà documentée",
      source: "Dossier opérateur existant",
      emailStatus: "valid",
    },
  );
  assert.equal(count(database, "contacts", "lower(email)='info@shuot.com'"), 1);
  assert.equal(database.prepare(`SELECT contact_id AS contactId FROM outreach_strategies
    WHERE organization_id='org-cohort-s-huot'`).get().contactId, "existing-shuot");
  assert.equal(database.prepare("PRAGMA foreign_key_check").all().length, 0);
});

test("bulk readiness query loads every email dossier in one set-based statement", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec("PRAGMA foreign_keys = ON");
  await migrate(database);

  const rows = database.prepare(OUTREACH_CONTACT_COMPLIANCE_SQL).all("email");
  assert.equal(rows.length, 6);
  assert.equal(new Set(rows.map((row) => row.contactId)).size, 6);
  assert.ok(rows.every((row) => row.channel === "email"));
  assert.ok(rows.every((row) => Number(row.suppressionCount) === 0));
});

test("strategy routes are operator-only planning surfaces and never send a message", async () => {
  const [strategyRoute, stepRoute, readiness, workViews, dashboardRoute] = await Promise.all([
    readFile(new URL("../app/api/strategies/[strategyId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/strategies/[strategyId]/steps/[stepId]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/outreach-readiness.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/work-views.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
  ]);
  for (const source of [strategyRoute, stepRoute]) {
    assert.match(source, /requireOperatorRequest/u);
    assert.doesNotMatch(source, /messages\/send|send_commands|mailgun/iu);
  }
  assert.match(stepRoute, /evaluateOutreachChannel/u);
  assert.match(readiness, /canEmail/u);
  assert.match(stepRoute, /outreach\.step\.updated/u);
  assert.match(stepRoute, /db\.batch\(\[stepWrite, auditWrite\]\)/u);
  assert.match(stepRoute, /AND status=\? AND scheduled_at=\?/u);
  assert.match(strategyRoute, /existing\?\.status === "completed"/u);
  assert.match(strategyRoute, /const steps = status === "completed"/u);
  assert.match(workViews, /\["paused", "completed", "archived"\]\.includes\(strategy\.status\)/u);
  assert.doesNotMatch(dashboardRoute, /strategy\.status <> 'archived'/u);
  assert.match(stepRoute, /\["paused", "completed", "archived"\]\.includes\(current\.strategyStatus\)/u);
  assert.match(stepRoute, /\["done", "skipped"\]\.includes\(current\.status\)/u);
  assert.match(stepRoute, /parent\.status NOT IN \('paused','completed','archived'\)/u);
  assert.match(stepRoute, /parent\.contact_id=\?/u);
});

async function migrate(database, end = Number.POSITIVE_INFINITY, start = 0) {
  const names = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_.+\.sql$/u.test(name))
    .sort();
  for (const name of names) {
    const index = Number(name.slice(0, 4));
    if (index < start || index > end) continue;
    const source = await readFile(new URL(name, migrationDirectory), "utf8");
    for (const statement of source.split("--> statement-breakpoint")) {
      if (statement.trim()) database.exec(statement);
    }
  }
}

function count(database, table, where = "1=1") {
  return database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count;
}
