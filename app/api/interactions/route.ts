import { requireOperatorRequest } from "@/lib/api-auth";
import {
  createInteraction,
  parseInteractionInput,
} from "@/lib/crm-prospects";
import { crmDatabase } from "@/lib/d1";
import { jsonError, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;

  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const parsed = parseInteractionInput(payload);
  if (!parsed.ok) return jsonError(400, parsed.code);

  try {
    const interaction = await createInteraction(
      crmDatabase(),
      parsed.value,
      auth.operator.email,
    );
    if (!interaction) return jsonError(404, "deal_not_found");
    return Response.json(
      { interaction },
      {
        status: 201,
        headers: { "cache-control": "private, no-store" },
      },
    );
  } catch {
    return jsonError(500, "interaction_create_failed");
  }
}
