import assert from "node:assert/strict";
import test from "node:test";

import { boundedRequest } from "../lib/bounded-request.ts";
import { canCall, canEmail, isAllowedCallingTime } from "../lib/compliance.ts";
import { appendComplianceFooter, createUnsubscribeToken, validUnsubscribeSecret, verifyUnsubscribeToken } from "../lib/unsubscribe.ts";

const NOW = new Date("2026-08-31T14:00:00.000Z");

test("bounded public request reader rejects declared and streamed overflow", async () => {
  assert.equal(await boundedRequest(new Request("https://crm.example/public", { method: "POST", headers: { "content-length": "20" }, body: "small" }), 10), null);
  assert.equal(await boundedRequest(new Request("https://crm.example/public", { method: "POST", body: "01234567890" }), 10), null);
  const accepted = await boundedRequest(new Request("https://crm.example/public", { method: "POST", body: "0123456789" }), 10);
  assert.equal(await accepted?.text(), "0123456789");
});

test("email policy allows only a fully evidenced single-recipient basis", () => {
  assert.deepEqual(canEmail(emailContact(), configuration(), NOW).reasons, []);

  const cases = [
    ["missing lawful basis", { lawfulBasis: "none", basisEvidenceRef: null }, "email_lawful_basis_missing"],
    ["missing proof", { basisEvidenceRef: null }, "email_basis_proof_incomplete"],
    ["expired basis", { basisExpiresAt: "2026-08-30T00:00:00.000Z" }, "email_basis_expired"],
    ["future provenance", { capturedAt: "2026-09-01T00:00:00.000Z" }, "email_provenance_incomplete"],
    ["future verification", { basisVerifiedAt: "2026-09-01T00:00:00.000Z" }, "email_basis_proof_incomplete"],
    ["suppression", { suppressionCount: 1 }, "email_suppressed"],
    ["non-work data", { personalDataCategory: "other_personal" }, "non_work_personal_data_blocked"],
    ["automated qualification", { qualificationMode: "fully_automated" }, "automated_qualification_unapproved"],
  ];
  for (const [label, patch, reason] of cases) {
    assert.ok(canEmail(emailContact(patch), configuration(), NOW).reasons.includes(reason), label);
  }
});

test("publication and B2B bases fail closed without their specific proof", () => {
  const publication = emailContact({
    lawfulBasis: "conspicuous_publication",
    provenanceType: "recipient_published",
    publicationByRecipient: true,
    publicationNoRestriction: false,
    publicationRoleRelevance: "",
  });
  assert.ok(canEmail(publication, configuration(), NOW).reasons.includes("publication_restricts_contact"));
  assert.ok(canEmail(publication, configuration(), NOW).reasons.includes("publication_role_relevance_missing"));

  const thirdParty = emailContact({
    lawfulBasis: "conspicuous_publication",
    provenanceType: "third_party",
    publicationByRecipient: false,
    publicationNoRestriction: true,
    publicationRoleRelevance: "Direction numérique",
  });
  assert.ok(canEmail(thirdParty, configuration(), NOW).reasons.includes("publication_not_by_recipient_or_authorized"));

  const b2b = emailContact({ lawfulBasis: "b2b_exemption", b2bRelationshipEvidence: "", b2bMessageRelevance: "" });
  assert.ok(canEmail(b2b, configuration(), NOW).reasons.includes("b2b_relationship_unproven"));
  assert.ok(canEmail(b2b, configuration(), NOW).reasons.includes("b2b_message_relevance_missing"));
});

test("sender identity, exclusion mechanism and cross-border controls default to blocked", () => {
  const invalid = configuration({
    senderName: "",
    unsubscribeMechanismValidUntil: null,
    crossBorderEfvpConfirmed: false,
    crossBorderContractConfirmed: false,
    crossBorderLegalValidationConfirmed: false,
    crossBorderEvidenceRef: "",
  });
  const reasons = canEmail(emailContact(), invalid, NOW).reasons;
  assert.ok(reasons.includes("sender_identity_incomplete"));
  assert.ok(reasons.includes("unsubscribe_mechanism_incomplete"));
  assert.ok(reasons.includes("cross_border_efvp_unconfirmed"));
  assert.ok(reasons.includes("cross_border_contract_unconfirmed"));
  assert.ok(reasons.includes("cross_border_legal_validation_unconfirmed"));
  assert.ok(reasons.includes("cross_border_evidence_missing"));
});

