import type { ContactCompliance } from "./compliance";
import { normalizeEmailAddress } from "./mailboxes";
import type { OutboundTransportConfig } from "./outbound-runtime";

export type CakemailAudiencePolicyViolation =
  | "cakemail_audience_lawful_basis_not_permitted"
  | "cakemail_audience_role_mailbox_not_permitted";

const PERMISSION_OR_RELATIONSHIP_BASES = new Set([
  "explicit_consent",
  "existing_business_relationship",
  "requested_response",
]);

const GENERIC_ROLE_LOCAL_PARTS = new Set([
  "abuse",
  "accounting",
  "accounts",
  "accueil",
  "admin",
  "administration",
  "billing",
  "bonjour",
  "careers",
  "communications",
  "comptabilite",
  "confidentialite",
  "contact",
  "customerservice",
  "direction",
  "emplois",
  "enquiries",
  "enquiry",
  "facturation",
  "general",
  "hello",
  "help",
  "hr",
  "info",
  "inquiries",
  "inquiry",
  "jobs",
  "legal",
  "marketing",
  "noreply",
  "office",
  "operations",
  "postmaster",
  "privacy",
  "reception",
  "rh",
  "sales",
  "securite",
  "security",
  "service",
  "serviceclient",
  "support",
  "supportteam",
  "team",
  "ventes",
  "webmaster",
]);

type AudienceContact = Pick<
  ContactCompliance,
  "lawfulBasis" | "addressNormalized"
>;

/**
 * Returns a stable operator-facing error before Cakemail dispatch. Mailgun is
 * deliberately outside this provider-specific policy and remains unchanged.
 */
export function cakemailAudiencePolicyViolation(
  transport: OutboundTransportConfig,
  contact: AudienceContact,
): CakemailAudiencePolicyViolation | null {
  if (transport.provider !== "cakemail") return null;
  if (transport.config.audiencePolicy.mode === "written_exception") {
    return null;
  }
  if (!PERMISSION_OR_RELATIONSHIP_BASES.has(contact.lawfulBasis)) {
    return "cakemail_audience_lawful_basis_not_permitted";
  }
  if (isGenericRoleMailboxAddress(contact.addressNormalized)) {
    return "cakemail_audience_role_mailbox_not_permitted";
  }
  return null;
}

export function isGenericRoleMailboxAddress(address: string): boolean {
  const normalized = normalizeEmailAddress(address);
  if (!normalized) return true;
  const localPart = normalized.slice(0, normalized.lastIndexOf("@"));
  const untagged = localPart.split("+", 1)[0] ?? localPart;
  const roleKey = untagged.replace(/[._-]/gu, "");
  return GENERIC_ROLE_LOCAL_PARTS.has(roleKey);
}
