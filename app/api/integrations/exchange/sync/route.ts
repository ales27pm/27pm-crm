import { requireSameOriginOperatorRequest } from "@/lib/api-auth";
import { ExchangeConnectionError } from "@/lib/exchange-connection-service";
import { ExchangeGraphError, type ExchangeGraphFolder } from "@/lib/exchange-graph";
import { exchangeRuntimeContext } from "@/lib/exchange-runtime";
import { privateJsonError, privateNoStoreHeaders, readJsonObject } from "@/lib/http";
import { runtimeString } from "@/lib/runtime";
import { syncExchangeFolder } from "@/lib/exchange-sync-service";

export const dynamic = "force-dynamic";

const FOLDERS = new Set<ExchangeGraphFolder>(["inbox", "junkemail", "sentitems"]);

export async function POST(request: Request) {
  const auth = requireSameOriginOperatorRequest(request);
  if (auth.response) return auth.response;
  const body = await readJsonObject(request);
  if (!body || Object.keys(body).length !== 1 || typeof body.folder !== "string" ||
      !FOLDERS.has(body.folder as ExchangeGraphFolder)) {
    return privateJsonError(400, "invalid_request");
  }
  if (runtimeString("CRM_EXCHANGE_SYNC_ENABLED") !== "true") {
    return privateJsonError(503, "exchange_sync_disabled");
  }
  const context = exchangeRuntimeContext();
  if (!context) return privateJsonError(503, "exchange_not_configured");
  try {
    const result = await syncExchangeFolder(context, body.folder as ExchangeGraphFolder);
    return Response.json({ ok: true, ...result }, { headers: privateNoStoreHeaders() });
  } catch (error) {
    if (error instanceof ExchangeConnectionError) {
      return privateJsonError(error.status, error.code);
    }
    if (error instanceof ExchangeGraphError) {
      const status = error.code === "exchange_graph_throttled" ? 429
        : error.code === "exchange_graph_reauthentication_required" ? 401
          : error.code === "exchange_graph_forbidden" ? 403
            : 503;
      return privateJsonError(status, error.code);
    }
    return privateJsonError(503, "exchange_sync_unavailable");
  }
}