test("call policy enforces internal/DNCL evidence, registration, caller identity and local hours", () => {
  assert.deepEqual(canCall(phoneContact(), configuration(), NOW).reasons, []);
  assert.ok(canCall(phoneContact({ doNotCall: true }), configuration(), NOW).reasons.includes("phone_do_not_call"));
  assert.ok(canCall(phoneContact({ dnclStatus: "listed" }), configuration(), NOW).reasons.includes("phone_dncl_listed"));
  assert.ok(canCall(phoneContact({ dnclCheckedAt: "2026-07-01T00:00:00.000Z" }), configuration(), NOW).reasons.includes("phone_dncl_check_expired"));
  assert.ok(canCall(phoneContact(), configuration({ dnclRegistrationConfirmed: false }), NOW).reasons.includes("organization_dncl_registration_unconfirmed"));
  assert.ok(canCall(phoneContact(), configuration({ businessNumberConfirmed: false }), NOW).reasons.includes("business_number_unconfirmed"));
  assert.ok(canCall(phoneContact(), configuration({ callerDisplayNumber: "" }), NOW).reasons.includes("caller_identity_incomplete"));
  assert.ok(canCall(phoneContact(), configuration({ automatedDialerDisabled: false }), NOW).reasons.includes("prohibited_call_automation_enabled"));
  assert.ok(canCall(phoneContact(), configuration(), new Date("2026-08-31T11:00:00.000Z")).reasons.includes("outside_calling_hours"));
});

test("calling-hour boundaries use the recipient timezone", () => {
  assert.equal(isAllowedCallingTime(new Date("2026-08-31T13:00:00.000Z"), "America/Toronto"), true); // lundi 09:00
  assert.equal(isAllowedCallingTime(new Date("2026-09-01T01:29:00.000Z"), "America/Toronto"), true); // lundi 21:29
  assert.equal(isAllowedCallingTime(new Date("2026-09-01T01:30:00.000Z"), "America/Toronto"), false);
  assert.equal(isAllowedCallingTime(new Date("2026-08-30T14:00:00.000Z"), "America/Toronto"), true); // dimanche 10:00
  assert.equal(isAllowedCallingTime(new Date("2026-08-30T22:00:00.000Z"), "America/Toronto"), false);
  assert.equal(isAllowedCallingTime(NOW, "Fuseau/Invalide"), false);
});

test("unsubscribe tokens are opaque, authenticated and the server footer contains every required element", async () => {
  const secret = "test-secret-not-for-production-32-bytes";
  const payload = { contactId: "contact-1", email: "person@example.com", expiresAt: "2026-10-30T00:00:00.000Z" };
  const token = await createUnsubscribeToken(secret, payload);
  assert.equal(token.includes("person@example.com"), false);
  assert.equal(validUnsubscribeSecret("weak"), false);
  assert.equal(validUnsubscribeSecret(secret), true);
  await assert.rejects(() => createUnsubscribeToken("weak", payload), /unsubscribe_secret_invalid/u);
  assert.deepEqual(await verifyUnsubscribeToken(secret, token, NOW), payload);
  const replacement = token.endsWith("x") ? "y" : "x";
  assert.equal(await verifyUnsubscribeToken(secret, `${token.slice(0, -1)}${replacement}`, NOW), null);
  assert.equal(await verifyUnsubscribeToken("wrong-secret", token, NOW), null);
  assert.equal(await verifyUnsubscribeToken(secret, token, new Date("2026-11-01T00:00:00.000Z")), null);
  const invalidDateToken = await createUnsubscribeToken(secret, { ...payload, expiresAt: "not-a-date" });
  assert.equal(await verifyUnsubscribeToken(secret, invalidDateToken, NOW), null);

  const content = appendComplianceFooter("Bonjour", null, configuration(), `https://crm.example/unsubscribe?token=${token}`);
  for (const expected of ["Alice Conseillère", "27PM", "123 rue Exemple", "514 555-0100", "Se désabonner"]) {
    assert.match(content.text, new RegExp(expected));
  }
});

