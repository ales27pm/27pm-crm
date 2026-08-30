import { requireOperatorRequest } from "@/lib/api-auth";
import { loadComplianceConfiguration } from "@/lib/compliance";
import { crmDatabase } from "@/lib/d1";
import { jsonError, optionalTrimmedString, readJsonObject, validIsoTimestamp } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  try {
    return Response.json({ configuration: await loadComplianceConfiguration(crmDatabase()) }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return jsonError(500, "compliance_configuration_unavailable");
  }
}

export async function PATCH(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const parsed = parseConfiguration(payload);
  if (!parsed) return jsonError(400, "compliance_configuration_invalid");
  try {
    const db = crmDatabase();
    await db.batch([
      db.prepare(`UPDATE compliance_configuration SET
        version=version+1, sender_name=?, organization_name=?, postal_address=?, contact_method=?,
        identity_valid_until=?, unsubscribe_mechanism_validated_at=?, unsubscribe_mechanism_valid_until=?,
        dncl_registration_confirmed=?, dncl_registration_verified_at=?, dncl_registration_evidence_ref=?,
        business_number_confirmed=?, business_number=?, business_number_evidence_ref=?,
        caller_identity=?, caller_display_number=?, automated_dialer_disabled=?,
        prerecorded_calls_disabled=?, sequential_dialing_disabled=?,
        cross_border_efvp_confirmed=?, cross_border_contract_confirmed=?,
        cross_border_legal_validation_confirmed=?, cross_border_evidence_ref=?,
        automated_qualification_legal_validation_confirmed=?, automated_qualification_evidence_ref=?,
        updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id='default'`)
        .bind(
          parsed.senderName, parsed.organizationName, parsed.postalAddress, parsed.contactMethod,
          parsed.identityValidUntil, parsed.unsubscribeMechanismValidatedAt, parsed.unsubscribeMechanismValidUntil,
          parsed.dnclRegistrationConfirmed ? 1 : 0, parsed.dnclRegistrationVerifiedAt, parsed.dnclRegistrationEvidenceRef,
          parsed.businessNumberConfirmed ? 1 : 0, parsed.businessNumber, parsed.businessNumberEvidenceRef,
          parsed.callerIdentity, parsed.callerDisplayNumber, parsed.automatedDialerDisabled ? 1 : 0,
          parsed.prerecordedCallsDisabled ? 1 : 0, parsed.sequentialDialingDisabled ? 1 : 0,
          parsed.crossBorderEfvpConfirmed ? 1 : 0, parsed.crossBorderContractConfirmed ? 1 : 0,
          parsed.crossBorderLegalValidationConfirmed ? 1 : 0, parsed.crossBorderEvidenceRef,
          parsed.automatedQualificationLegalValidationConfirmed ? 1 : 0, parsed.automatedQualificationEvidenceRef,
          auth.operator.email,
        ),
      db.prepare(`INSERT INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json)
        VALUES (?, ?, 'compliance.configuration.updated', 'compliance_configuration', 'default', ?)`)
        .bind(crypto.randomUUID(), auth.operator.email, JSON.stringify({ configurationSnapshot: parsed })),
    ]);
    return Response.json({ configuration: await loadComplianceConfiguration(db) }, { headers: { "cache-control": "private, no-store" } });
  } catch {
    return jsonError(500, "compliance_configuration_update_failed");
  }
}

