import { normalizeEmailAddress } from "./mailboxes";

export const AUTHENTICATED_EMAIL_HEADER = "oai-authenticated-user-email";

export type Operator = {
  email: string;
};

export type OperatorAuthorization =
  | { ok: true; operator: Operator }
  | {
      ok: false;
      status: 401 | 403 | 503;
      code: "authentication_required" | "operator_forbidden" | "allowlist_unconfigured";
    };

export function parseOperatorAllowlist(value: string | null | undefined): Set<string> {
  const emails = new Set<string>();
  for (const candidate of value?.split(/[\s,;]+/u) ?? []) {
    const email = normalizeEmailAddress(candidate);
    if (email) emails.add(email);
  }
  return emails;
}

export function authorizeCrmRequest(
  request: Request,
  allowlistSource: string | null | undefined,
): OperatorAuthorization {
  const allowlist = parseOperatorAllowlist(allowlistSource);
  if (allowlist.size === 0) {
    return { ok: false, status: 503, code: "allowlist_unconfigured" };
  }

  const email = normalizeEmailAddress(
    request.headers.get(AUTHENTICATED_EMAIL_HEADER) ?? "",
  );
  if (!email) {
    return { ok: false, status: 401, code: "authentication_required" };
  }
  if (!allowlist.has(email)) {
    return { ok: false, status: 403, code: "operator_forbidden" };
  }

  return { ok: true, operator: { email } };
}
