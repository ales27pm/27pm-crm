import {
  createInternalApiAssertion,
  internalApiBodyDigest,
  internalApiCriticalHeadersDigest,
} from "./internal-api-auth";
import {
  INTERNAL_API_ASSERTION_HEADER,
  INTERNAL_API_DEFAULT_AUDIENCE,
} from "./internal-api-edge";
import { isSameOriginBrowserRequest } from "./http";
import { operatorEmailAllowed, webIdentityProvider } from "./web-identity";

const STRIPPED_REQUEST_HEADERS = new Set([
  "cf-connecting-ip",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
]);

export type VercelApiProxyConfiguration = {
  apiOrigin?: string;
  audience?: string;
  operatorAllowlist?: string;
  signingKey?: string;
};

export type PreparedVercelApiRequest = {
  destination: URL;
  headers: Headers;
};

export function vercelApiProxyEnabled(provider: string | undefined): boolean {
  return webIdentityProvider(provider) === "google";
}

export async function fetchPreparedVercelApiRequest(
  source: Request,
  prepared: PreparedVercelApiRequest,
  fetcher: typeof fetch = fetch,
): Promise<Response> {
  try {
    const body = source.body === null ? undefined : await source.arrayBuffer();
    const upstream = await fetcher(prepared.destination, {
      method: source.method,
      headers: prepared.headers,
      body,
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(25_000),
    });
    const headers = sanitizedProxyResponseHeaders(
      upstream.headers,
      new URL(source.url),
      prepared.destination,
      upstream.status,
    );
    if (!headers) {
      await upstream.body?.cancel().catch(() => undefined);
      return proxyError(502, "api_backend_redirect_forbidden");
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return proxyError(502, "api_backend_unreachable");
  }
}

export async function prepareVercelApiRequest(
  request: Request,
  operatorEmail: string | null | undefined,
  configuration: VercelApiProxyConfiguration,
): Promise<PreparedVercelApiRequest | Response> {
  const destination = backendDestination(request, configuration.apiOrigin);
  if (!destination) return proxyError(503, "api_backend_unavailable");
  const pathname = new URL(request.url).pathname;
  if (pathname === "/api/public/intake" || pathname === "/api/public/intake/") {
    return proxyError(503, "public_intake_requires_direct_worker");
  }

  const headers = sanitizedProxyHeaders(request.headers);
  if (!operatorEmail || isOperatorIndependentRequest(request)) {
    return { destination, headers };
  }
  if (!operatorEmailAllowed(operatorEmail, configuration.operatorAllowlist)) {
    return proxyError(403, "operator_forbidden");
  }
  if (!isSameOriginBrowserRequest(request)) {
    return proxyError(403, "cross_origin_request_forbidden");
  }

  try {
    const url = new URL(request.url);
    const bodyDigest = request.body === null
      ? undefined
      : await internalApiBodyDigest(await request.clone().arrayBuffer());
    const queryDigest = await internalApiBodyDigest(url.search);
    const headerDigest = await internalApiCriticalHeadersDigest(headers);
    const { token } = await createInternalApiAssertion(
      configuration.signingKey ?? "",
      {
        subject: operatorEmail,
        audience:
          configuration.audience?.trim() || INTERNAL_API_DEFAULT_AUDIENCE,
        method: request.method.toUpperCase(),
        pathname: url.pathname,
        bodyDigest,
        headerDigest,
        queryDigest,
      },
    );
    headers.set(INTERNAL_API_ASSERTION_HEADER, token);
    return { destination, headers };
  } catch {
    return proxyError(503, "internal_authentication_unavailable");
  }
}

function isOperatorIndependentRequest(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  const bearer = request.headers.get("authorization")?.match(/^Bearer\s+\S+$/iu);
  return Boolean(
    bearer ||
    pathname === "/api/health" ||
    pathname === "/api/mobile/token" ||
    pathname === "/api/mobile/logout" ||
    pathname.startsWith("/api/public/") ||
    pathname.startsWith("/api/webhooks/")
  );
}

function backendDestination(request: Request, value: string | undefined): URL | null {
  try {
    const source = new URL(request.url);
    const origin = new URL(value ?? "");
    if (
      (origin.protocol !== "https:" &&
        !(origin.protocol === "http:" && isLoopbackHost(origin.hostname))) ||
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      origin.origin === source.origin ||
      !source.pathname.startsWith("/api/")
    ) return null;
    return new URL(`${source.pathname}${source.search}`, origin);
  } catch {
    return null;
  }
}

function sanitizedProxyHeaders(source: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of source) {
    const lower = name.toLowerCase();
    if (
      STRIPPED_REQUEST_HEADERS.has(lower) ||
      lower.startsWith("oai-authenticated-") ||
      lower.startsWith("x-27pm-internal-") ||
      lower.startsWith("x-forwarded-") ||
      lower.startsWith("x-middleware-")
    ) continue;
    headers.append(name, value);
  }
  return headers;
}

function sanitizedProxyResponseHeaders(
  source: Headers,
  publicUrl: URL,
  backendUrl: URL,
  status: number,
): Headers | null {
  const headers = new Headers(source);
  for (const name of [
    "connection",
    "content-encoding",
    "content-length",
    "keep-alive",
    "proxy-authenticate",
    "set-cookie",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "x-middleware-rewrite",
  ]) headers.delete(name);
  const location = headers.get("location");
  if (location) {
    try {
      const target = new URL(location, backendUrl);
      if (target.origin === backendUrl.origin) {
        headers.set(
          "location",
          new URL(`${target.pathname}${target.search}${target.hash}`, publicUrl.origin)
            .toString(),
        );
      } else if (status >= 300 && status < 400) {
        return null;
      }
    } catch {
      if (status >= 300 && status < 400) return null;
      headers.delete("location");
    }
  }
  headers.set("cache-control", "private, no-store");
  return headers;
}

function isLoopbackHost(value: string): boolean {
  return value === "localhost" || value === "127.0.0.1" || value === "[::1]";
}

function proxyError(status: 403 | 502 | 503, error: string): Response {
  return Response.json(
    { error },
    {
      status,
      headers: {
        "cache-control": "private, no-store",
        "referrer-policy": "no-referrer",
      },
    },
  );
}
