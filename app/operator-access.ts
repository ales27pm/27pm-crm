import "server-only";

import { normalizeEmailAddress } from "@/lib/mailboxes";
import { parseOperatorAllowlist } from "@/lib/auth";
import { runtimeString } from "@/lib/runtime";

export function isCrmOperator(email: string): boolean {
  const normalized = normalizeEmailAddress(email);
  if (!normalized) return false;
  return parseOperatorAllowlist(runtimeString("CRM_ADMIN_EMAILS")).has(normalized);
}
