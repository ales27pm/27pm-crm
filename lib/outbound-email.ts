import "server-only";

import {
  createCakemailExternalMessageId,
} from "./cakemail-message";
import { sendCakemailMessage } from "./cakemail-client";
import { sendMailgunMessage } from "./mailgun-client";
import type { OutboundMailgunMessage } from "./mailgun-message";
import type {
  OutboundProvider,
  OutboundTransportConfig,
} from "./outbound-runtime";

export type OutboundEmailMessage = OutboundMailgunMessage;

export type OutboundDispatchResult = {
  provider: OutboundProvider;
  providerMessageId: string;
  providerConversationId?: string;
  externalMessageId: string | null;
  message: string;
  responseStatus: number;
};

export type OutboundDispatchOptions = {
  externalMessageId?: string | null;
  fetcher?: typeof fetch;
  onDispatchStart?: () => void;
};

export type OutboundTransmittedContent = {
  contentMode: "multipart" | "html" | "text";
  text: string | null;
  html: string | null;
};

export function createOutboundExternalMessageId(
  transport: OutboundTransportConfig,
  fromAddress: string,
): string | null {
  return transport.provider === "cakemail"
    ? createCakemailExternalMessageId(fromAddress)
    : null;
}

export function outboundTransmittedContent(
  content: { text: string; html: string },
  transport: OutboundTransportConfig,
): OutboundTransmittedContent {
  if (transport.provider === "mailgun") {
    return { contentMode: "multipart", text: content.text, html: content.html };
  }
  if (transport.provider === "exchange") {
    // First-contact Exchange messages remain plain text: no tracking pixel,
    // remote asset, or provider-generated HTML is introduced here.
    return { contentMode: "text", text: content.text, html: null };
  }
  return transport.config.contentMode === "html"
    ? { contentMode: "html", text: null, html: content.html }
    : { contentMode: "text", text: content.text, html: null };
}

export async function sendOutboundMessage(
  message: OutboundEmailMessage,
  transport: OutboundTransportConfig,
  options: OutboundDispatchOptions = {},
): Promise<OutboundDispatchResult> {
  if (transport.provider === "cakemail") {
    if (!options.externalMessageId) {
      throw new Error("Cakemail external Message-ID is unavailable.");
    }
    const result = await sendCakemailMessage(message, transport.config, {
      externalMessageId: options.externalMessageId,
      fetcher: options.fetcher,
      onDispatchStart: options.onDispatchStart,
    });
    return { provider: "cakemail", ...result };
  }

  if (transport.provider === "exchange") {
    // Exchange requires durable draft/send state and is dispatched by the CRM
    // route through exchange-outbound.ts. Reaching this generic boundary would
    // lose that state machine, so fail before any network request.
    throw new Error("exchange_dispatch_requires_durable_state");
  }

  const result = await sendMailgunMessage(message, transport.config, {
    fetcher: options.fetcher,
    onDispatchStart: options.onDispatchStart,
  });
  return {
    provider: "mailgun",
    providerMessageId: result.id,
    externalMessageId: result.id,
    message: result.message,
    responseStatus: result.responseStatus,
  };
}
