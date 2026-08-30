import type { CrmDatabase } from "./d1";
import { optionalTrimmedString, validIsoTimestamp } from "./http";
import { normalizeEmailAddress } from "./mailboxes";

export const ACCOUNT_PRIORITIES = ["very_high", "high", "normal", "low"] as const;
export const CONTACT_BASES = ["inbound_request", "explicit_consent", "legitimate_interest", "existing_client"] as const;
export const ROLE_RELEVANCE = ["relevant", "not_relevant"] as const;
export const DNCL_STATUSES = ["not_checked", "not_listed", "listed", "not_applicable"] as const;
export const EMAIL_STATUSES = ["valid", "bounced", "invalid", "unsubscribed"] as const;

type ParseResult<T> = { ok: true; value: T } | { ok: false; code: string };

export type AccountInput = {
  name: string; website: string | null; sourceLabel: string; sourceUrl: string | null;
  sourceDate: string | null; score: number | null; priority: (typeof ACCOUNT_PRIORITIES)[number];
  budgetMinCents: number | null; budgetMaxCents: number | null; ownerEmail: string | null;
  doNotContact: boolean; nextFollowUpAt: string | null; nextStep: string | null; notes: string;
};

export type ContactInput = {
  organizationId: string; name: string; email: string; phone: string | null; role: string;
  sourceLabel: string; sourceUrl: string; sourceDate: string;
  contactBasis: (typeof CONTACT_BASES)[number]; roleRelevance: (typeof ROLE_RELEVANCE)[number];
  dnclStatus: (typeof DNCL_STATUSES)[number]; emailStatus: (typeof EMAIL_STATUSES)[number];
  doNotCall: boolean; doNotContact: boolean; unsubscribed: boolean; validated: boolean;
  nextFollowUpAt: string | null;
};

export type ContactabilityRow = {
  contactId: string; organizationId: string | null; validatedAt: string | null;
  phone: string | null;
  contactBasis: string; roleRelevance: string; emailStatus: string; unsubscribedAt: string | null;
  doNotCall: number | boolean; doNotContact: number | boolean; deletedAt: string | null;
  organizationDoNotContact: number | boolean | null; organizationDeletedAt: string | null;
};

export function parseAccountInput(payload: Record<string, unknown>): ParseResult<AccountInput> {
  const name = optionalTrimmedString(payload.name, 200);
  const website = optionalUrl(payload.website);
  const sourceLabel = optionalTrimmedString(payload.sourceLabel, 200);
  const sourceUrl = optionalUrl(payload.sourceUrl);
  const sourceDate = optionalDate(payload.sourceDate);
  const score = optionalInteger(payload.score, 0, 100);
  const priority = enumValue(payload.priority, ACCOUNT_PRIORITIES) ?? "normal";
  const budgetMinCents = optionalInteger(payload.budgetMinCents, 0, 1_000_000_000);
  const budgetMaxCents = optionalInteger(payload.budgetMaxCents, 0, 1_000_000_000);
  const ownerEmail = payload.ownerEmail == null || payload.ownerEmail === "" ? null : normalizeEmailAddress(String(payload.ownerEmail));
  const nextFollowUpAt = payload.nextFollowUpAt == null || payload.nextFollowUpAt === "" ? null : validIsoTimestamp(payload.nextFollowUpAt);
  const nextStep = optionalTrimmedString(payload.nextStep, 500);
  const notes = optionalTrimmedString(payload.notes, 10_000);
  if (!name) return { ok: false, code: "account_name_invalid" };
  if ((payload.website !== undefined && website === undefined) || (payload.sourceUrl !== undefined && sourceUrl === undefined)) return { ok: false, code: "account_url_invalid" };
  if (!sourceLabel) return { ok: false, code: "account_source_invalid" };
  if (payload.sourceDate !== undefined && sourceDate === undefined) return { ok: false, code: "account_source_date_invalid" };
  if (score === undefined) return { ok: false, code: "account_score_invalid" };
  if (payload.priority !== undefined && !enumValue(payload.priority, ACCOUNT_PRIORITIES)) return { ok: false, code: "account_priority_invalid" };
  if (budgetMinCents === undefined || budgetMaxCents === undefined || (budgetMinCents !== null && budgetMaxCents !== null && budgetMaxCents < budgetMinCents)) return { ok: false, code: "account_budget_invalid" };
  if (payload.ownerEmail && !ownerEmail) return { ok: false, code: "account_owner_invalid" };
  if (nextFollowUpAt === undefined) return { ok: false, code: "account_follow_up_invalid" };
  if ((payload.nextStep !== undefined && nextStep === undefined) || (payload.notes !== undefined && notes === undefined)) return { ok: false, code: "account_text_invalid" };
  return { ok: true, value: { name, website: website ?? null, sourceLabel, sourceUrl: sourceUrl ?? null, sourceDate: sourceDate ?? null, score, priority, budgetMinCents, budgetMaxCents, ownerEmail, doNotContact: payload.doNotContact === true, nextFollowUpAt, nextStep: nextStep ?? null, notes: notes ?? "" } };
}

