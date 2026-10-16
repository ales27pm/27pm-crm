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
import { ATTACHMENT_CHUNK_BYTES, AttachmentV2Error, readBoundedBytes } from "./attachment-v2-protocol";

const STRIPPED_REQUEST_HEADERS = new Set([
  "cf-connecting-ip",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "keep-alive",
  "oai-sites-authorization",
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
  attachmentV2Enabled?: string;
};

export type PreparedVercelApiRequest = {
  destination: URL;
  headers: Headers;
  /** Already bounded attachment body; the original stream was consumed once. */
  body?: Uint8Array<ArrayBuffer>;
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
    const body = prepared.body !== undefined ? prepared.body
      : source.body === null ? undefined : await source.arrayBuffer();
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
  let boundedBody: Uint8Array<ArrayBuffer> | undefined;
  const destination = backendDestination(request, configuration.apiOrigin);
  if (!destination) return proxyError(503, "api_backend_unavailable");
  const pathname = new URL(request.url).pathname;
  const attachmentPath = pathname === "/api/mobile/attachment-uploads"
    || pathname.startsWith("/api/mobile/attachment-uploads/")
    || pathname === "/api/mobile/attachments" || pathname.startsWith("/api/mobile/attachments/")
    || pathname.startsWith("/api/internal/attachment-scanner/");
  if (pathname === "/api/mobile/capabilities" && configuration.attachmentV2Enabled !== "1") {
    return Response.json({ attachments: false }, { headers: { "cache-control": "private, no-store" } });
  }
  if (attachmentPath) {
    if (configuration.attachmentV2Enabled !== "1") return proxyError(503, "attachment_transport_disabled");
    const allowed = /^(?:\/api\/mobile\/attachment-uploads(?:\/[0-9a-f-]{36}(?:\/complete|\/chunks\/(?:0|[1-9]))?)?|\/api\/mobile\/attachments(?:\/[0-9a-f-]{36}(?:\/manifest|\/chunks\/(?:0|[1-9]))?)?|\/api\/internal\/attachment-scanner\/(?:claim|heartbeat|jobs\/[0-9a-f-]{36}\/(?:renew|complete|fail|chunks\/(?:0|[1-9]))))$/u.test(pathname);
    if (!allowed) return proxyError(503, "attachment_route_unavailable");
    if (request.headers.has("content-encoding") || request.headers.has("transfer-encoding")) return proxyError(403, "attachment_encoding_forbidden");
    const limit = request.method === "PUT" && /\/chunks\/[0-9]$/u.test(pathname) ? ATTACHMENT_CHUNK_BYTES : 16 * 1024;
    const declared = request.headers.get("content-length");
    if (declared !== null && (!/^[0-9]+$/u.test(declared) || Number(declared) > limit)) {
      return proxyError(413, "attachment_body_too_large");
    }
    try {
      if (request.body) {
        // Do not tee an untrusted upload with clone(): cancelling only one tee
        // branch can hang while the other branch buffers an unbounded source.
        boundedBody = new Uint8Array(await readBoundedBytes(request.body, limit, request.signal));
        request = new Request(request.url, { method: request.method, headers: request.headers,
          body: boundedBody, signal: request.signal });
      }
    }
    catch (error) { return proxyError(error instanceof AttachmentV2Error && error.status === 413 ? 413 : 400, "attachment_body_invalid"); }
  }
  if (pathname === "/api/integrations/exchange/callback" || pathname === "/api/integrations/exchange/callback/") {
    return proxyError(403, "exchange_callback_requires_direct_worker");
  }
  if (pathname === "/api/public/intake" || pathname === "/api/public/intake/") {
    return proxyError(503, "public_intake_requires_direct_worker");
  }

  const headers = sanitizedProxyHeaders(request.headers);
  if (!operatorEmail || isOperatorIndependentRequest(request)
    || (pathname.startsWith("/api/internal/attachment-scanner/") && headers.get("authorization")?.startsWith("Scanner sc1:"))) {
    return { destination, headers, ...(boundedBody === undefined ? {} : { body: boundedBody }) };
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
    return { destination, headers, ...(boundedBody === undefined ? {} : { body: boundedBody }) };
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
  // Provider credentials and trusted internal identity never belong to a
  // public response. Iterate the untouched source, not the live collection
  // being deleted from, so adjacent reserved names cannot be skipped.
  for (const name of source.keys()) {
    const lower = name.toLowerCase();
    if (lower.startsWith("oai-") || lower.startsWith("x-27pm-internal-")
      || lower.startsWith("x-crm-internal-")) headers.delete(name);
  }
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

function proxyError(status: 400 | 403 | 413 | 502 | 503, error: string): Response {
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
