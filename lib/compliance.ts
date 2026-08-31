import type { CrmDatabase } from "./d1";

export const LAWFUL_BASES = [
  "explicit_consent",
  "existing_business_relationship",
  "conspicuous_publication",
  "direct_disclosure",
  "b2b_exemption",
  "requested_response",
  "none",
] as const;

export const PROVENANCE_TYPES = [
  "first_party_inbound",
  "recipient_published",
  "authorized_publication",
  "direct_disclosure",
  "existing_relationship",
  "third_party",
  "unknown",
] as const;

export type LawfulBasis = (typeof LAWFUL_BASES)[number];
export type ProvenanceType = (typeof PROVENANCE_TYPES)[number];

export type ComplianceConfiguration = {
  version: number;
  senderName: string;
  organizationName: string;
  postalAddress: string;
  contactMethod: string;
  identityValidUntil: string | null;
  unsubscribeMechanismValidatedAt: string | null;
  unsubscribeMechanismValidUntil: string | null;
  dnclRegistrationConfirmed: number | boolean;
  dnclRegistrationVerifiedAt: string | null;
  dnclRegistrationEvidenceRef: string;
  businessNumberConfirmed: number | boolean;
  businessNumber: string;
  businessNumberEvidenceRef: string;
  callerIdentity: string;
  callerDisplayNumber: string;
  automatedDialerDisabled: number | boolean;
  prerecordedCallsDisabled: number | boolean;
  sequentialDialingDisabled: number | boolean;
  crossBorderEfvpConfirmed: number | boolean;
  crossBorderContractConfirmed: number | boolean;
  crossBorderLegalValidationConfirmed: number | boolean;
  crossBorderEvidenceRef: string;
  automatedQualificationLegalValidationConfirmed: number | boolean;
  automatedQualificationEvidenceRef: string;
  unsubscribeSigningKeyConfigured?: boolean;
};

export type ContactCompliance = {
  contactId: string;
  organizationId: string | null;
  complianceVersion: number;
  validatedAt: string | null;
  deletedAt: string | null;
  organizationDeletedAt: string | null;
  doNotContact: number | boolean;
  organizationDoNotContact: number | boolean | null;
  doNotCall: number | boolean;
  unsubscribedAt: string | null;
  roleRelevance: string;
  roleRelevanceDetail: string;
  personalDataCategory: string;
  qualificationMode: string;
  channelId: string;
  channel: "email" | "phone";
  addressNormalized: string;
  provenanceType: string;
  sourceUrl: string | null;
  capturedAt: string | null;
  evidenceRef: string | null;
  lawfulBasis: string;
  basisVerifiedBy: string | null;
  basisVerifiedAt: string | null;
  basisEvidenceRef: string | null;
  basisExpiresAt: string | null;
  publicationByRecipient: number | boolean;
  publicationNoRestriction: number | boolean;
  publicationRoleRelevance: string;
  directDisclosureNoRestriction: number | boolean;
  b2bRelationshipEvidence: string;
  b2bMessageRelevance: string;
  dnclStatus: string;
  dnclCheckedAt: string | null;
  dnclEvidenceRef: string | null;
  recipientTimezone: string | null;
  status: string;
  channelValidatedAt: string | null;
  suppressionCount: number;
};

export type ComplianceDecision = {
  allowed: boolean;
  reasons: string[];
  evaluatedAt: string;
  contactVersion: number;
  configurationVersion: number;
};

export const CASL_MINIMUM_POST_SEND_VALIDITY_MS = 60 * 24 * 60 * 60 * 1000;
export const CASL_DISPATCH_VALIDITY_MARGIN_MS = 24 * 60 * 60 * 1000;
export const UNSUBSCRIBE_TOKEN_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;

