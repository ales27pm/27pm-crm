import { requireOperatorRequest } from "@/lib/api-auth";
import { exchangeRuntimeContext } from "@/lib/exchange-runtime";
import { runtimeString } from "@/lib/runtime";
import { syncExchangeFolder } from "@/lib/exchange-sync-service";
import { handleExchangeSyncTool } from "@/lib/exchange-sync-tool";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return handleExchangeSyncTool(request, {
    authorize: request => requireOperatorRequest(request).response,
    enabled: () => runtimeString("CRM_EXCHANGE_SYNC_ENABLED") === "true" &&
      runtimeString("CRM_EXCHANGE_AUTOMATIC_SYNC_ENABLED") === "true",
    syncFolder: folder => {
      const context = exchangeRuntimeContext();
      if (!context) throw new Error("exchange_not_configured");
      return syncExchangeFolder(context, folder);
    },
  });
}