export function parseContactInput(payload: Record<string, unknown>): ParseResult<ContactInput> {
  const organizationId = entityId(payload.organizationId);
  const name = optionalTrimmedString(payload.name, 200);
  const email = typeof payload.email === "string" ? normalizeEmailAddress(payload.email) : null;
  const phone = payload.phone === undefined ? null : optionalTrimmedString(payload.phone, 50);
  const role = optionalTrimmedString(payload.role, 200);
  const sourceLabel = optionalTrimmedString(payload.sourceLabel, 200);
  const sourceUrl = optionalUrl(payload.sourceUrl);
  const sourceDate = optionalDate(payload.sourceDate);
  const contactBasis = enumValue(payload.contactBasis, CONTACT_BASES);
  const roleRelevance = enumValue(payload.roleRelevance, ROLE_RELEVANCE);
  const dnclStatus = enumValue(payload.dnclStatus, DNCL_STATUSES);
  const emailStatus = enumValue(payload.emailStatus, EMAIL_STATUSES);
  const unsubscribed = payload.unsubscribed === true || emailStatus === "unsubscribed";
  const nextFollowUpAt = payload.nextFollowUpAt == null || payload.nextFollowUpAt === "" ? null : validIsoTimestamp(payload.nextFollowUpAt);
  if (!organizationId) return { ok: false, code: "contact_organization_invalid" };
  if (!name || !email || !role) return { ok: false, code: "contact_identity_invalid" };
  if (phone === undefined) return { ok: false, code: "contact_phone_invalid" };
  if (!sourceLabel || !sourceUrl || !sourceDate) return { ok: false, code: "contact_source_required" };
  if (!contactBasis) return { ok: false, code: "contact_basis_required" };
  if (!roleRelevance) return { ok: false, code: "contact_role_relevance_required" };
  if (!dnclStatus || !emailStatus) return { ok: false, code: "contact_status_required" };
  if (nextFollowUpAt === undefined) return { ok: false, code: "contact_follow_up_invalid" };
  if (payload.validated !== true) return { ok: false, code: "contact_validation_required" };
  return { ok: true, value: { organizationId, name, email, phone: phone ?? null, role, sourceLabel, sourceUrl, sourceDate, contactBasis, roleRelevance, dnclStatus, emailStatus: unsubscribed ? "unsubscribed" : emailStatus, doNotCall: payload.doNotCall === true, doNotContact: payload.doNotContact === true, unsubscribed, validated: true, nextFollowUpAt } };
}