export function canEmail(
  contact: ContactCompliance,
  configuration: ComplianceConfiguration,
  now = new Date(),
): ComplianceDecision {
  const reasons = commonReasons(contact, configuration, now);
  if (contact.channel !== "email") reasons.push("email_channel_missing");
  if (contact.status === "unsubscribed" || contact.unsubscribedAt) reasons.push("email_unsubscribed");
  else if (contact.status !== "valid") reasons.push("email_status_not_valid");
  if (contact.suppressionCount > 0) reasons.push("email_suppressed");
  if (!contact.sourceUrl || !validPastOrPresent(contact.capturedAt, now) || !contact.evidenceRef) reasons.push("email_provenance_incomplete");
  if (contact.lawfulBasis === "none") reasons.push("email_lawful_basis_missing");
  if (!contact.basisVerifiedBy || !validPastOrPresent(contact.basisVerifiedAt, now) || !contact.basisEvidenceRef) {
    reasons.push("email_basis_proof_incomplete");
  }
  if (contact.basisExpiresAt && (!validDate(contact.basisExpiresAt) || new Date(contact.basisExpiresAt).valueOf() <= now.valueOf())) {
    reasons.push(validDate(contact.basisExpiresAt) ? "email_basis_expired" : "email_basis_expiry_invalid");
  }
  if (["existing_business_relationship", "requested_response"].includes(contact.lawfulBasis) && !contact.basisExpiresAt) {
    reasons.push("email_basis_expiry_required");
  }
  if (contact.lawfulBasis === "conspicuous_publication") {
    if (!["recipient_published", "authorized_publication"].includes(contact.provenanceType)) reasons.push("publication_not_by_recipient_or_authorized");
    if (!Boolean(contact.publicationByRecipient)) reasons.push("publication_authority_unproven");
    if (!Boolean(contact.publicationNoRestriction)) reasons.push("publication_restricts_contact");
    if (!contact.publicationRoleRelevance.trim()) reasons.push("publication_role_relevance_missing");
  }
  if (contact.lawfulBasis === "direct_disclosure") {
    if (contact.provenanceType !== "direct_disclosure") reasons.push("direct_disclosure_provenance_missing");
    if (!Boolean(contact.directDisclosureNoRestriction)) reasons.push("direct_disclosure_restriction_unknown");
    if (!contact.publicationRoleRelevance.trim()) reasons.push("direct_disclosure_relevance_missing");
  }
  if (contact.lawfulBasis === "b2b_exemption") {
    if (!contact.b2bRelationshipEvidence.trim()) reasons.push("b2b_relationship_unproven");
    if (!contact.b2bMessageRelevance.trim()) reasons.push("b2b_message_relevance_missing");
  }
  const requiredPostSendValidity = now.valueOf() +
    CASL_MINIMUM_POST_SEND_VALIDITY_MS + CASL_DISPATCH_VALIDITY_MARGIN_MS;
  if (!configuration.senderName || !configuration.organizationName || !configuration.postalAddress || !configuration.contactMethod) reasons.push("sender_identity_incomplete");
  if (!validDate(configuration.identityValidUntil) || new Date(configuration.identityValidUntil!).valueOf() < requiredPostSendValidity) reasons.push("sender_identity_validity_insufficient");
  if (!validPastOrPresent(configuration.unsubscribeMechanismValidatedAt, now) || !validDate(configuration.unsubscribeMechanismValidUntil) || new Date(configuration.unsubscribeMechanismValidUntil!).valueOf() < requiredPostSendValidity || !configuration.unsubscribeSigningKeyConfigured) reasons.push("unsubscribe_mechanism_incomplete");
  if (!Boolean(configuration.crossBorderEfvpConfirmed)) reasons.push("cross_border_efvp_unconfirmed");
  if (!Boolean(configuration.crossBorderContractConfirmed)) reasons.push("cross_border_contract_unconfirmed");
  if (!Boolean(configuration.crossBorderLegalValidationConfirmed)) reasons.push("cross_border_legal_validation_unconfirmed");
  if (!configuration.crossBorderEvidenceRef.trim()) reasons.push("cross_border_evidence_missing");
  return decision(reasons, contact, configuration, now);
}

export function canCall(
  contact: ContactCompliance,
  configuration: ComplianceConfiguration,
  now = new Date(),
): ComplianceDecision {
  const reasons = commonReasons(contact, configuration, now);
  if (contact.channel !== "phone" || !contact.addressNormalized) reasons.push("phone_missing");
  if (Boolean(contact.doNotCall) || contact.suppressionCount > 0) reasons.push("phone_do_not_call");
  if (contact.status !== "valid") reasons.push("phone_status_not_valid");
  if (!contact.evidenceRef || !validPastOrPresent(contact.capturedAt, now) || contact.provenanceType === "unknown") reasons.push("phone_provenance_incomplete");
  if (contact.dnclStatus !== "not_listed") reasons.push(contact.dnclStatus === "listed" ? "phone_dncl_listed" : "phone_dncl_unverified");
  if (!validDate(contact.dnclCheckedAt) || !contact.dnclEvidenceRef) reasons.push("phone_dncl_proof_incomplete");
  else {
    const age = now.valueOf() - new Date(contact.dnclCheckedAt!).valueOf();
    if (age < 0 || age > 31 * 24 * 60 * 60 * 1000) reasons.push("phone_dncl_check_expired");
  }
  if (!Boolean(configuration.dnclRegistrationConfirmed) || !validPastOrPresent(configuration.dnclRegistrationVerifiedAt, now) || !configuration.dnclRegistrationEvidenceRef) reasons.push("organization_dncl_registration_unconfirmed");
  if (!Boolean(configuration.businessNumberConfirmed) || !configuration.businessNumber || !configuration.businessNumberEvidenceRef) reasons.push("business_number_unconfirmed");
  if (!configuration.callerIdentity || !configuration.callerDisplayNumber) reasons.push("caller_identity_incomplete");
  if (!Boolean(configuration.automatedDialerDisabled) || !Boolean(configuration.prerecordedCallsDisabled) || !Boolean(configuration.sequentialDialingDisabled)) reasons.push("prohibited_call_automation_enabled");
  if (!contact.recipientTimezone) reasons.push("recipient_timezone_missing");
  else if (!isAllowedCallingTime(now, contact.recipientTimezone)) reasons.push("outside_calling_hours");
  return decision(reasons, contact, configuration, now);
}

