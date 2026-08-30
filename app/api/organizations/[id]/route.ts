import { requireOperatorRequest } from "@/lib/api-auth";
import { deleteAccount, entityId, parseAccountInput, updateAccount } from "@/lib/crm-accounts";
import { crmDatabase } from "@/lib/d1";
import { jsonError, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const id = entityId((await context.params).id);
  if (!id) return jsonError(400, "account_id_invalid");
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const parsed = parseAccountInput(payload);
  if (!parsed.ok) return jsonError(400, parsed.code);
  try {
    const updated = await updateAccount(crmDatabase(), id, parsed.value, auth.operator.email);
    return updated ? Response.json({ updated: true }, { headers: { "cache-control": "private, no-store" } }) : jsonError(404, "account_not_found");
  } catch {
    return jsonError(500, "account_update_failed");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const id = entityId((await context.params).id);
  if (!id) return jsonError(400, "account_id_invalid");
  try {
    const deleted = await deleteAccount(crmDatabase(), id, auth.operator.email);
    return deleted
      ? Response.json({ deleted: true }, { headers: { "cache-control": "private, no-store" } })
      : jsonError(404, "account_not_found");
  } catch {
    return jsonError(500, "account_delete_failed");
  }
}
