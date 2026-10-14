import {
  requireOperatorRequest,
  requireSameOriginOperatorRequest,
} from "@/lib/api-auth";
import { boundedRequest } from "@/lib/bounded-request";
import { ExchangeConnectionError } from "@/lib/exchange-connection-service";
import { ExchangeGraphError } from "@/lib/exchange-graph";
import { exchangeRuntimeContext } from "@/lib/exchange-runtime";
import {
  ExchangeSendReconciliationError,
  listUnresolvedExchangeSends,
  parseExchangeSendReconciliationRequest,
  reconcileExchangeUnknownSend,
} from "@/lib/exchange-send-reconciliation";
import { crmDatabase } from "@/lib/d1";
import { privateJsonError, privateNoStoreHeaders, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 4 * 1024;

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  try {
    return Response.json(
      { commands: await listUnresolvedExchangeSends(crmDatabase()) },
      { headers: privateNoStoreHeaders() },
    );
  } catch {
    return privateJsonError(500, "exchange_reconciliation_list_failed");
  }
}

export async function POST(request: Request) {
  const auth = requireSameOriginOperatorRequest(request);
  if (auth.response) return auth.response;
  const bounded = await boundedRequest(request, MAX_BODY_BYTES);
  if (!bounded) return privateJsonError(413, "request_too_large");
  const input = parseExchangeSendReconciliationRequest(await readJsonObject(bounded));
  if (!input) return privateJsonError(400, "exchange_reconciliation_invalid");
  const context = exchangeRuntimeContext();
  if (!context) return privateJsonError(503, "exchange_not_configured");
  try {
    const result = await reconcileExchangeUnknownSend(context, input.commandId);
    return Response.json(result, { headers: privateNoStoreHeaders() });
  } catch (error) {
    if (error instanceof ExchangeSendReconciliationError) {
      return privateJsonError(error.status, error.code);
    }
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
    return privateJsonError(503, "exchange_reconciliation_unavailable");
  }
}