export function isAllowedCallingTime(now: Date, timezone: string): boolean {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(now);
    const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const minuteOfDay = Number(value.hour) * 60 + Number(value.minute);
    const weekend = value.weekday === "Sat" || value.weekday === "Sun";
    return weekend
      ? minuteOfDay >= 10 * 60 && minuteOfDay < 18 * 60
      : minuteOfDay >= 9 * 60 && minuteOfDay < 21 * 60 + 30;
  } catch {
    return false;
  }
}

export async function loadComplianceConfiguration(db: CrmDatabase): Promise<ComplianceConfiguration> {
  const row = await db.prepare(`SELECT version,
    sender_name AS senderName, organization_name AS organizationName,
    postal_address AS postalAddress, contact_method AS contactMethod,
    identity_valid_until AS identityValidUntil,
    unsubscribe_mechanism_validated_at AS unsubscribeMechanismValidatedAt,
    unsubscribe_mechanism_valid_until AS unsubscribeMechanismValidUntil,
    dncl_registration_confirmed AS dnclRegistrationConfirmed,
    dncl_registration_verified_at AS dnclRegistrationVerifiedAt,
    dncl_registration_evidence_ref AS dnclRegistrationEvidenceRef,
    business_number_confirmed AS businessNumberConfirmed,
    business_number AS businessNumber,
    business_number_evidence_ref AS businessNumberEvidenceRef,
    caller_identity AS callerIdentity, caller_display_number AS callerDisplayNumber,
    automated_dialer_disabled AS automatedDialerDisabled,
    prerecorded_calls_disabled AS prerecordedCallsDisabled,
    sequential_dialing_disabled AS sequentialDialingDisabled,
    cross_border_efvp_confirmed AS crossBorderEfvpConfirmed,
    cross_border_contract_confirmed AS crossBorderContractConfirmed,
    cross_border_legal_validation_confirmed AS crossBorderLegalValidationConfirmed,
    cross_border_evidence_ref AS crossBorderEvidenceRef,
    automated_qualification_legal_validation_confirmed AS automatedQualificationLegalValidationConfirmed,
    automated_qualification_evidence_ref AS automatedQualificationEvidenceRef
    FROM compliance_configuration WHERE id='default' LIMIT 1`).first<ComplianceConfiguration>();
  if (!row) throw new Error("compliance_configuration_missing");
  return row;
}

export async function loadContactCompliance(
  db: CrmDatabase,
  channel: "email" | "phone",
  address: string,
  suppressionCategory = "prospecting",
): Promise<ContactCompliance | null> {
  return db.prepare(`SELECT contact.id AS contactId, contact.organization_id AS organizationId,
    contact.compliance_version AS complianceVersion, contact.validated_at AS validatedAt,
    contact.deleted_at AS deletedAt, contact.do_not_contact AS doNotContact,
    contact.do_not_call AS doNotCall, contact.unsubscribed_at AS unsubscribedAt,
    contact.role_relevance AS roleRelevance,
    contact.role_relevance_detail AS roleRelevanceDetail,
    contact.personal_data_category AS personalDataCategory,
    contact.qualification_mode AS qualificationMode,
    organization.deleted_at AS organizationDeletedAt,
    organization.do_not_contact AS organizationDoNotContact,
    channel.id AS channelId, channel.channel, channel.address_normalized AS addressNormalized,
    channel.provenance_type AS provenanceType, channel.source_url AS sourceUrl,
    channel.captured_at AS capturedAt, channel.evidence_ref AS evidenceRef,
    channel.lawful_basis AS lawfulBasis, channel.basis_verified_by AS basisVerifiedBy,
    channel.basis_verified_at AS basisVerifiedAt, channel.basis_evidence_ref AS basisEvidenceRef,
    channel.basis_expires_at AS basisExpiresAt,
    channel.publication_by_recipient AS publicationByRecipient,
    channel.publication_no_restriction AS publicationNoRestriction,
    channel.publication_role_relevance AS publicationRoleRelevance,
    channel.direct_disclosure_no_restriction AS directDisclosureNoRestriction,
    channel.b2b_relationship_evidence AS b2bRelationshipEvidence,
    channel.b2b_message_relevance AS b2bMessageRelevance,
    channel.dncl_status AS dnclStatus, channel.dncl_checked_at AS dnclCheckedAt,
    channel.dncl_evidence_ref AS dnclEvidenceRef,
    channel.recipient_timezone AS recipientTimezone, channel.status,
    channel.validated_at AS channelValidatedAt,
    (SELECT COUNT(*) FROM contact_suppressions suppression
      WHERE suppression.channel=channel.channel
        AND suppression.address_normalized=channel.address_normalized
        AND (suppression.scope='global' OR (suppression.scope='category' AND suppression.category=?))) AS suppressionCount
    FROM contact_channel_compliance channel
    JOIN contacts contact ON contact.id=channel.contact_id
    LEFT JOIN organizations organization ON organization.id=contact.organization_id
    WHERE channel.channel=? AND channel.address_normalized=? LIMIT 1`)
    .bind(suppressionCategory, channel, address)
    .first<ContactCompliance>();
}

