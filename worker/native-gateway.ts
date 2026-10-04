// Opt-in Cloudflare route in front of Vercel. No DNS/route is created by this file.
// CRM_BACKEND is a private service binding to the existing data Worker, not a URL.
export type NativeGatewayEnv = {
  NATIVE_GATEWAY_ENABLED?: string;
  CRM_BACKEND?: { fetch(request: Request): Promise<Response> };
};
const ORIGIN = "https://crm.27pm.org";
const BASE = "/api/mobile/attachments";
const CAPABILITIES = "/api/mobile/capabilities";
const LIMIT = 21 * 1024 * 1024;
const ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PRIVATE_HEADERS = { "cache-control": "private, no-store", "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff", "vary": "Authorization" };
const error = (status: number, code: string) => Response.json({ error: code }, { status, headers: PRIVATE_HEADERS });

export async function nativeGateway(request: Request, env: NativeGatewayEnv): Promise<Response> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (url.origin !== ORIGIN || url.username || url.password || url.hash || path.includes("%")) return error(400, "validation_failed");
  const capability = path === CAPABILITIES && method === "GET";
  const collection = path === BASE && (method === "GET" || method === "POST");
  const remove = new RegExp(`^${BASE}/${ID}$`, "u").test(path) && method === "DELETE";
  const download = new RegExp(`^${BASE}/${ID}/file$`, "u").test(path) && method === "GET";
  if (!capability && !collection && !remove && !download) return error(404, "not_found");
  if (path === BASE && method === "GET") {
    if ([...url.searchParams.keys()].some(k => k !== "ownerKind" && k !== "ownerId")
      || url.searchParams.getAll("ownerKind").length !== 1 || url.searchParams.getAll("ownerId").length !== 1) {
      return error(400, "validation_failed");
    }
  } else if (url.search) return error(400, "validation_failed");
  // Shape check only; actual signature/session/scope verification stays at CRM_BACKEND.
  if (!/^Bearer [A-Za-z0-9._~-]+$/u.test(request.headers.get("authorization") ?? "")) return error(401, "authentication_required");
  if (!env.CRM_BACKEND || typeof env.CRM_BACKEND.fetch !== "function") return error(503, "attachments_unavailable");
  if (!capability && env.NATIVE_GATEWAY_ENABLED !== "1") return error(503, "attachments_unavailable");
  const length = request.headers.get("content-length");
  if (length !== null && !/^\d+$/u.test(length)) return error(400, "validation_failed");
  if (length !== null && Number(length) > LIMIT) return error(413, "file_too_large");
  if (request.headers.has("content-encoding")) return error(400, "validation_failed");
  const headers = new Headers();
  // No identity, cookies, proxy headers or client-defined internal assertions.
  for (const name of ["authorization", "content-type", "content-length", "accept", "origin", "sec-fetch-site"]) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  let received = 0, oversized = false;
  const body = request.body?.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > LIMIT) { oversized = true; throw new Error("file_too_large"); }
      controller.enqueue(chunk);
    },
    flush() {
      if (length !== null && received !== Number(length)) throw new Error("length_mismatch");
    },
  }));
  try {
    const upstream = await env.CRM_BACKEND.fetch(new Request(request.url, {
      method, headers, body, redirect: "manual", signal: request.signal,
      ...(body ? { duplex: "half" } : {}),
    }));
    if (upstream.status >= 300 && upstream.status < 400) {
      await upstream.body?.cancel().catch(() => undefined);
      return error(502, "api_backend_redirect_forbidden");
    }
    if (capability && upstream.status === 200) {
      // Do not let a misrouted HTML response or oversized JSON advertise support.
      const reader = upstream.body?.getReader();
      let text = "", size = 0;
      try {
        if (!reader || !/^application\/json(?:;|$)/iu.test(upstream.headers.get("content-type") ?? "")) throw new Error("invalid_capability");
        const decoder = new TextDecoder("utf-8", { fatal: true });
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 1024) throw new Error("invalid_capability");
          text += decoder.decode(chunk.value, { stream: true });
        }
        text += decoder.decode();
        const value: unknown = JSON.parse(text);
        const positive = value !== null && typeof value === "object" && !Array.isArray(value)
          && (value as { attachments?: unknown }).attachments === true;
        return Response.json({ attachments: env.NATIVE_GATEWAY_ENABLED === "1" && positive }, { headers: PRIVATE_HEADERS });
      } finally { await reader?.cancel().catch(() => undefined); reader?.releaseLock(); }
    }
    const responseHeaders = new Headers();
    for (const name of ["content-type", "content-length", "content-disposition", "retry-after", "content-security-policy", "cross-origin-resource-policy"]) {
      const value = upstream.headers.get(name);
      if (value !== null) responseHeaders.set(name, value);
    }
    for (const [name, value] of Object.entries(PRIVATE_HEADERS)) responseHeaders.set(name, value);
    return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
  } catch {
    return error(oversized ? 413 : 502, oversized ? "file_too_large" : "api_backend_unreachable");
  }
}
export default { fetch: nativeGateway };
