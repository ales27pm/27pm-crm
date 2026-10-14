import "server-only";
import { crmDatabase } from "./d1";
import { getPrivateObjectBucket, runtimeString } from "./runtime";
import { parseExchangeOAuthConfig } from "./exchange-oauth";
import type { ExchangeServiceContext } from "./exchange-connection-service";
import type { ExchangeCredentialBucket } from "./exchange-token-vault";

/** Worker-only configuration. Never add these keys to Vercel, NEXT_PUBLIC_* or D1. */
export function exchangeRuntimeContext(): ExchangeServiceContext | null {
  if (runtimeString("CRM_EXCHANGE_ENABLED") !== "true") return null;
  const oauth = parseExchangeOAuthConfig({
    tenantId: runtimeString("CRM_EXCHANGE_TENANT_ID"),
    mailboxId: runtimeString("CRM_EXCHANGE_MAILBOX_ID"),
    clientId: runtimeString("CRM_EXCHANGE_CLIENT_ID"),
    clientSecret: runtimeString("CRM_EXCHANGE_CLIENT_SECRET"),
    publicOrigin: runtimeString("CRM_PUBLIC_ORIGIN"),
    callbackOrigin: runtimeString("CRM_EXCHANGE_CALLBACK_ORIGIN"),
  });
  const encryptionKey = runtimeString("CRM_EXCHANGE_VAULT_KEY");
  if (!oauth || !encryptionKey || !/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u.test(encryptionKey) || oauth.callbackOrigin === oauth.publicOrigin) return null;
  return {
    db: crmDatabase(), bucket: getPrivateObjectBucket() as unknown as ExchangeCredentialBucket,
    oauth, vault: { tenantId: oauth.tenantId, mailboxId: oauth.mailboxId, clientId: oauth.clientId, encryptionKey },
  };
}

/** Non-secret feature switches reported only after operator authentication. */
export function exchangeRuntimeCapabilities(): {
  syncEnabled: boolean;
  mailFlowEnabled: boolean;
} {
  return {
    syncEnabled: runtimeString("CRM_EXCHANGE_SYNC_ENABLED") === "true",
    mailFlowEnabled: runtimeString("CRM_EXCHANGE_MAIL_ENABLED") === "true" &&
      runtimeString("CRM_OUTBOUND_PROVIDER") === "exchange",
  };
}