export async function advanceSendAuthorization(
  db: CrmDatabase,
  commandId: string,
  contact: ContactCompliance,
  configuration: ComplianceConfiguration,
  fromStatus: "pending" | "authorized",
  toStatus: "authorized" | "dispatching",
  decisionSnapshot: object,
  actorEmail: string,
  suppressionCategory = "prospecting",
  now = new Date(),
): Promise<boolean> {
  const timestamp = now.toISOString();
  const result = await db.prepare(`UPDATE send_commands
    SET status=?, contact_id=?, contact_compliance_version=?, configuration_version=?,
        authorized_at=COALESCE(authorized_at, ?),
        dispatched_at=CASE WHEN ?='dispatching' THEN ? ELSE dispatched_at END,
        operator_confirmed_at=COALESCE(operator_confirmed_at, ?),
        compliance_snapshot_json=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status=?
      AND EXISTS (SELECT 1 FROM contacts contact
        JOIN organizations organization ON organization.id=contact.organization_id
        WHERE contact.id=? AND contact.compliance_version=?
          AND contact.do_not_contact=0 AND contact.unsubscribed_at IS NULL AND contact.deleted_at IS NULL
          AND organization.do_not_contact=0 AND organization.deleted_at IS NULL)
      AND EXISTS (SELECT 1 FROM compliance_configuration WHERE id='default' AND version=?)
      AND NOT EXISTS (SELECT 1 FROM contact_suppressions
        WHERE channel=? AND address_normalized=?
          AND (scope='global' OR (scope='category' AND category=?)))`)
    .bind(
      toStatus, contact.contactId, contact.complianceVersion, configuration.version,
      timestamp, toStatus, timestamp, timestamp,
      JSON.stringify({ ...decisionSnapshot, actorEmail }), commandId, fromStatus,
      contact.contactId, contact.complianceVersion, configuration.version,
      contact.channel, contact.addressNormalized, suppressionCategory,
    ).run();
  return (result.meta?.changes ?? 0) === 1;
}

export function complianceEvidenceSnapshot(
  contact: ContactCompliance,
  configuration: ComplianceConfiguration,
) {
  // The configuration only exposes a boolean indicating secret availability;
  // no secret value is loaded into this object or written to the audit log.
  return { contact: { ...contact }, configuration: { ...configuration } };
}

function commonReasons(contact: ContactCompliance, configuration: ComplianceConfiguration, now: Date): string[] {
  const reasons: string[] = [];
  if (contact.deletedAt || contact.organizationDeletedAt) reasons.push("contact_deleted");
  if (Boolean(contact.doNotContact) || Boolean(contact.organizationDoNotContact)) reasons.push("contact_suppressed");
  if (!validPastOrPresent(contact.validatedAt, now) || !validPastOrPresent(contact.channelValidatedAt, now)) reasons.push("contact_unvalidated");
  if (contact.personalDataCategory !== "work_contact") reasons.push("non_work_personal_data_blocked");
  if (contact.roleRelevance !== "relevant" || !contact.roleRelevanceDetail.trim()) reasons.push("role_relevance_unproven");
  if (contact.qualificationMode === "fully_automated" && (!Boolean(configuration.automatedQualificationLegalValidationConfirmed) || !configuration.automatedQualificationEvidenceRef.trim())) reasons.push("automated_qualification_unapproved");
  return reasons;
}

function decision(
  reasons: string[],
  contact: ContactCompliance,
  configuration: ComplianceConfiguration,
  now: Date,
): ComplianceDecision {
  return {
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    evaluatedAt: now.toISOString(),
    contactVersion: contact.complianceVersion,
    configurationVersion: configuration.version,
  };
}

function validDate(value: string | null | undefined): value is string {
  return Boolean(value) && Number.isFinite(new Date(value!).valueOf());
}

function validPastOrPresent(value: string | null | undefined, now: Date): value is string {
  return validDate(value) && new Date(value).valueOf() <= now.valueOf();
}
