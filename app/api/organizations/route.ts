import { requireOperatorRequest } from "@/lib/api-auth";
import { createAccount, parseAccountInput } from "@/lib/crm-accounts";
import { crmDatabase, isUniqueConstraintError } from "@/lib/d1";
import { jsonError, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const parsed = parseAccountInput(payload);
  if (!parsed.ok) return jsonError(400, parsed.code);
  try {
    const account = await createAccount(crmDatabase(), parsed.value, auth.operator.email);
    return Response.json({ account }, { status: 201, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    return jsonError(isUniqueConstraintError(error) ? 409 : 500, isUniqueConstraintError(error) ? "account_already_exists" : "account_create_failed");
  }
}