function parseConfiguration(payload: Record<string, unknown>) {
  const string = (name: string, maximum = 2_000) => optionalTrimmedString(payload[name], maximum);
  const timestamp = (name: string) => validIsoTimestamp(payload[name]);
  const senderName = string("senderName", 200);
  const organizationName = string("organizationName", 200);
  const postalAddress = string("postalAddress", 500);
  const contactMethod = string("contactMethod", 500);
  const identityValidUntil = timestamp("identityValidUntil");
  const unsubscribeMechanismValidatedAt = timestamp("unsubscribeMechanismValidatedAt");
  const unsubscribeMechanismValidUntil = timestamp("unsubscribeMechanismValidUntil");
  const dnclRegistrationVerifiedAt = timestamp("dnclRegistrationVerifiedAt");
  const dnclRegistrationEvidenceRef = string("dnclRegistrationEvidenceRef");
  const businessNumber = string("businessNumber", 100);
  const businessNumberEvidenceRef = string("businessNumberEvidenceRef");
  const callerIdentity = string("callerIdentity", 200);
  const callerDisplayNumber = string("callerDisplayNumber", 100);
  const crossBorderEvidenceRef = string("crossBorderEvidenceRef");
  const automatedQualificationEvidenceRef = string("automatedQualificationEvidenceRef");
  const requiredBooleanNames = [
    "dnclRegistrationConfirmed", "businessNumberConfirmed", "automatedDialerDisabled",
    "prerecordedCallsDisabled", "sequentialDialingDisabled", "crossBorderEfvpConfirmed",
    "crossBorderContractConfirmed", "crossBorderLegalValidationConfirmed",
    "automatedQualificationLegalValidationConfirmed",
  ] as const;
  if (requiredBooleanNames.some((name) => typeof payload[name] !== "boolean")) return null;
  if ([identityValidUntil, unsubscribeMechanismValidatedAt, unsubscribeMechanismValidUntil, dnclRegistrationVerifiedAt].includes(undefined)) return null;
  if ([senderName, organizationName, postalAddress, contactMethod, dnclRegistrationEvidenceRef, businessNumber, businessNumberEvidenceRef, callerIdentity, callerDisplayNumber, crossBorderEvidenceRef, automatedQualificationEvidenceRef].includes(undefined)) return null;
  if (payload.dnclRegistrationConfirmed === true && (!dnclRegistrationVerifiedAt || !dnclRegistrationEvidenceRef)) return null;
  if (payload.businessNumberConfirmed === true && (!businessNumber || !businessNumberEvidenceRef)) return null;
  if ((payload.crossBorderEfvpConfirmed === true || payload.crossBorderContractConfirmed === true || payload.crossBorderLegalValidationConfirmed === true) && !crossBorderEvidenceRef) return null;
  if (payload.automatedQualificationLegalValidationConfirmed === true && !automatedQualificationEvidenceRef) return null;
  return {
    senderName: senderName ?? "", organizationName: organizationName ?? "", postalAddress: postalAddress ?? "", contactMethod: contactMethod ?? "",
    identityValidUntil: identityValidUntil ?? null,
    unsubscribeMechanismValidatedAt: unsubscribeMechanismValidatedAt ?? null,
    unsubscribeMechanismValidUntil: unsubscribeMechanismValidUntil ?? null,
    dnclRegistrationConfirmed: payload.dnclRegistrationConfirmed === true,
    dnclRegistrationVerifiedAt: dnclRegistrationVerifiedAt ?? null,
    dnclRegistrationEvidenceRef: dnclRegistrationEvidenceRef ?? "",
    businessNumberConfirmed: payload.businessNumberConfirmed === true,
    businessNumber: businessNumber ?? "", businessNumberEvidenceRef: businessNumberEvidenceRef ?? "",
    callerIdentity: callerIdentity ?? "", callerDisplayNumber: callerDisplayNumber ?? "",
    automatedDialerDisabled: payload.automatedDialerDisabled === true,
    prerecordedCallsDisabled: payload.prerecordedCallsDisabled === true,
    sequentialDialingDisabled: payload.sequentialDialingDisabled === true,
    crossBorderEfvpConfirmed: payload.crossBorderEfvpConfirmed === true,
    crossBorderContractConfirmed: payload.crossBorderContractConfirmed === true,
    crossBorderLegalValidationConfirmed: payload.crossBorderLegalValidationConfirmed === true,
    crossBorderEvidenceRef: crossBorderEvidenceRef ?? "",
    automatedQualificationLegalValidationConfirmed: payload.automatedQualificationLegalValidationConfirmed === true,
    automatedQualificationEvidenceRef: automatedQualificationEvidenceRef ?? "",
  };
}
