import "server-only";

import { authorizeCrmRequest, type Operator } from "./auth";
export { operatorAuditDetails } from "./auth";
import { crmDatabase } from "./d1";
import {
  isSameOriginBrowserRequest,
  privateJsonError,
  readJsonObject,
} from "./http";
import {
  hasMobileScope,
  mobileBearerToken,
  verifyMobileAccessToken,
  type MobileScope,
} from "./mobile-auth";
import { activeMobileSession } from "./mobile-auth-store";
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

export async function requireOperatorOrMobileRequest(
  request: Request,
  mobileScope: MobileScope,
): Promise<OperatorRequestResult> {
  const bearer = mobileBearerToken(request);
  if (bearer === undefined) return requireOperatorRequest(request);
  return requireMobileOperatorRequest(bearer, mobileScope);
}

export async function requireSameOriginOperatorOrMobileRequest(
  request: Request,
  mobileScope: MobileScope,
): Promise<OperatorRequestResult> {
  const bearer = mobileBearerToken(request);
  if (bearer === undefined) return requireSameOriginOperatorRequest(request);
  if (
    (request.headers.has("origin") || request.headers.has("sec-fetch-site")) &&
    !isSameOriginBrowserRequest(request)
  ) {
    return {
      response: privateJsonError(403, "cross_origin_request_forbidden"),
    };
  }
  return requireMobileOperatorRequest(bearer, mobileScope);
}

export async function requireSameOriginOperatorOrMobileJsonRequest(
  request: Request,
  mobileScope: MobileScope,
  invalidPayloadCode: string,
): Promise<OperatorJsonRequestResult> {
  const authorization = await requireSameOriginOperatorOrMobileRequest(
    request,
    mobileScope,
  );
  if (authorization.response) return authorization;
  const payload = await readJsonObject(request);
  if (!payload) {
    return { response: privateJsonError(400, invalidPayloadCode) };
  }
  return { operator: authorization.operator, payload };
}

async function requireMobileOperatorRequest(
  bearer: string | null,
  mobileScope: MobileScope,
): Promise<OperatorRequestResult> {
  if (!bearer) {
    return { response: privateJsonError(401, "mobile_token_invalid") };
  }
  const signingSecret = runtimeString("CRM_MOBILE_TOKEN_SIGNING_KEY");
  const issuer = runtimeString("CRM_PUBLIC_ORIGIN");
  if (!signingSecret || !issuer) {
    return {
      response: privateJsonError(503, "mobile_authentication_unavailable"),
    };
  }
  const claims = await verifyMobileAccessToken(
    signingSecret,
    bearer,
    issuer,
  );
  if (!claims) {
    return { response: privateJsonError(401, "mobile_token_invalid") };
  }
  try {
    const operator = await activeMobileSession(
      crmDatabase(),
      claims,
      runtimeString("CRM_ADMIN_EMAILS"),
    );
    if (!operator) {
      return { response: privateJsonError(401, "mobile_session_invalid") };
    }
    // A scope denial is meaningful only after the signed token is tied to a
    // current session; unknown or revoked sessions remain non-enumerating 401s.
    if (!hasMobileScope(claims, mobileScope)) {
      return { response: privateJsonError(403, "mobile_scope_forbidden") };
    }
    return { operator };
  } catch {
    return {
      response: privateJsonError(503, "mobile_authentication_unavailable"),
    };
  }
}
