import "server-only";

import { requireRuntimeString, runtimeString } from "./runtime";

const CAKEMAIL_API_BASE = "https://api.cakemail.dev" as const;
const PERSONAL_ACCESS_TOKEN = /^ck_pat_[a-f0-9]{40}$/u;
const POSITIVE_DECIMAL_INTEGER = /^[1-9][0-9]*$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;
const MAX_SENDER_ID_LENGTH = 128;
const MAX_ACTIVATION_BINDING_LENGTH = 4_096;
const APPROVAL_REFERENCE = /^[a-zA-Z0-9][a-zA-Z0-9._:/#@-]{0,255}$/u;
const SHA256_DIGEST = /^[a-f0-9]{64}$/u;

export type CakemailContentMode = "html" | "text";
export type CakemailAudiencePolicy =
  | { readonly mode: "permission_relationship" }
  | {
      readonly mode: "written_exception";
      readonly approvalReference: string;
      readonly approvalSha256: string;
    };

export interface CakemailRuntimeConfig {
  readonly apiBase: typeof CAKEMAIL_API_BASE;
  readonly pat: string;
  readonly accountId: number;
  readonly listId: number;
  readonly contentMode: CakemailContentMode;
  readonly senderIds: Readonly<Record<string, string>>;
  readonly audiencePolicy: CakemailAudiencePolicy;
}

type CakemailActivationBinding = Pick<
  CakemailRuntimeConfig,
  "accountId" | "listId" | "contentMode" | "senderIds" | "audiencePolicy"
>;

function positiveInteger(name: string): number {
  const raw = requireRuntimeString(name);
  if (!POSITIVE_DECIMAL_INTEGER.test(raw)) {
    throw new Error(`${name} is invalid.`);
  }

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function senderId(name: string, required: true): string;
function senderId(name: string, required: false): string | null;
function senderId(name: string, required: boolean): string | null {
  const value = required ? requireRuntimeString(name) : runtimeString(name);
  if (value === null) return null;
  if (
    value.length > MAX_SENDER_ID_LENGTH ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${name} is invalid.`);
  }
  return value;
}

function contentMode(): CakemailContentMode {
  const value = requireRuntimeString("CAKEMAIL_CONTENT_MODE");
  if (value !== "html" && value !== "text") {
    throw new Error("CAKEMAIL_CONTENT_MODE is invalid.");
  }
  return value;
}

function requireEnabledGate(name: string): void {
  if (requireRuntimeString(name) !== "true") {
    throw new Error(`${name} is invalid.`);
  }
}

function audiencePolicy(): CakemailAudiencePolicy {
  const mode = requireRuntimeString("CAKEMAIL_AUDIENCE_MODE");
  if (mode === "permission_relationship") {
    const prospectingApproval = runtimeString(
      "CAKEMAIL_PROSPECTING_APPROVED",
    );
    if (
      (prospectingApproval !== null && prospectingApproval !== "false") ||
      runtimeString("CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE") !== null ||
      runtimeString("CAKEMAIL_PROSPECTING_APPROVAL_SHA256") !== null
    ) {
      throw new Error("Cakemail audience policy is invalid.");
    }
    return { mode };
  }
  if (mode !== "written_exception") {
    throw new Error("CAKEMAIL_AUDIENCE_MODE is invalid.");
  }

  requireEnabledGate("CAKEMAIL_PROSPECTING_APPROVED");
  const approvalReference = runtimeString(
    "CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE",
  );
  if (!approvalReference || !APPROVAL_REFERENCE.test(approvalReference)) {
    throw new Error(
      "CAKEMAIL_PROSPECTING_APPROVAL_REFERENCE is invalid.",
    );
  }
  const approvalSha256 = runtimeString(
    "CAKEMAIL_PROSPECTING_APPROVAL_SHA256",
  );
  if (!approvalSha256 || !SHA256_DIGEST.test(approvalSha256)) {
    throw new Error("CAKEMAIL_PROSPECTING_APPROVAL_SHA256 is invalid.");
  }
  return { mode, approvalReference, approvalSha256 };
}

export function cakemailConfig(): CakemailRuntimeConfig {
  const pat = requireRuntimeString("CAKEMAIL_PAT");
  if (!PERSONAL_ACCESS_TOKEN.test(pat)) {
    throw new Error("CAKEMAIL_PAT is invalid.");
  }

  const accountId = positiveInteger("CAKEMAIL_ACCOUNT_ID");
  const listId = positiveInteger("CAKEMAIL_LIST_ID");
  const mode = contentMode();
  const bonjour = senderId("CAKEMAIL_SENDER_ID_BONJOUR", true);
  const alexis = senderId("CAKEMAIL_SENDER_ID_ALEXIS", true);
  const admin = senderId("CAKEMAIL_SENDER_ID_ADMIN", false);
  const policy = audiencePolicy();

  requireEnabledGate("CAKEMAIL_LIST_POLICY_ACCEPTED");
  requireEnabledGate("CAKEMAIL_TRACKING_DOMAIN_READY");
  requireEnabledGate("CAKEMAIL_HEADER_PRESERVATION_CONFIRMED");
  requireEnabledGate("CAKEMAIL_DKIM_ALIGNMENT_CONFIRMED");

  const config: CakemailRuntimeConfig = {
    apiBase: CAKEMAIL_API_BASE,
    pat,
    accountId,
    listId,
    contentMode: mode,
    senderIds: {
      "bonjour@27pm.org": bonjour,
      "alexis@27pm.org": alexis,
      ...(admin ? { "admin@27pm.org": admin } : {}),
    },
    audiencePolicy: policy,
  };
  requireDistinctSenderIds(config.senderIds);
  requireActivationBinding(config);
  return config;
}

function requireDistinctSenderIds(
  senderIds: Readonly<Record<string, string>>,
): void {
  const identities = Object.values(senderIds);
  if (new Set(identities).size !== identities.length) {
    throw new Error("Cakemail sender IDs must be unique.");
  }
}

function requireActivationBinding(config: CakemailActivationBinding): void {
  const serialized = requireRuntimeString(
    "CAKEMAIL_ACTIVATION_BINDING_JSON",
  );
  if (serialized.length > MAX_ACTIVATION_BINDING_LENGTH) {
    throw activationBindingError();
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw activationBindingError();
  }
  if (!isRecord(value) || !isRecord(value.senderIds)) {
    throw activationBindingError();
  }
  if (
    !exactKeys(value, [
      "version",
      "accountId",
      "listId",
      "contentMode",
      "senderIds",
      "audiencePolicy",
    ]) ||
    value.version !== 2 ||
    value.accountId !== config.accountId ||
    value.listId !== config.listId ||
    value.contentMode !== config.contentMode ||
    !sameSenderIds(value.senderIds, config.senderIds) ||
    !sameAudiencePolicy(value.audiencePolicy, config.audiencePolicy)
  ) {
    throw activationBindingError();
  }
}

function sameAudiencePolicy(
  candidate: unknown,
  expected: CakemailAudiencePolicy,
): boolean {
  if (!isRecord(candidate) || candidate.mode !== expected.mode) return false;
  if (expected.mode === "permission_relationship") {
    return exactKeys(candidate, ["mode"]);
  }
  return (
    exactKeys(candidate, ["mode", "approvalReference", "approvalSha256"]) &&
    candidate.approvalReference === expected.approvalReference &&
    candidate.approvalSha256 === expected.approvalSha256
  );
}

function sameSenderIds(
  candidate: Record<string, unknown>,
  expected: Readonly<Record<string, string>>,
): boolean {
  const expectedKeys = Object.keys(expected).sort();
  if (!exactKeys(candidate, expectedKeys)) return false;
  return expectedKeys.every((key) => candidate[key] === expected[key]);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  return (
    Object.keys(value).sort().join("\u0000") ===
    [...expected].sort().join("\u0000")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function activationBindingError(): Error {
  return new Error("CAKEMAIL_ACTIVATION_BINDING_JSON is invalid.");
}
