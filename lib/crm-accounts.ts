import type { CrmDatabase } from "./d1";
import { LAWFUL_BASES, PROVENANCE_TYPES, type LawfulBasis, type ProvenanceType } from "./compliance";
import { optionalTrimmedString, validIsoTimestamp } from "./http";
import { normalizeEmailAddress } from "./mailboxes";

export const ACCOUNT_PRIORITIES = ["very_high", "high", "normal", "low"] as const;
export const CONTACT_BASES = ["inbound_request", "explicit_consent", "legitimate_interest", "existing_client"] as const;
export const ROLE_RELEVANCE = ["relevant", "not_relevant"] as const;
export const DNCL_STATUSES = ["not_checked", "not_listed", "listed", "not_applicable"] as const;
export const EMAIL_STATUSES = ["valid", "bounced", "invalid", "unsubscribed"] as const;
export const PERSONAL_DATA_CATEGORIES = ["work_contact", "other_personal"] as const;
export const QUALIFICATION_MODES = ["manual", "assisted", "fully_automated"] as const;

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
  provenanceType: ProvenanceType; evidenceRef: string; lawfulBasis: LawfulBasis;
  basisEvidenceRef: string | null; basisExpiresAt: string | null;
  publicationByRecipient: boolean; publicationNoRestriction: boolean;
  publicationRoleRelevance: string; directDisclosureNoRestriction: boolean;
  b2bRelationshipEvidence: string; b2bMessageRelevance: string;
  roleRelevance: (typeof ROLE_RELEVANCE)[number]; roleRelevanceDetail: string;
  personalDataCategory: (typeof PERSONAL_DATA_CATEGORIES)[number];
  qualificationMode: (typeof QUALIFICATION_MODES)[number];
  dnclStatus: (typeof DNCL_STATUSES)[number]; emailStatus: (typeof EMAIL_STATUSES)[number];
  dnclCheckedAt: string | null; dnclEvidenceRef: string | null;
  phoneEvidenceRef: string | null; recipientTimezone: string | null;
  doNotCall: boolean; doNotContact: boolean; unsubscribed: boolean; validated: boolean;
  nextFollowUpAt: string | null;
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
  const phone = payload.phone == null || payload.phone === "" ? null : typeof payload.phone === "string" ? normalizePhone(payload.phone) : undefined;
  const role = optionalTrimmedString(payload.role, 200);
  const sourceLabel = optionalTrimmedString(payload.sourceLabel, 200);
  const sourceUrl = optionalUrl(payload.sourceUrl);
  const sourceDate = optionalDate(payload.sourceDate);
  const provenanceType = enumValue(payload.provenanceType, PROVENANCE_TYPES);
  const evidenceRef = optionalTrimmedString(payload.evidenceRef, 2_000);
  const lawfulBasis = enumValue(payload.lawfulBasis ?? payload.contactBasis, LAWFUL_BASES);
  const basisEvidenceRef = optionalTrimmedString(payload.basisEvidenceRef, 2_000);
  const basisExpiresAt = payload.basisExpiresAt == null || payload.basisExpiresAt === "" ? null : validIsoTimestamp(payload.basisExpiresAt);
  const publicationRoleRelevance = optionalTrimmedString(payload.publicationRoleRelevance, 2_000) ?? "";
  const b2bRelationshipEvidence = optionalTrimmedString(payload.b2bRelationshipEvidence, 2_000) ?? "";
  const b2bMessageRelevance = optionalTrimmedString(payload.b2bMessageRelevance, 2_000) ?? "";
  const roleRelevance = enumValue(payload.roleRelevance, ROLE_RELEVANCE);
  const roleRelevanceDetail = optionalTrimmedString(payload.roleRelevanceDetail, 2_000);
  const personalDataCategory = enumValue(payload.personalDataCategory, PERSONAL_DATA_CATEGORIES);
  const qualificationMode = enumValue(payload.qualificationMode, QUALIFICATION_MODES);
  const dnclStatus = enumValue(payload.dnclStatus, DNCL_STATUSES);
  const emailStatus = enumValue(payload.emailStatus, EMAIL_STATUSES);
  const dnclCheckedAt = payload.dnclCheckedAt == null || payload.dnclCheckedAt === "" ? null : validIsoTimestamp(payload.dnclCheckedAt);
  const dnclEvidenceRef = optionalTrimmedString(payload.dnclEvidenceRef, 2_000);
  const phoneEvidenceRef = optionalTrimmedString(payload.phoneEvidenceRef, 2_000);
  const recipientTimezone = optionalTimezone(payload.recipientTimezone);
  const unsubscribed = payload.unsubscribed === true || emailStatus === "unsubscribed";
  const nextFollowUpAt = payload.nextFollowUpAt == null || payload.nextFollowUpAt === "" ? null : validIsoTimestamp(payload.nextFollowUpAt);
  if (!organizationId) return { ok: false, code: "contact_organization_invalid" };
  if (!name || !email || !role) return { ok: false, code: "contact_identity_invalid" };
  if (phone === undefined) return { ok: false, code: "contact_phone_invalid" };
  if (!sourceLabel || !sourceUrl || !sourceDate || !provenanceType || !evidenceRef) return { ok: false, code: "contact_source_required" };
  if (new Date(`${sourceDate}T00:00:00.000Z`).valueOf() > Date.now()) return { ok: false, code: "contact_source_date_future" };
  if (!lawfulBasis) return { ok: false, code: "contact_basis_required" };
  if (lawfulBasis !== "none" && !basisEvidenceRef) return { ok: false, code: "contact_basis_proof_required" };
  if ((lawfulBasis === "existing_business_relationship" || lawfulBasis === "requested_response") && !basisExpiresAt) return { ok: false, code: "contact_basis_expiry_required" };
  if (basisExpiresAt === undefined) return { ok: false, code: "contact_basis_expiry_invalid" };
  if (!roleRelevance || !roleRelevanceDetail) return { ok: false, code: "contact_role_relevance_required" };
  if (!personalDataCategory || !qualificationMode) return { ok: false, code: "contact_privacy_classification_required" };
  if (!dnclStatus || !emailStatus) return { ok: false, code: "contact_status_required" };
  if (dnclCheckedAt === undefined) return { ok: false, code: "contact_dncl_date_invalid" };
  if (dnclCheckedAt && new Date(dnclCheckedAt).valueOf() > Date.now()) return { ok: false, code: "contact_dncl_date_future" };
  if (phone && (!phoneEvidenceRef || !recipientTimezone)) return { ok: false, code: "contact_phone_proof_required" };
  if (phone && dnclStatus !== "not_checked" && (!dnclCheckedAt || !dnclEvidenceRef)) return { ok: false, code: "contact_dncl_proof_required" };
  if (nextFollowUpAt === undefined) return { ok: false, code: "contact_follow_up_invalid" };
  if (payload.validated !== true) return { ok: false, code: "contact_validation_required" };
  return { ok: true, value: { organizationId, name, email, phone: phone ?? null, role, sourceLabel, sourceUrl, sourceDate, provenanceType, evidenceRef, lawfulBasis, basisEvidenceRef: basisEvidenceRef ?? null, basisExpiresAt, publicationByRecipient: payload.publicationByRecipient === true, publicationNoRestriction: payload.publicationNoRestriction === true, publicationRoleRelevance, directDisclosureNoRestriction: payload.directDisclosureNoRestriction === true, b2bRelationshipEvidence, b2bMessageRelevance, roleRelevance, roleRelevanceDetail, personalDataCategory, qualificationMode, dnclStatus, emailStatus: unsubscribed ? "unsubscribed" : emailStatus, dnclCheckedAt, dnclEvidenceRef: dnclEvidenceRef ?? null, phoneEvidenceRef: phoneEvidenceRef ?? null, recipientTimezone: recipientTimezone ?? null, doNotCall: payload.doNotCall === true, doNotContact: payload.doNotContact === true, unsubscribed, validated: true, nextFollowUpAt } };
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
  const now = new Date();
  const nowIso = now.toISOString();
  await db.batch([
    db.prepare(`UPDATE organizations SET name=?, website=?, source_label=?, source_url=?, source_date=?, score=?, priority=?, budget_min_cents=?, budget_max_cents=?, owner_email=?, do_not_contact=CASE WHEN do_not_contact=1 THEN 1 ELSE ? END, next_follow_up_at=?, next_step=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(input.name, input.website, input.sourceLabel, input.sourceUrl, input.sourceDate, input.score, input.priority, input.budgetMinCents, input.budgetMaxCents, input.ownerEmail, doNotContact ? 1 : 0, input.nextFollowUpAt, input.nextStep, input.notes, id),
    db.prepare(`UPDATE deals SET next_action=?, next_action_at=?, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`).bind(input.nextStep, input.nextFollowUpAt, id),
    ...(doNotContact ? [
      db.prepare(`UPDATE contacts SET do_not_contact=1,
        compliance_version=compliance_version + CASE WHEN do_not_contact=0 THEN 1 ELSE 0 END,
        updated_at=CURRENT_TIMESTAMP WHERE organization_id=?`).bind(id),
      db.prepare(`INSERT OR IGNORE INTO contact_suppressions (id, channel, address_normalized, scope, category, reason, evidence_ref, requested_at, effective_at, created_by)
        SELECT 'account-block-email:' || contact.id, 'email', lower(trim(contact.email)), 'global', 'all', 'account_do_not_contact', 'organization:' || ?, ?, ?, ?
        FROM contacts contact WHERE contact.organization_id=?`).bind(id, nowIso, nowIso, actorEmail, id),
      db.prepare(`INSERT OR IGNORE INTO contact_suppressions (id, channel, address_normalized, scope, category, reason, evidence_ref, requested_at, effective_at, retain_until, created_by)
        SELECT 'account-block-phone:' || contact.id, 'phone', trim(contact.phone), 'global', 'all', 'account_do_not_contact', 'organization:' || ?, ?, ?, ?, ?
        FROM contacts contact WHERE contact.organization_id=? AND contact.phone IS NOT NULL AND trim(contact.phone)<>''`).bind(id, nowIso, nowIso, phoneRetentionUntil(now), actorEmail, id),
      db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1
        AND (deal_id IN (SELECT deal.id FROM deals deal WHERE deal.organization_id=?)
          OR conversation_id IN (SELECT deal.conversation_id FROM deals deal WHERE deal.organization_id=?)
          OR conversation_id IN (SELECT conversation.id FROM conversations conversation JOIN contacts contact ON contact.id=conversation.contact_id WHERE contact.organization_id=?))`).bind(id, id, id),
      db.prepare(`UPDATE send_commands SET status='cancelled', failure_code='account_suppressed', updated_at=CURRENT_TIMESTAMP
        WHERE contact_id IN (SELECT contact.id FROM contacts contact WHERE contact.organization_id=?)
          AND status IN ('pending','authorized')`).bind(id),
    ] : []),
    audit(db, actorEmail, "account.updated", "organization", id, { doNotContact }),
  ]);
  return true;
}

