import { requireOperatorRequest } from "@/lib/api-auth";
import { jsonError } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  return jsonError(
    410,
    "prospect_endpoint_replaced",
    "Créer d’abord une entreprise via /api/organizations, puis un contact vérifié via /api/contacts.",
  );
}
