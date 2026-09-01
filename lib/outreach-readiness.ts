import {
  canCall,
  canEmail,
  complianceEvidenceSnapshot,
  loadComplianceConfiguration,
  loadContactCompliance,
  type ComplianceConfiguration,
  type ComplianceDecision,
  type ContactCompliance,
} from "./compliance";
import type { CrmDatabase } from "./d1";
import { OUTREACH_CONTACT_COMPLIANCE_SQL } from "./outreach-readiness-sql";
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
  const configuration = await configuredCompliance(db);
  return evaluateWithConfiguration(db, contactId, channel, configuration, now);
}

export async function evaluateOutreachChannels(
  db: CrmDatabase,
  contactIds: readonly string[],
  channel: "email" | "phone",
  now = new Date(),
): Promise<Map<string, OutreachChannelReadiness>> {
  const uniqueContactIds = [...new Set(contactIds.filter(Boolean))];
  if (uniqueContactIds.length === 0) return new Map();
  const [configuration, identities, complianceRows] = await Promise.all([
    configuredCompliance(db),
    db.prepare("SELECT id, email, phone FROM contacts WHERE deleted_at IS NULL")
      .all<{ id: string; email: string | null; phone: string | null }>(),
    loadAllContactCompliance(db, channel),
  ]);
  const identitiesById = new Map(identities.results.map((identity) => [identity.id, identity]));
  const complianceByContactId = new Map(complianceRows.map((contact) => [contact.contactId, contact]));
  return new Map(uniqueContactIds.map((contactId) => {
    const identity = identitiesById.get(contactId);
    if (!identity) return [contactId, blocked(channel, "strategy_contact_missing")];
    const address = channel === "email" ? identity.email : identity.phone;
    if (!address) return [contactId, blocked(channel, `${channel}_address_missing`)];
    const contact = complianceByContactId.get(contactId);
    if (!contact || contact.addressNormalized !== address) {
      return [contactId, blocked(channel, "contact_compliance_missing")];
    }
    return [contactId, readinessFromCompliance(contact, channel, configuration, now)];
  }));
}

async function evaluateWithConfiguration(
  db: CrmDatabase,
  contactId: string,
  channel: "email" | "phone",
  configuration: ComplianceConfiguration,
  now: Date,
): Promise<OutreachChannelReadiness> {
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
  return readinessFromCompliance(contact, channel, configuration, now);
}

function readinessFromCompliance(
  contact: ContactCompliance,
  channel: "email" | "phone",
  configuration: ComplianceConfiguration,
  now: Date,
): OutreachChannelReadiness {
  const decision = channel === "email"
    ? canEmail(contact, configuration, now)
    : canCall(contact, configuration, now);
  return {
    allowed: decision.allowed,
    channel,
    reasons: decision.reasons,
    contactId: contact.contactId,
    contactVersion: contact.complianceVersion,
    configurationVersion: configuration.version,
    address: contact.addressNormalized,
    decision,
    evidenceSnapshot: complianceEvidenceSnapshot(contact, configuration),
  };
}

async function configuredCompliance(db: CrmDatabase): Promise<ComplianceConfiguration> {
  const configuration = await loadComplianceConfiguration(db);
  configuration.unsubscribeSigningKeyConfigured = validUnsubscribeSecret(
    runtimeString("CRM_UNSUBSCRIBE_SIGNING_KEY"),
  );
  return configuration;
}

async function loadAllContactCompliance(
  db: CrmDatabase,
  channel: "email" | "phone",
): Promise<ContactCompliance[]> {
  const rows = await db.prepare(OUTREACH_CONTACT_COMPLIANCE_SQL)
    .bind(channel)
    .all<ContactCompliance>();
  return rows.results;
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
