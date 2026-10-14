import { boundedRequest } from "./bounded-request";

/** Microsoft uses form_post; codes in query strings are deliberately unsupported. */
export async function readExchangeCallback(request: Request, callbackOrigin: string): Promise<{ state: string; code?: string; denied?: boolean } | null> {
  const url = new URL(request.url);
  if (request.method !== "POST" || url.origin !== callbackOrigin || url.search ||
    request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
  try {
    const bounded = await boundedRequest(request, 16 * 1024);
    if (!bounded) return null;
    const form = new URLSearchParams(await bounded.text());
    const allowed = new Set(["code", "state", "session_state", "error", "error_description", "error_uri"]);
    for (const key of form.keys()) if (!allowed.has(key) || form.getAll(key).length !== 1) return null;
    const state = form.get("state");
    if (!state || !/^[A-Za-z0-9_-]{43}$/u.test(state)) return null;
    const code = form.get("code");
    if (form.has("error")) return code ? null : { state, denied: true };
    if (!code || code.length > 12_000 || /[\u0000-\u0020\u007f]/u.test(code)) return null;
    return { state, code };
  } catch { return null; }
}

export type ExchangeAction =
  | { action: "connect"; binder: string }
  | { action: "finalize"; flowId: string; binder: string }
  | { action: "check" | "disconnect" };

export async function readExchangeAction(request: Request): Promise<ExchangeAction | null> {
  if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/json") return null;
  try {
    const bounded = await boundedRequest(request, 2048);
    if (!bounded) return null;
    const body: unknown = await bounded.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;
    const value = body as Record<string, unknown>;
    if (typeof value.action !== "string") return null;
    const expected = value.action === "connect" ? ["action", "binder"]
      : value.action === "finalize" ? ["action", "flowId", "binder"]
      : ["check", "disconnect"].includes(value.action) ? ["action"] : [];
    if (!expected.length || Object.keys(value).length !== expected.length || !expected.every(key => Object.hasOwn(value, key))) return null;
    if (value.action === "connect" || value.action === "finalize") {
      if (typeof value.binder !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.binder)) return null;
      if (value.action === "finalize" && (typeof value.flowId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value.flowId))) return null;
    }
    return value as ExchangeAction;
  } catch { return null; }
}