export async function createAccount(db: CrmDatabase, input: AccountInput, actorEmail: string) {
  const id = crypto.randomUUID(); const conversationId = crypto.randomUUID(); const dealId = crypto.randomUUID();
  const taskId = input.nextStep ? crypto.randomUUID() : null; const externalKey = `manual:${id}`;
  await db.batch([
    db.prepare(`INSERT INTO organizations (id, external_key, name, website, source_label, source_url, source_date, score, priority, budget_min_cents, budget_max_cents, owner_email, do_not_contact, next_follow_up_at, next_step, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, externalKey, input.name, input.website, input.sourceLabel, input.sourceUrl, input.sourceDate, input.score, input.priority, input.budgetMinCents, input.budgetMaxCents, input.ownerEmail, input.doNotContact ? 1 : 0, input.nextFollowUpAt, input.nextStep, input.notes),
    db.prepare(`INSERT INTO conversations (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, is_unread, follow_up_state, follow_up_at, last_message_at) VALUES (?, 'mailbox_bonjour', NULL, ?, lower(trim(?)), ?, 0, ?, ?, ?)`).bind(conversationId, input.name, input.name, `account:${externalKey}`, input.nextFollowUpAt ? "pending" : "none", input.nextFollowUpAt, new Date().toISOString()),
    db.prepare(`INSERT INTO deals (id, conversation_id, organization_id, contact_id, stage, next_action, next_action_at, note) VALUES (?, ?, ?, NULL, 'new', ?, ?, ?)`).bind(dealId, conversationId, id, input.nextStep, input.nextFollowUpAt, input.notes),
    ...(taskId && input.nextStep ? [db.prepare(`INSERT INTO tasks (id, conversation_id, deal_id, title, status, due_at, contact_action) VALUES (?, ?, ?, ?, 'open', ?, 0)`).bind(taskId, conversationId, dealId, input.nextStep, input.nextFollowUpAt)] : []),
    audit(db, actorEmail, "account.created", "organization", id, { externalKey, dealId }),
  ]);
  return { id, dealId, conversationId, taskId };
}

export async function updateAccount(db: CrmDatabase, id: string, input: AccountInput, actorEmail: string) {
  const existing = await db.prepare("SELECT id, do_not_contact AS doNotContact FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(id).first<{ id: string; doNotContact: number | boolean }>();
  if (!existing) return false;
  const doNotContact = Boolean(existing.doNotContact) || input.doNotContact;
  await db.batch([
    db.prepare(`UPDATE organizations SET name=?, website=?, source_label=?, source_url=?, source_date=?, score=?, priority=?, budget_min_cents=?, budget_max_cents=?, owner_email=?, do_not_contact=?, next_follow_up_at=?, next_step=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(input.name, input.website, input.sourceLabel, input.sourceUrl, input.sourceDate, input.score, input.priority, input.budgetMinCents, input.budgetMaxCents, input.ownerEmail, doNotContact ? 1 : 0, input.nextFollowUpAt, input.nextStep, input.notes, id),
    db.prepare(`UPDATE deals SET next_action=?, next_action_at=?, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`).bind(input.nextStep, input.nextFollowUpAt, id),
    ...(doNotContact ? [db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1 AND deal_id IN (SELECT id FROM deals WHERE organization_id=?)`).bind(id)] : []),
    audit(db, actorEmail, "account.updated", "organization", id, { doNotContact }),
  ]);
  return true;
}

export async function createContact(db: CrmDatabase, input: ContactInput, actorEmail: string, now = new Date()) {
  const organization = await db.prepare("SELECT id, name FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(input.organizationId).first<{ id: string; name: string }>();
  if (!organization) return null;
  const id = crypto.randomUUID(); const blocked = input.doNotContact || input.unsubscribed;
  const unassigned = await db.prepare("SELECT id, conversation_id AS conversationId FROM deals WHERE organization_id=? AND contact_id IS NULL ORDER BY created_at, id LIMIT 2").bind(input.organizationId).all<{ id: string; conversationId: string }>();
  const soleDeal = unassigned.results.length === 1 ? unassigned.results[0] : null;
  await db.batch([
    db.prepare(`INSERT INTO contacts (id, email, display_name, organization, phone, source, organization_id, role, source_url, source_date, contact_basis, role_relevance, dncl_status, dncl_checked_at, email_status, unsubscribed_at, do_not_call, do_not_contact, next_follow_up_at, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, input.email, input.name, organization.name, input.phone, input.sourceLabel, input.organizationId, input.role, input.sourceUrl, input.sourceDate, input.contactBasis, input.roleRelevance, input.dnclStatus, input.phone && input.dnclStatus !== "not_checked" ? now.toISOString() : null, input.unsubscribed ? "unsubscribed" : input.emailStatus, input.unsubscribed ? now.toISOString() : null, input.doNotCall ? 1 : 0, blocked ? 1 : 0, input.nextFollowUpAt, now.toISOString()),
    ...(soleDeal ? [
      db.prepare("UPDATE deals SET contact_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND contact_id IS NULL").bind(id, soleDeal.id),
      db.prepare("UPDATE conversations SET contact_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND contact_id IS NULL").bind(id, soleDeal.conversationId),
    ] : []),
    audit(db, actorEmail, "contact.created", "contact", id, { organizationId: input.organizationId, validated: true, dealId: soleDeal?.id ?? null }),
  ]);
  return { id };
}

export async function updateContact(db: CrmDatabase, id: string, input: ContactInput, actorEmail: string, now = new Date()) {
  const existing = await db.prepare("SELECT id, email, organization_id AS organizationId, do_not_contact AS doNotContact, unsubscribed_at AS unsubscribedAt FROM contacts WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(id).first<{ id: string; email: string; organizationId: string | null; doNotContact: number | boolean; unsubscribedAt: string | null }>();
  if (!existing) return "not_found" as const;
  const organization = await db.prepare("SELECT name FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(input.organizationId).first<{ name: string }>();
  if (!organization) return "not_found" as const;
  if ((Boolean(existing.doNotContact) || Boolean(existing.unsubscribedAt)) && input.email !== existing.email) return "blocked_identity_change" as const;
  if (existing.organizationId !== input.organizationId) {
    const linked = await db.prepare("SELECT 1 AS present FROM deals WHERE contact_id=? LIMIT 1").bind(id).first();
    if (linked) return "blocked_relationship_change" as const;
  }
  const unsubscribedAt = existing.unsubscribedAt ?? (input.unsubscribed ? now.toISOString() : null);
  const blocked = Boolean(existing.doNotContact) || input.doNotContact || Boolean(unsubscribedAt);
  await db.batch([
    db.prepare(`UPDATE contacts SET email=?, display_name=?, organization=?, phone=?, source=?, organization_id=?, role=?, source_url=?, source_date=?, contact_basis=?, role_relevance=?, dncl_status=?, dncl_checked_at=?, email_status=?, unsubscribed_at=?, do_not_call=?, do_not_contact=?, next_follow_up_at=?, validated_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(input.email, input.name, organization.name, input.phone, input.sourceLabel, input.organizationId, input.role, input.sourceUrl, input.sourceDate, input.contactBasis, input.roleRelevance, input.dnclStatus, input.phone && input.dnclStatus !== "not_checked" ? now.toISOString() : null, unsubscribedAt ? "unsubscribed" : input.emailStatus, unsubscribedAt, input.doNotCall ? 1 : 0, blocked ? 1 : 0, input.nextFollowUpAt, now.toISOString(), id),
    ...(blocked || input.doNotCall || input.dnclStatus === "listed" ? [db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1 AND deal_id IN (SELECT id FROM deals WHERE contact_id=? OR organization_id=?)`).bind(id, input.organizationId)] : []),
    audit(db, actorEmail, "contact.updated", "contact", id, { blocked, unsubscribed: Boolean(unsubscribedAt), doNotCall: input.doNotCall, dnclStatus: input.dnclStatus }),
  ]);
  return "updated" as const;
}

export async function deleteAccount(db: CrmDatabase, id: string, actorEmail: string, now = new Date()) {
  const existing = await db.prepare("SELECT id FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(id).first();
  if (!existing) return false;
  await db.batch([
    db.prepare("UPDATE organizations SET deleted_at=?, do_not_contact=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(now.toISOString(), id),
    db.prepare("UPDATE contacts SET do_not_contact=1, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?").bind(id),
    db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1 AND deal_id IN (SELECT id FROM deals WHERE organization_id=?)`).bind(id),
    audit(db, actorEmail, "account.deleted", "organization", id, {}),
  ]);
  return true;
}

export async function deleteContact(db: CrmDatabase, id: string, actorEmail: string, now = new Date()) {
  const existing = await db.prepare("SELECT id, organization_id AS organizationId FROM contacts WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(id).first<{ id: string; organizationId: string | null }>();
  if (!existing) return false;
  await db.batch([
    db.prepare("UPDATE contacts SET deleted_at=?, do_not_contact=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(now.toISOString(), id),
    db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1 AND deal_id IN (SELECT id FROM deals WHERE contact_id=?)`).bind(id),
    db.prepare("UPDATE deals SET contact_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE contact_id=?").bind(id),
    db.prepare("UPDATE conversations SET contact_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE contact_id=?").bind(id),
    audit(db, actorEmail, "contact.deleted", "contact", id, { organizationId: existing.organizationId }),
  ]);
  return true;
}

export function emailContactability(row: ContactabilityRow): string | null {
  if (row.deletedAt || row.organizationDeletedAt) return "contact_deleted";
  if (Boolean(row.doNotContact) || Boolean(row.organizationDoNotContact)) return "contact_suppressed";
  if (row.unsubscribedAt || row.emailStatus === "unsubscribed") return "contact_unsubscribed";
  if (row.emailStatus !== "valid") return "contact_email_unverified";
  if (!row.validatedAt) return "contact_unvalidated";
  if (row.roleRelevance !== "relevant") return "contact_role_not_relevant";
  if (row.contactBasis === "unknown") return "contact_basis_missing";
  return null;
}

export function phoneContactability(row: ContactabilityRow & { dnclStatus: string }): string | null {
  const commonBlock = emailContactability({ ...row, emailStatus: "valid" });
  if (commonBlock) return commonBlock;
  if (!row.phone) return "contact_phone_missing";
  if (Boolean(row.doNotCall)) return "contact_do_not_call";
  if (row.dnclStatus === "listed") return "contact_dncl_listed";
  if (row.dnclStatus !== "not_listed" && row.dnclStatus !== "not_applicable") return "contact_dncl_unchecked";
  return null;
}

export function entityId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value) ? value : null;
}

function audit(db: CrmDatabase, actor: string, action: string, entityType: string, entityIdValue: string, details: object) {
  return db.prepare(`INSERT INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json) VALUES (?, ?, ?, ?, ?, ?)`).bind(crypto.randomUUID(), actor, action, entityType, entityIdValue, JSON.stringify(details));
}

function enumValue<T extends string>(value: unknown, values: readonly T[]): T | null {
  return typeof value === "string" && values.includes(value as T) ? value as T : null;
}

function optionalInteger(value: unknown, min: number, max: number): number | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : undefined;
}

function optionalDate(value: unknown): string | null | undefined {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return undefined;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value ? undefined : value;
}

function optionalUrl(value: unknown): string | null | undefined {
  const candidate = optionalTrimmedString(value, 2_000);
  if (candidate == null) return candidate;
  try {
    const url = new URL(candidate);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch { return undefined; }
}