export async function createContact(db: CrmDatabase, input: ContactInput, actorEmail: string, now = new Date()) {
  const organization = await db.prepare("SELECT id, name FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(input.organizationId).first<{ id: string; name: string }>();
  if (!organization) return null;
  const id = crypto.randomUUID(); const blocked = input.doNotContact || input.unsubscribed;
  const emailChannelId = crypto.randomUUID();
  const phoneChannelId = input.phone ? crypto.randomUUID() : null;
  const legacyBasis = legacyContactBasis(input.lawfulBasis);
  const nowIso = now.toISOString();
  const unassigned = await db.prepare("SELECT id, conversation_id AS conversationId FROM deals WHERE organization_id=? AND contact_id IS NULL ORDER BY created_at, id LIMIT 2").bind(input.organizationId).all<{ id: string; conversationId: string }>();
  const soleDeal = unassigned.results.length === 1 ? unassigned.results[0] : null;
  await db.batch([
    db.prepare(`INSERT INTO contacts (id, email, display_name, organization, phone, source, organization_id, role, role_relevance_detail, personal_data_category, qualification_mode, source_url, source_date, contact_basis, role_relevance, dncl_status, dncl_checked_at, email_status, unsubscribed_at, do_not_call, do_not_contact, next_follow_up_at, validated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, input.email, input.name, organization.name, input.phone, input.sourceLabel, input.organizationId, input.role, input.roleRelevanceDetail, input.personalDataCategory, input.qualificationMode, input.sourceUrl, input.sourceDate, legacyBasis, input.roleRelevance, input.dnclStatus, input.dnclCheckedAt, input.unsubscribed ? "unsubscribed" : input.emailStatus, input.unsubscribed ? nowIso : null, input.doNotCall ? 1 : 0, blocked ? 1 : 0, input.nextFollowUpAt, nowIso),
    db.prepare(`INSERT INTO contact_channel_compliance (id, contact_id, channel, address_normalized, provenance_type, source_url, captured_at, evidence_ref, lawful_basis, basis_verified_by, basis_verified_at, basis_evidence_ref, basis_expires_at, publication_by_recipient, publication_no_restriction, publication_role_relevance, direct_disclosure_no_restriction, b2b_relationship_evidence, b2b_message_relevance, dncl_status, status, validated_at) VALUES (?, ?, 'email', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_applicable', ?, ?)`).bind(emailChannelId, id, input.email, input.provenanceType, input.sourceUrl, input.sourceDate, input.evidenceRef, input.lawfulBasis, input.lawfulBasis === "none" ? null : actorEmail, input.lawfulBasis === "none" ? null : nowIso, input.basisEvidenceRef, input.basisExpiresAt, input.publicationByRecipient ? 1 : 0, input.publicationNoRestriction ? 1 : 0, input.publicationRoleRelevance, input.directDisclosureNoRestriction ? 1 : 0, input.b2bRelationshipEvidence, input.b2bMessageRelevance, input.unsubscribed ? "unsubscribed" : input.emailStatus, nowIso),
    ...(input.phone && phoneChannelId ? [db.prepare(`INSERT INTO contact_channel_compliance (id, contact_id, channel, address_normalized, provenance_type, source_url, captured_at, evidence_ref, lawful_basis, dncl_status, dncl_checked_at, dncl_evidence_ref, recipient_timezone, status, validated_at) VALUES (?, ?, 'phone', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, 'valid', ?)`).bind(phoneChannelId, id, input.phone, input.provenanceType, input.sourceUrl, input.sourceDate, input.phoneEvidenceRef, input.dnclStatus, input.dnclCheckedAt, input.dnclEvidenceRef, input.recipientTimezone, nowIso)] : []),
    ...(input.unsubscribed || input.doNotContact ? [suppression(db, "email", input.email, input.unsubscribed ? "unsubscribe" : "do_not_contact", `contact:${id}`, actorEmail, nowIso, null)] : []),
    ...(input.phone && (input.doNotCall || input.doNotContact) ? [suppression(db, "phone", input.phone, "do_not_call", `contact:${id}`, actorEmail, nowIso, phoneRetentionUntil(now))] : []),
    ...(soleDeal ? [
      db.prepare("UPDATE deals SET contact_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND contact_id IS NULL").bind(id, soleDeal.id),
      db.prepare("UPDATE conversations SET contact_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=? AND contact_id IS NULL").bind(id, soleDeal.conversationId),
    ] : []),
    audit(db, actorEmail, "contact.created", "contact", id, { evidenceSnapshot: input, validated: true, dealId: soleDeal?.id ?? null }),
  ]);
  return { id };
}

export async function updateContact(db: CrmDatabase, id: string, input: ContactInput, actorEmail: string, now = new Date()) {
  const existing = await db.prepare("SELECT id, email, phone, organization_id AS organizationId, do_not_contact AS doNotContact, do_not_call AS doNotCall, unsubscribed_at AS unsubscribedAt FROM contacts WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(id).first<{ id: string; email: string; phone: string | null; organizationId: string | null; doNotContact: number | boolean; doNotCall: number | boolean; unsubscribedAt: string | null }>();
  if (!existing) return "not_found" as const;
  const organization = await db.prepare("SELECT name FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(input.organizationId).first<{ name: string }>();
  if (!organization) return "not_found" as const;
  if (Boolean(existing.doNotContact) || Boolean(existing.unsubscribedAt)) return "blocked_record_locked" as const;
  if ((Boolean(existing.doNotContact) || Boolean(existing.unsubscribedAt)) && input.email !== existing.email) return "blocked_identity_change" as const;
  if (Boolean(existing.doNotCall) && input.phone !== existing.phone) return "blocked_identity_change" as const;
  if (existing.organizationId !== input.organizationId) {
    const linked = await db.prepare("SELECT 1 AS present FROM deals WHERE contact_id=? LIMIT 1").bind(id).first();
    if (linked) return "blocked_relationship_change" as const;
  }
  const nowIso = now.toISOString();
  const unsubscribedAt = existing.unsubscribedAt ?? (input.unsubscribed ? nowIso : null);
  const blocked = Boolean(existing.doNotContact) || input.doNotContact || Boolean(unsubscribedAt);
  const doNotCall = Boolean(existing.doNotCall) || input.doNotCall || blocked;
  const legacyBasis = legacyContactBasis(input.lawfulBasis);
  await db.batch([
    db.prepare(`UPDATE contacts SET email=?, display_name=?, organization=?, phone=?, source=?, organization_id=?, role=?, role_relevance_detail=?, personal_data_category=?, qualification_mode=?, compliance_version=compliance_version+1, source_url=?, source_date=?, contact_basis=?, role_relevance=?, dncl_status=?, dncl_checked_at=?, email_status=?, unsubscribed_at=?, do_not_call=?, do_not_contact=?, next_follow_up_at=?, validated_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(input.email, input.name, organization.name, input.phone, input.sourceLabel, input.organizationId, input.role, input.roleRelevanceDetail, input.personalDataCategory, input.qualificationMode, input.sourceUrl, input.sourceDate, legacyBasis, input.roleRelevance, input.dnclStatus, input.dnclCheckedAt, unsubscribedAt ? "unsubscribed" : input.emailStatus, unsubscribedAt, doNotCall ? 1 : 0, blocked ? 1 : 0, input.nextFollowUpAt, nowIso, id),
    db.prepare(`UPDATE contact_channel_compliance SET address_normalized=?, provenance_type=?, source_url=?, captured_at=?, evidence_ref=?, lawful_basis=?, basis_verified_by=?, basis_verified_at=?, basis_evidence_ref=?, basis_expires_at=?, publication_by_recipient=?, publication_no_restriction=?, publication_role_relevance=?, direct_disclosure_no_restriction=?, b2b_relationship_evidence=?, b2b_message_relevance=?, status=?, validated_at=?, updated_at=CURRENT_TIMESTAMP WHERE contact_id=? AND channel='email'`).bind(input.email, input.provenanceType, input.sourceUrl, input.sourceDate, input.evidenceRef, input.lawfulBasis, input.lawfulBasis === "none" ? null : actorEmail, input.lawfulBasis === "none" ? null : nowIso, input.basisEvidenceRef, input.basisExpiresAt, input.publicationByRecipient ? 1 : 0, input.publicationNoRestriction ? 1 : 0, input.publicationRoleRelevance, input.directDisclosureNoRestriction ? 1 : 0, input.b2bRelationshipEvidence, input.b2bMessageRelevance, unsubscribedAt ? "unsubscribed" : input.emailStatus, nowIso, id),
    ...(input.phone ? [
      db.prepare(`UPDATE contact_channel_compliance SET address_normalized=?, provenance_type=?, source_url=?, captured_at=?, evidence_ref=?, dncl_status=?, dncl_checked_at=?, dncl_evidence_ref=?, recipient_timezone=?, status='valid', validated_at=?, updated_at=CURRENT_TIMESTAMP WHERE contact_id=? AND channel='phone'`).bind(input.phone, input.provenanceType, input.sourceUrl, input.sourceDate, input.phoneEvidenceRef, input.dnclStatus, input.dnclCheckedAt, input.dnclEvidenceRef, input.recipientTimezone, nowIso, id),
      db.prepare(`INSERT INTO contact_channel_compliance (id, contact_id, channel, address_normalized, provenance_type, source_url, captured_at, evidence_ref, lawful_basis, dncl_status, dncl_checked_at, dncl_evidence_ref, recipient_timezone, status, validated_at)
        SELECT ?, ?, 'phone', ?, ?, ?, ?, ?, 'none', ?, ?, ?, ?, 'valid', ?
        WHERE NOT EXISTS (SELECT 1 FROM contact_channel_compliance WHERE contact_id=? AND channel='phone')`).bind(crypto.randomUUID(), id, input.phone, input.provenanceType, input.sourceUrl, input.sourceDate, input.phoneEvidenceRef, input.dnclStatus, input.dnclCheckedAt, input.dnclEvidenceRef, input.recipientTimezone, nowIso, id),
    ] : [db.prepare("DELETE FROM contact_channel_compliance WHERE contact_id=? AND channel='phone'").bind(id)]),
    ...(unsubscribedAt || blocked ? [suppression(db, "email", input.email, unsubscribedAt ? "unsubscribe" : "do_not_contact", `contact:${id}`, actorEmail, nowIso, null)] : []),
    ...(input.phone && doNotCall ? [suppression(db, "phone", input.phone, "do_not_call", `contact:${id}`, actorEmail, nowIso, phoneRetentionUntil(now))] : []),
    ...(blocked ? [db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1 AND (conversation_id IN (SELECT id FROM conversations WHERE contact_id=?) OR deal_id IN (SELECT id FROM deals WHERE contact_id=?))`).bind(id, id)]
      : doNotCall || input.dnclStatus === "listed" ? [db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1 AND contact_channel='phone' AND (conversation_id IN (SELECT id FROM conversations WHERE contact_id=?) OR deal_id IN (SELECT id FROM deals WHERE contact_id=?))`).bind(id, id)] : []),
    ...(blocked ? [db.prepare(`UPDATE send_commands SET status='cancelled', failure_code='contact_suppressed', updated_at=CURRENT_TIMESTAMP WHERE contact_id=? AND status IN ('pending','authorized')`).bind(id)] : []),
    audit(db, actorEmail, "contact.updated", "contact", id, { evidenceSnapshot: input, blocked, unsubscribed: Boolean(unsubscribedAt), doNotCall }),
  ]);
  return "updated" as const;
}

export async function deleteAccount(db: CrmDatabase, id: string, actorEmail: string, now = new Date()) {
  const existing = await db.prepare("SELECT id FROM organizations WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(id).first();
  if (!existing) return false;
  await db.batch([
    db.prepare("UPDATE organizations SET deleted_at=?, do_not_contact=1, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(now.toISOString(), id),
    db.prepare("UPDATE contacts SET do_not_contact=1, compliance_version=compliance_version+1, updated_at=CURRENT_TIMESTAMP WHERE organization_id=?").bind(id),
    db.prepare(`INSERT OR IGNORE INTO contact_suppressions (id, channel, address_normalized, scope, category, reason, evidence_ref, requested_at, effective_at, created_by) SELECT 'account-delete-email:' || contact.id, 'email', lower(trim(contact.email)), 'global', 'all', 'account_deleted', 'organization:' || ?, ?, ?, ? FROM contacts contact WHERE contact.organization_id=?`).bind(id, now.toISOString(), now.toISOString(), actorEmail, id),
    db.prepare(`INSERT OR IGNORE INTO contact_suppressions (id, channel, address_normalized, scope, category, reason, evidence_ref, requested_at, effective_at, retain_until, created_by) SELECT 'account-delete-phone:' || contact.id, 'phone', trim(contact.phone), 'global', 'all', 'account_deleted', 'organization:' || ?, ?, ?, ?, ? FROM contacts contact WHERE contact.organization_id=? AND contact.phone IS NOT NULL AND trim(contact.phone)<>''`).bind(id, now.toISOString(), now.toISOString(), phoneRetentionUntil(now), actorEmail, id),
    db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1
      AND (deal_id IN (SELECT deal.id FROM deals deal WHERE deal.organization_id=?)
        OR conversation_id IN (SELECT deal.conversation_id FROM deals deal WHERE deal.organization_id=?)
        OR conversation_id IN (SELECT conversation.id FROM conversations conversation JOIN contacts contact ON contact.id=conversation.contact_id WHERE contact.organization_id=?))`).bind(id, id, id),
    db.prepare(`UPDATE send_commands SET status='cancelled', failure_code='account_suppressed', updated_at=CURRENT_TIMESTAMP WHERE contact_id IN (SELECT id FROM contacts WHERE organization_id=?) AND status IN ('pending','authorized')`).bind(id),
    audit(db, actorEmail, "account.deleted", "organization", id, {}),
  ]);
  return true;
}

export async function deleteContact(db: CrmDatabase, id: string, actorEmail: string, now = new Date()) {
  const existing = await db.prepare("SELECT id, email, phone, organization_id AS organizationId FROM contacts WHERE id=? AND deleted_at IS NULL LIMIT 1").bind(id).first<{ id: string; email: string; phone: string | null; organizationId: string | null }>();
  if (!existing) return false;
  await db.batch([
    db.prepare("UPDATE contacts SET deleted_at=?, do_not_contact=1, compliance_version=compliance_version+1, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(now.toISOString(), id),
    suppression(db, "email", existing.email, "contact_deleted", `contact:${id}`, actorEmail, now.toISOString(), null),
    ...(existing.phone ? [suppression(db, "phone", existing.phone, "contact_deleted", `contact:${id}`, actorEmail, now.toISOString(), phoneRetentionUntil(now))] : []),
    db.prepare(`UPDATE tasks SET status='cancelled' WHERE status='open' AND contact_action=1 AND (conversation_id IN (SELECT id FROM conversations WHERE contact_id=?) OR deal_id IN (SELECT id FROM deals WHERE contact_id=?))`).bind(id, id),
    db.prepare(`UPDATE send_commands SET status='cancelled', failure_code='contact_deleted', updated_at=CURRENT_TIMESTAMP WHERE contact_id=? AND status IN ('pending','authorized')`).bind(id),
    db.prepare("UPDATE deals SET contact_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE contact_id=?").bind(id),
    db.prepare("UPDATE conversations SET contact_id=NULL, updated_at=CURRENT_TIMESTAMP WHERE contact_id=?").bind(id),
    audit(db, actorEmail, "contact.deleted", "contact", id, { organizationId: existing.organizationId }),
  ]);
  return true;
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

function optionalTimezone(value: unknown): string | null | undefined {
  const candidate = optionalTrimmedString(value, 100);
  if (candidate == null) return candidate;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: candidate }).format(new Date());
    return candidate;
  } catch {
    return undefined;
  }
}

export function normalizePhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/gu, "");
  if (/^\+[1-9]\d{7,14}$/u.test(compact)) return compact;
  if (/^\d{10}$/u.test(compact)) return `+1${compact}`;
  if (/^1\d{10}$/u.test(compact)) return `+${compact}`;
  return null;
}

function legacyContactBasis(basis: LawfulBasis): (typeof CONTACT_BASES)[number] | "unknown" {
  if (basis === "explicit_consent") return "explicit_consent";
  if (basis === "existing_business_relationship") return "existing_client";
  if (basis === "requested_response") return "inbound_request";
  return "unknown";
}

function phoneRetentionUntil(now: Date): string {
  const retained = new Date(now);
  retained.setUTCFullYear(retained.getUTCFullYear() + 3);
  retained.setUTCDate(retained.getUTCDate() + 14);
  return retained.toISOString();
}

function suppression(
  db: CrmDatabase,
  channel: "email" | "phone",
  address: string,
  reason: string,
  evidenceRef: string,
  actorEmail: string,
  nowIso: string,
  retainUntil: string | null,
) {
  const normalizedAddress = channel === "email" ? address.toLowerCase().trim() : normalizePhone(address) ?? address.trim();
  return db.prepare(`INSERT OR IGNORE INTO contact_suppressions
    (id, channel, address_normalized, scope, category, reason, evidence_ref,
     requested_at, effective_at, retain_until, created_by)
    VALUES (?, ?, ?, 'global', 'all', ?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), channel, normalizedAddress, reason, evidenceRef, nowIso, nowIso, retainUntil, actorEmail);
}
