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
  externalMessageId: string;
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
