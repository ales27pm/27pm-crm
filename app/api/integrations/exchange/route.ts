import { requireOperatorRequest, requireSameOriginOperatorRequest } from "@/lib/api-auth";
import {
  checkExchangeConnection, disconnectExchangeConnection, exchangeConnectionStatus,
  ExchangeConnectionError, finalizeExchangeConnection, startExchangeConnection,
} from "@/lib/exchange-connection-service";
import { exchangeRuntimeCapabilities, exchangeRuntimeContext } from "@/lib/exchange-runtime";
import { readExchangeAction } from "@/lib/exchange-request";
import { reportExchangeFailure } from "@/lib/exchange-diagnostics";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  try {
    const context = exchangeRuntimeContext();
    const result = context ? await exchangeConnectionStatus(context) : {
      configured: false, status: "disconnected", updatedAt: null, mailFlowEnabled: false,
    };
    return Response.json(withCapabilities(result), { headers: privateNoStoreHeaders() });
  } catch { return privateJsonError(503, "exchange_connection_unavailable"); }
}

export async function POST(request: Request) {
  const auth = requireSameOriginOperatorRequest(request);
  if (auth.response) return auth.response;
  const input = await readExchangeAction(request);
  if (!input) return privateJsonError(400, "invalid_request");
  try {
    const context = exchangeRuntimeContext();
    if (!context) return privateJsonError(503, "exchange_not_configured");
    const result = input.action === "connect" ? await startExchangeConnection(context, auth.operator.email, input.binder)
      : input.action === "finalize" ? await finalizeExchangeConnection(context, auth.operator.email, input.flowId, input.binder)
      : input.action === "check" ? await checkExchangeConnection(context)
      : input.action === "disconnect" ? await disconnectExchangeConnection(context) : null;
    if (!result) return privateJsonError(400, "invalid_request");
    return Response.json(withCapabilities(result), { headers: privateNoStoreHeaders() });
  } catch (error) {
    reportExchangeFailure(input.action, error instanceof ExchangeConnectionError ? error.code : undefined);
    return error instanceof ExchangeConnectionError
      ? privateJsonError(error.status, error.code)
      : privateJsonError(503, "exchange_connection_unavailable");
  }
}

function withCapabilities<T extends object>(result: T) {
  return {
    ...result,
    ...exchangeRuntimeCapabilities(),
  };
}
