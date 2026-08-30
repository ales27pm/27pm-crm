import { requireOperatorRequest } from "@/lib/api-auth";
import { createContact, parseContactInput } from "@/lib/crm-accounts";
import { crmDatabase, isSuppressedChannelError, isUniqueConstraintError } from "@/lib/d1";
import { jsonError, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const parsed = parseContactInput(payload);
  if (!parsed.ok) return jsonError(400, parsed.code);
  try {
    const contact = await createContact(crmDatabase(), parsed.value, auth.operator.email);
    if (!contact) return jsonError(404, "account_not_found");
    return Response.json({ contact }, { status: 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (isSuppressedChannelError(error)) return jsonError(409, "suppressed_contact_identity_locked");
    return jsonError(isUniqueConstraintError(error) ? 409 : 500, isUniqueConstraintError(error) ? "contact_already_exists" : "contact_create_failed");
  }
}
