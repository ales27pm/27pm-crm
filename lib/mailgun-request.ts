import {
  buildMailgunForm,
  type OutboundMailgunMessage,
} from "./mailgun-message";

export type MailgunRequestConfig = {
  url: string;
  authorization: string;
};

export type MailgunRequestOptions = {
  fetcher?: typeof fetch;
  onDispatchStart?: () => void;
};

export async function dispatchMailgunRequest(
  message: OutboundMailgunMessage,
  config: MailgunRequestConfig,
  options: MailgunRequestOptions = {},
): Promise<Response> {
  // All local validation happens before the caller crosses the ambiguous
  // provider boundary. Once the callback fires, a network error must be
  // treated as potentially accepted rather than safely retryable.
  const form = buildMailgunForm(message);
  const fetcher = options.fetcher ?? fetch;
  options.onDispatchStart?.();
  return fetcher(config.url, {
    method: "POST",
    headers: { authorization: config.authorization },
    body: form,
  });
}
