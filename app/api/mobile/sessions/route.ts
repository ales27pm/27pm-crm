import {
  requireOperatorRequest,
  requireSameOriginOperatorRequest,
} from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";
import { readMobileAuthJson } from "@/lib/mobile-auth";
import {
  listActiveMobileSessions,
  revokeMobileSessionByOperator,
} from "@/lib/mobile-auth-store";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  try {
    const sessions = await listActiveMobileSessions(
      crmDatabase(),
      auth.operator.email,
    );
    return Response.json({ sessions }, { headers: privateNoStoreHeaders() });
  } catch {
    return privateJsonError(503, "mobile_sessions_unavailable");
  }
}

export async function DELETE(request: Request) {
  const auth = requireSameOriginOperatorRequest(request);
  if (auth.response) return auth.response;
  const payload = await readMobileAuthJson(request);
  if (!payload) return privateJsonError(400, "invalid_request");
  try {
    const revoked = await revokeMobileSessionByOperator(crmDatabase(), {
      sessionId: payload.sessionId,
      operator: auth.operator,
    });
    if (!revoked) return privateJsonError(404, "mobile_session_not_found");
    return new Response(null, {
      status: 204,
      headers: privateNoStoreHeaders(),
    });
  } catch {
    return privateJsonError(503, "mobile_session_revocation_unavailable");
  }
}
