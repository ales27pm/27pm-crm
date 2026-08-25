import "server-only";

import { authorizeCrmRequest, type Operator } from "./auth";
import { runtimeString } from "./runtime";

export function requireOperatorRequest(
  request: Request,
): { operator: Operator; response?: never } | { operator?: never; response: Response } {
  const authorization = authorizeCrmRequest(
    request,
    runtimeString("CRM_ADMIN_EMAILS"),
  );
  if (authorization.ok) return { operator: authorization.operator };

  return {
    response: Response.json(
      { error: authorization.code },
      {
        status: authorization.status,
        headers: { "cache-control": "private, no-store" },
      },
    ),
  };
}
