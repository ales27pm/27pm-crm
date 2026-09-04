import "server-only";

import { requireRuntimeString, runtimeString } from "./runtime";

export function mailgunConfig() {
  const apiBase = runtimeString("MAILGUN_API_BASE") ?? "https://api.mailgun.net";
  const url = new URL(apiBase);
  if (
    url.protocol !== "https:" ||
    !["api.mailgun.net", "api.eu.mailgun.net"].includes(url.hostname)
  ) {
    throw new Error("MAILGUN_API_BASE is invalid.");
  }

  const domain = requireRuntimeString("MAILGUN_DOMAIN").toLowerCase();
  if (domain !== "27pm.org") throw new Error("MAILGUN_DOMAIN is invalid.");

  return {
    apiBase: url.origin,
    domain,
    sendingKey: requireRuntimeString("MAILGUN_SENDING_KEY"),
  };
}
