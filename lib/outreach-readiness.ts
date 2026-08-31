import {
  canCall,
  canEmail,
  complianceEvidenceSnapshot,
  loadComplianceConfiguration,
  loadContactCompliance,
  type ComplianceDecision,
} from "./compliance";
import type { CrmDatabase } from "./d1";
import { runtimeString } from "./runtime";
import { validUnsubscribeSecret } from "./unsubscribe";

export type OutreachChannelReadiness = {
  allowed: boolean;
  channel: "email" | "phone";
  reasons: string[];
  contactId: string | null;
  contactVersion: number | null;
  configurationVersion: number | null;
  address: string | null;
  decision: ComplianceDecision | null;
  evidenceSnapshot: ReturnType<typeof complianceEvidenceSnapshot> | null;
};

export async function evaluateOutreachChannel(
  db: CrmDatabase,
  contactId: string | null,
  channel: "email" | "phone",
  now = new Date(),
): Promise<OutreachChannelReadiness> {
  if (!contactId) return blocked(channel, "strategy_contact_missing");
  const identity = await db
    .prepare("SELECT id, email, phone FROM contacts WHERE id=? AND deleted_at IS NULL LIMIT 1")
    .bind(contactId)
    .first<{ id: string; email: string | null; phone: string | null }>();
  if (!identity) return blocked(channel, "strategy_contact_missing");
  const address = channel === "email" ? identity.email : identity.phone;
  if (!address) return blocked(channel, `${channel}_address_missing`);
  const contact = await loadContactCompliance(db, channel, address);
  if (!contact || contact.contactId !== contactId) {
    return blocked(channel, "contact_compliance_missing");
  }
  const configuration = await loadComplianceConfiguration(db);
  configuration.unsubscribeSigningKeyConfigured = validUnsubscribeSecret(
    runtimeString("CRM_UNSUBSCRIBE_SIGNING_KEY"),
  );
  const decision = channel === "email"
    ? canEmail(contact, configuration, now)
    : canCall(contact, configuration, now);
  return {
    allowed: decision.allowed,
    channel,
    reasons: decision.reasons,
    contactId,
    contactVersion: contact.complianceVersion,
    configurationVersion: configuration.version,
    address: contact.addressNormalized,
    decision,
    evidenceSnapshot: complianceEvidenceSnapshot(contact, configuration),
  };
}

function blocked(
  channel: "email" | "phone",
  reason: string,
): OutreachChannelReadiness {
  return {
    allowed: false,
    channel,
    reasons: [reason],
    contactId: null,
    contactVersion: null,
    configurationVersion: null,
    address: null,
    decision: null,
    evidenceSnapshot: null,
  };
}
