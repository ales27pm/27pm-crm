import "server-only";

import { authorizeCrmRequest, type Operator } from "./auth";
import {
  isSameOriginBrowserRequest,
  privateJsonError,
  readJsonObject,
} from "./http";
import { runtimeString } from "./runtime";

type OperatorRequestResult =
  | { operator: Operator; response?: never }
  | { operator?: never; response: Response };

export function requireOperatorRequest(
  request: Request,
): OperatorRequestResult {
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

export function requireSameOriginOperatorRequest(
  request: Request,
): OperatorRequestResult {
  const authorization = requireOperatorRequest(request);
  if (authorization.response) return authorization;
  if (!isSameOriginBrowserRequest(request)) {
    return {
      response: privateJsonError(403, "cross_origin_request_forbidden"),
    };
  }
  return authorization;
}

type OperatorJsonRequestResult =
  | {
      operator: Operator;
      payload: Record<string, unknown>;
      response?: never;
    }
  | { operator?: never; payload?: never; response: Response };

export async function requireSameOriginOperatorJsonRequest(
  request: Request,
  invalidPayloadCode: string,
): Promise<OperatorJsonRequestResult> {
  const authorization = requireSameOriginOperatorRequest(request);
  if (authorization.response) return authorization;

  const payload = await readJsonObject(request);
  if (!payload) {
    return { response: privateJsonError(400, invalidPayloadCode) };
  }
  return { operator: authorization.operator, payload };
}
