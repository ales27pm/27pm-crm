import { stageExchangeCallback } from "@/lib/exchange-connection-service";
import { readExchangeCallback } from "@/lib/exchange-request";
import { exchangeRuntimeContext } from "@/lib/exchange-runtime";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const context = exchangeRuntimeContext();
    if (!context) return privateJsonError(503, "exchange_not_configured");
    const input = await readExchangeCallback(request, context.oauth.callbackOrigin);
    if (!input) return privateJsonError(400, "exchange_authorization_invalid");
    let complete = false;
    try {
      await stageExchangeCallback(context, input);
      complete = true;
    } catch { /* Provider descriptions and submitted codes must never enter logs or responses. */ }
    const destination = new URL("/settings/exchange", context.oauth.publicOrigin);
    destination.searchParams.set(complete ? "complete" : "denied", "1");
    return new Response(null, { status: 303, headers: {
      ...privateNoStoreHeaders(), location: destination.toString(),
      "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
    } });
  } catch { return privateJsonError(503, "exchange_connection_unavailable"); }
}

// No OAuth code is accepted in URLs, including on a retry or a misconfigured app registration.
export function GET() { return privateJsonError(405, "exchange_form_post_required"); }
