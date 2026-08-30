import { requireOperatorRequest } from "@/lib/api-auth";
import { deleteContact, entityId, parseContactInput, updateContact } from "@/lib/crm-accounts";
import { crmDatabase, isSuppressedChannelError, isUniqueConstraintError } from "@/lib/d1";
import { jsonError, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const id = entityId((await context.params).id);
  if (!id) return jsonError(400, "contact_id_invalid");
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const parsed = parseContactInput(payload);
  if (!parsed.ok) return jsonError(400, parsed.code);
  try {
    const updated = await updateContact(crmDatabase(), id, parsed.value, auth.operator.email);
    if (updated === "not_found") return jsonError(404, "contact_or_account_not_found");
    if (updated === "blocked_identity_change") return jsonError(409, "suppressed_contact_identity_locked");
    if (updated === "blocked_record_locked") return jsonError(409, "suppressed_contact_record_locked");
    if (updated === "blocked_relationship_change") return jsonError(409, "linked_contact_account_locked");
    return Response.json({ updated: true }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (isSuppressedChannelError(error)) return jsonError(409, "suppressed_contact_identity_locked");
    return jsonError(isUniqueConstraintError(error) ? 409 : 500, isUniqueConstraintError(error) ? "contact_already_exists" : "contact_update_failed");
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const id = entityId((await context.params).id);
  if (!id) return jsonError(400, "contact_id_invalid");
  try {
    const deleted = await deleteContact(crmDatabase(), id, auth.operator.email);
    return deleted
      ? Response.json({ deleted: true }, { headers: { "cache-control": "private, no-store" } })
      : jsonError(404, "contact_not_found");
  } catch {
    return jsonError(500, "contact_delete_failed");
  }
}
