import "server-only";

import { cakemailConfig } from "./cakemail-runtime";
import {
  hasRequiredCakemailWebhookSecrets,
  parseCakemailWebhookSecrets,
} from "./cakemail-webhook";
import { mailgunConfig } from "./mailgun-runtime";
import { runtimeString } from "./runtime";

export type OutboundProvider = "mailgun" | "cakemail";

export type OutboundTransportConfig =
  | {
      readonly provider: "mailgun";
      readonly config: ReturnType<typeof mailgunConfig>;
    }
  | {
      readonly provider: "cakemail";
      readonly config: ReturnType<typeof cakemailConfig>;
    };

export function selectedOutboundProvider(): OutboundProvider {
  const value = runtimeString("CRM_OUTBOUND_PROVIDER") ?? "mailgun";
  if (value !== "mailgun" && value !== "cakemail") {
    throw new Error("CRM_OUTBOUND_PROVIDER is invalid.");
  }
  return value;
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
  return { provider, config: mailgunConfig() };
}

export function requireOutboundOperationalConfig(): OutboundTransportConfig {
  if (!runtimeString("MAILGUN_WEBHOOK_SIGNING_KEY")) {
    throw new Error("MAILGUN_WEBHOOK_SIGNING_KEY is unavailable.");
  }
  return outboundTransportConfig();
}

export function outboundTransportOperational(): boolean {
  try {
    requireOutboundOperationalConfig();
    return true;
  } catch {
    return false;
  }
}
