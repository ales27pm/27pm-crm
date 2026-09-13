import "server-only";

import {
  buildCakemailPayload,
  type CakemailContentMode,
  type OutboundCakemailMessage,
} from "./cakemail-message";
import {
  cakemailFailureKindForStatus,
  CakemailSendError,
} from "./cakemail-send-outcome";
import { concatenateBytes } from "./byte-utils";

export type { OutboundCakemailMessage } from "./cakemail-message";

export type CakemailClientConfig = {
  apiBase: string;
  pat: string;
  accountId: number;
  listId: number;
  contentMode: CakemailContentMode;
  senderIds: Readonly<Record<string, string>>;
};

export type CakemailSendResult = {
  providerMessageId: string;
  externalMessageId: string;
  message: string;
  responseStatus: 201;
};

export type CakemailRequestOptions = {
  externalMessageId: string;
  fetcher?: typeof fetch;
  onDispatchStart?: () => void;
};

const CAKEMAIL_API_ORIGIN = "https://api.cakemail.dev";
export const CAKEMAIL_RESPONSE_MAX_BYTES = 64 * 1024;
const CAKEMAIL_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const PERSONAL_ACCESS_TOKEN = /^ck_pat_[a-f0-9]{40}$/u;

export async function sendCakemailMessage(
  message: OutboundCakemailMessage,
  config: CakemailClientConfig,
  options: CakemailRequestOptions,
): Promise<CakemailSendResult> {
  const payload = buildCakemailPayload(message, config, options.externalMessageId);
  const url = cakemailSendUrl(config.apiBase, config.accountId);
  const pat = validatedPat(config.pat);
  const requestBody = JSON.stringify(payload);
  const fetcher = options.fetcher ?? fetch;
  const signal = AbortSignal.timeout(CAKEMAIL_REQUEST_TIMEOUT_MS);

  // Everything above is local and deterministic. After this callback fires,
  // a transport error is an ambiguous provider outcome and must not be retried.
  options.onDispatchStart?.();
  const response = await fetcher(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${pat}`,
      "content-type": "application/json",
    },
    body: requestBody,
    redirect: "error",
    signal,
  });

  if (response.status !== 201) {
    throw new CakemailSendError(
      response.status,
      cakemailFailureKindForStatus(response.status),
    );
  }

  const responsePayload = await boundedResponseJson(response);
  const providerMessageId = acceptedProviderMessageId(
    responsePayload,
    message.to[0] ?? "",
  );
  return {
    providerMessageId,
    externalMessageId: options.externalMessageId,
    message: "Queued",
    responseStatus: 201,
  };
}

function cakemailSendUrl(apiBase: string, accountId: number): string {
  let base: URL;
  try {
    base = new URL(apiBase);
  } catch {
    throw new Error("Cakemail API base is invalid.");
  }
  if (
    base.origin !== CAKEMAIL_API_ORIGIN ||
    !/^\/*$/u.test(base.pathname) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("Cakemail API base is invalid.");
  }
  if (!Number.isSafeInteger(accountId) || accountId <= 0) {
    throw new Error("Cakemail account ID is invalid.");
  }
  const url = new URL("/v2/emails", CAKEMAIL_API_ORIGIN);
  url.searchParams.set("account_id", String(accountId));
  return url.toString();
}

function validatedPat(value: string): string {
  if (typeof value !== "string" || !PERSONAL_ACCESS_TOKEN.test(value)) {
    throw new Error("Cakemail PAT is invalid.");
  }
  return value;
}

async function boundedResponseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^[0-9]+$/u.test(declaredLength) ||
      Number(declaredLength) > CAKEMAIL_RESPONSE_MAX_BYTES)
  ) {
    throw new CakemailSendError(502, "outcome_unknown");
  }

  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > CAKEMAIL_RESPONSE_MAX_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Preserve the bounded outcome error if stream cancellation fails.
        }
        throw new CakemailSendError(502, "outcome_unknown");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = concatenateBytes(chunks, totalBytes);
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function acceptedProviderMessageId(
  value: unknown,
  expectedRecipient: string,
): string {
  if (!value || typeof value !== "object") {
    throw new CakemailSendError(502, "outcome_unknown");
  }
  const root = value as Record<string, unknown>;
  const data = root.data;
  if (!data || typeof data !== "object") {
    throw new CakemailSendError(502, "outcome_unknown");
  }
  const details = data as Record<string, unknown>;
  if (
    root.email !== expectedRecipient ||
    typeof details.id !== "string" ||
    !PROVIDER_UUID.test(details.id) ||
    (root.submitted !== undefined && typeof root.submitted !== "boolean")
  ) {
    throw new CakemailSendError(502, "outcome_unknown");
  }

  if (details.status === "queued") {
    if (root.submitted === false) {
      throw new CakemailSendError(502, "outcome_unknown");
    }
    return details.id.toLowerCase();
  }
  if (details.status === "rejected" || details.status === "error") {
    throw new CakemailSendError(201, "rejected");
  }
  throw new CakemailSendError(502, "outcome_unknown");
}
