import {
  requireOperatorRequest,
  requireSameOriginOperatorRequest,
} from "@/lib/api-auth";
import { boundedRequest } from "@/lib/bounded-request";
import {
  CakemailUnknownSendResolutionError,
  listUnknownCakemailSends,
  parseCakemailUnknownSendResolutionRequest,
  resolveUnknownCakemailSend,
} from "@/lib/cakemail-unknown-send-resolution";
import { crmDatabase } from "@/lib/d1";
import {
  privateJsonError,
  privateNoStoreHeaders,
  readJsonObject,
} from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_RESOLUTION_BODY_BYTES = 16 * 1024;

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  try {
    const commands = await listUnknownCakemailSends(crmDatabase());
    return Response.json(
      { commands },
      { headers: privateNoStoreHeaders() },
    );
  } catch {
    return privateJsonError(500, "cakemail_resolution_list_failed");
  }
}

export async function POST(request: Request) {
  const auth = requireSameOriginOperatorRequest(request);
  if (auth.response) return auth.response;

  const bounded = await boundedRequest(request, MAX_RESOLUTION_BODY_BYTES);
  if (!bounded) return privateJsonError(413, "request_too_large");
  const payload = await readJsonObject(bounded);
  const input = parseCakemailUnknownSendResolutionRequest(
    payload,
    auth.operator.email,
  );
  if (!input) return privateJsonError(400, "cakemail_resolution_invalid");

  try {
    const result = await resolveUnknownCakemailSend(crmDatabase(), input);
    return Response.json(result, { headers: privateNoStoreHeaders() });
  } catch (error) {
    if (error instanceof CakemailUnknownSendResolutionError) {
      return privateJsonError(error.status, error.code);
    }
    return privateJsonError(500, "cakemail_resolution_failed");
  }
}
