import "server-only";

import { cakemailConfig } from "./cakemail-runtime";
import {
  hasRequiredCakemailWebhookSecrets,
  parseCakemailWebhookSecrets,
} from "./cakemail-webhook";
import { mailgunConfig } from "./mailgun-runtime";
import { exchangeRuntimeContext } from "./exchange-runtime";
import { runtimeString } from "./runtime";

export type OutboundProvider = "mailgun" | "cakemail" | "exchange";

export type OutboundTransportConfig =
  | {
      readonly provider: "mailgun";
      readonly config: ReturnType<typeof mailgunConfig>;
    }
  | {
      readonly provider: "cakemail";
      readonly config: ReturnType<typeof cakemailConfig>;
    }
  | {
      readonly provider: "exchange";
      readonly config: NonNullable<ReturnType<typeof exchangeRuntimeContext>>;
    };

export function selectedOutboundProvider(): OutboundProvider {
  const value = runtimeString("CRM_OUTBOUND_PROVIDER") ?? "mailgun";
  if (value !== "mailgun" && value !== "cakemail" && value !== "exchange") {
    throw new Error("CRM_OUTBOUND_PROVIDER is invalid.");
  }
  return value;
}

/**
 * Non-secret provider identity safe to expose to an authenticated operator UI.
 * Invalid runtime configuration stays explicit instead of breaking dashboard
 * reads or silently claiming that a different provider is active.
 */
export function selectedOutboundProviderStatus(): OutboundProvider | "unknown" {
  try {
    return selectedOutboundProvider();
  } catch {
    return "unknown";
  }
}

export function outboundTransportConfig(): OutboundTransportConfig {
  const provider = selectedOutboundProvider();
  if (provider === "cakemail") {
    const webhookSecrets = parseCakemailWebhookSecrets(
      runtimeString("CAKEMAIL_WEBHOOK_SECRETS_JSON"),
    );
    if (!hasRequiredCakemailWebhookSecrets(webhookSecrets)) {
      throw new Error("CAKEMAIL_WEBHOOK_SECRETS_JSON is invalid.");
    }
    return { provider, config: cakemailConfig() };
  }
  if (provider === "exchange") {
    if (runtimeString("CRM_EXCHANGE_MAIL_ENABLED") !== "true") {
      throw new Error("CRM_EXCHANGE_MAIL_ENABLED is unavailable.");
    }
    const context = exchangeRuntimeContext();
    if (!context) throw new Error("Exchange configuration is invalid.");
    return { provider, config: context };
  }
  return { provider, config: mailgunConfig() };
}

export function requireOutboundOperationalConfig(): OutboundTransportConfig {
  const provider = selectedOutboundProvider();
  if (provider !== "exchange" && !runtimeString("MAILGUN_WEBHOOK_SIGNING_KEY")) {
    throw new Error("MAILGUN_WEBHOOK_SIGNING_KEY is unavailable.");
  }
  return outboundTransportConfig();
}

/**
 * Keeps ordinary CRM messages fail-closed while still allowing the dedicated,
 * separately approved Exchange canary route to exercise the transport.
 */
export function exchangeMessageSendGateEnabled(
  provider: OutboundProvider,
): boolean {
  return provider !== "exchange" ||
    runtimeString("CRM_EXCHANGE_MESSAGE_SEND_ENABLED") === "true";
}

export function requireOutboundMessageOperationalConfig(): OutboundTransportConfig {
  const transport = requireOutboundOperationalConfig();
  if (!exchangeMessageSendGateEnabled(transport.provider)) {
    throw new Error("CRM_EXCHANGE_MESSAGE_SEND_ENABLED is unavailable.");
  }
  return transport;
}

export function outboundTransportOperational(): boolean {
  try {
    requireOutboundMessageOperationalConfig();
    return true;
  } catch {
    return false;
  }
}
