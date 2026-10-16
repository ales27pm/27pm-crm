import { privateNoStoreHeaders } from "./http";
import type { ExchangeGraphFolder } from "./exchange-graph";
import type { ExchangeFolderSyncResult } from "./exchange-sync-service";

const TOOL = {
  name: "sync_exchange_mail",
  description: "Import one bounded delta page from Exchange Inbox, Junk Email and Sent Items into the 27PM CRM. Never sends email, modifies Microsoft messages or processes drafts. Call once per scheduled run; a later run resumes any remaining pages. Returns counts only, never message contents or tokens.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
};

type Dependencies = {
  authorize: (request: Request) => Response | undefined;
  enabled: () => boolean;
  syncFolder: (folder: ExchangeGraphFolder) => Promise<ExchangeFolderSyncResult>;
};

/** No outbound transport or arbitrary mailbox/folder is exposed to the scheduler. */
export async function handleExchangeSyncTool(request: Request, deps: Dependencies): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { ...privateNoStoreHeaders(), allow: "POST" } });
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return new Response(null, { status: 415, headers: privateNoStoreHeaders() });
  }
  // A browser must not use the MCP surface to bypass the normal CSRF boundary.
  if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) {
    return new Response(null, { status: 403, headers: privateNoStoreHeaders() });
  }
  let body: Record<string, unknown>;
  try {
    const text = await request.text();
    if (text.length > 16_384) throw new Error("oversized");
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) throw new Error("invalid");
    body = value;
  } catch { return rpc(null, undefined, { code: -32700, message: "Invalid JSON-RPC request" }); }
  const id = typeof body.id === "string" || (typeof body.id === "number" && Number.isFinite(body.id)) ? body.id : null;
  if (body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return rpc(id, undefined, { code: -32600, message: "Invalid JSON-RPC request" });
  }
  // Notifications cannot cause a synchronization, including tools/call without id.
  if (!Object.hasOwn(body, "id")) return new Response(null, { status: 204, headers: privateNoStoreHeaders() });
  if (body.method === "server/discover") {
    return rpc(id, { supportedVersions: ["2026-07-28"], capabilities: { tools: {} } });
  }
  if (body.method === "initialize") {
    return rpc(id, { protocolVersion: "2026-07-28", capabilities: { tools: {} }, serverInfo: { name: "27pm-exchange-sync", version: "1.0.0" } });
  }
  if (body.method === "tools/list") return rpc(id, { tools: [TOOL] });
  if (body.method !== "tools/call") return rpc(id, undefined, { code: -32601, message: "Method not found" });
  const denied = deps.authorize(request);
  if (denied) return denied;
  const params = body.params;
  if (!isObject(params) || params.name !== TOOL.name ||
      !isObject(params.arguments) || Object.keys(params.arguments).length !== 0 ||
      Object.keys(params).some(key => key !== "name" && key !== "arguments" && key !== "_meta")) {
    return rpc(id, undefined, { code: -32602, message: "Invalid tool or arguments" });
  }
  if (!deps.enabled()) return toolResult(id, { error: "exchange_automatic_sync_disabled" }, true);
  try {
    const folders: ExchangeFolderSyncResult[] = [];
    for (const folder of ["inbox", "junkemail", "sentitems"] as const) folders.push(await deps.syncFolder(folder));
    return toolResult(id, { completedAt: new Date().toISOString(), folders, more: folders.some(folder => folder.more) });
  } catch {
    // Provider details and token-bearing delta URLs never cross this boundary.
    return toolResult(id, { error: "exchange_sync_unavailable", retry: "next_scheduled_run" }, true);
  }
}

function toolResult(id: string | number | null, value: object, isError = false) {
  return rpc(id, { content: [{ type: "text", text: JSON.stringify(value) }], isError });
}

function rpc(id: string | number | null, result?: object, error?: object): Response {
  return Response.json({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) }, { headers: privateNoStoreHeaders() });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