function emailContact(patch = {}) {
  return contact({ channel: "email", addressNormalized: "person@example.com", dnclStatus: "not_applicable", ...patch });
}

function phoneContact(patch = {}) {
  return contact({
    channel: "phone",
    addressNormalized: "+15145550123",
    lawfulBasis: "none",
    basisVerifiedBy: null,
    basisVerifiedAt: null,
    basisEvidenceRef: null,
    dnclStatus: "not_listed",
    dnclCheckedAt: "2026-08-20T14:00:00.000Z",
    dnclEvidenceRef: "preuve:lnnte:test",
    recipientTimezone: "America/Toronto",
    ...patch,
  });
}

function contact(patch = {}) {
  return {
    contactId: "contact-1", organizationId: "org-1", complianceVersion: 4,
    validatedAt: "2026-08-20T14:00:00.000Z", deletedAt: null, organizationDeletedAt: null,
    doNotContact: false, organizationDoNotContact: false, doNotCall: false, unsubscribedAt: null,
    roleRelevance: "relevant", roleRelevanceDetail: "Responsable des services numériques concernés.",
    personalDataCategory: "work_contact", qualificationMode: "manual",
    channelId: "channel-1", channel: "email", addressNormalized: "person@example.com",
    provenanceType: "first_party_inbound", sourceUrl: "https://example.com/source",
    capturedAt: "2026-08-20", evidenceRef: "preuve:source:test",
    lawfulBasis: "explicit_consent", basisVerifiedBy: "operator@27pm.org",
    basisVerifiedAt: "2026-08-20T14:00:00.000Z", basisEvidenceRef: "preuve:consentement:test",
    basisExpiresAt: null, publicationByRecipient: false, publicationNoRestriction: false,
    publicationRoleRelevance: "", directDisclosureNoRestriction: false,
    b2bRelationshipEvidence: "", b2bMessageRelevance: "", dnclStatus: "not_applicable",
    dnclCheckedAt: null, dnclEvidenceRef: null, recipientTimezone: null,
    status: "valid", channelValidatedAt: "2026-08-20T14:00:00.000Z", suppressionCount: 0,
    ...patch,
  };
}

function configuration(patch = {}) {
  return {
    version: 3,
    senderName: "Alice Conseillère", organizationName: "27PM", postalAddress: "123 rue Exemple",
    contactMethod: "514 555-0100", identityValidUntil: "2027-12-31T00:00:00.000Z",
    unsubscribeMechanismValidatedAt: "2026-08-20T00:00:00.000Z",
    unsubscribeMechanismValidUntil: "2027-12-31T00:00:00.000Z", unsubscribeSigningKeyConfigured: true,
    dnclRegistrationConfirmed: true, dnclRegistrationVerifiedAt: "2026-08-20T00:00:00.000Z",
    dnclRegistrationEvidenceRef: "preuve:inscription:lnnte", businessNumberConfirmed: true,
    businessNumber: "123456789", businessNumberEvidenceRef: "preuve:numero:entreprise",
    callerIdentity: "Alice 27PM", callerDisplayNumber: "+15145550100",
    automatedDialerDisabled: true, prerecordedCallsDisabled: true, sequentialDialingDisabled: true,
    crossBorderEfvpConfirmed: true, crossBorderContractConfirmed: true,
    crossBorderLegalValidationConfirmed: true, crossBorderEvidenceRef: "preuve:efvp:test",
    automatedQualificationLegalValidationConfirmed: false, automatedQualificationEvidenceRef: "",
    ...patch,
  };
}
