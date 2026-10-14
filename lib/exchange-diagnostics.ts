const ACTIONS = new Set(["connect", "finalize", "check", "disconnect", "callback", "sync"]);
const ERROR_CODES = new Set([
  "exchange_configuration_mismatch",
  "exchange_already_connected",
  "exchange_flow_busy",
  "exchange_connection_unavailable",
  "exchange_authorization_invalid",
  "exchange_connection_busy",
  "exchange_connection_changed",
  "exchange_reauthentication_required",
  "exchange_storage_unavailable",
  "exchange_configuration_invalid",
  "exchange_provider_unavailable",
  "exchange_provider_response_invalid",
  "exchange_identity_invalid",
  "exchange_scopes_missing",
  "exchange_graph_configuration_invalid",
  "exchange_graph_request_invalid",
  "exchange_graph_connection_changed",
  "exchange_graph_response_invalid",
  "exchange_graph_unavailable",
  "exchange_graph_timeout",
  "exchange_graph_reauthentication_required",
  "exchange_graph_forbidden",
  "exchange_graph_not_found",
  "exchange_graph_delta_reset",
  "exchange_graph_throttled",
  "exchange_graph_request_rejected",
  "exchange_sync_unavailable",
]);
const PROVIDER_ENDPOINTS = new Set(["token", "jwks"]);
const PROVIDER_PHASES = new Set(["request", "http", "response_body"]);
const PROVIDER_KINDS = new Set([
  "timeout", "abort", "transport", "invalid_client", "invalid_request", "invalid_scope",
  "unauthorized_client", "invalid_grant", "interaction_required", "forbidden",
  "rate_limited", "server_error", "http_error", "invalid_response", "redirect",
]);
const MICROSOFT_ERROR_CODES = new Set([7000215, 7000222, 7000218, 700025, 700016]);

/** Never accept error objects or coerce caller input into diagnostic strings. */
export function reportExchangeFailure(action: unknown, errorCode: unknown): void {
  if (typeof action !== "string" || !ACTIONS.has(action)) return;
  const code = typeof errorCode === "string" && ERROR_CODES.has(errorCode)
    ? errorCode
    : "exchange_connection_unavailable";
  console.warn("exchange_connection_failed", { action, code });
}

/** Backend-only literals. Never pass or inspect a provider body, URL or exception object. */
export function reportExchangeProviderFailure(
  endpoint: unknown, phase: unknown, kind: unknown, status?: unknown, aadsts?: unknown,
): void {
  if (typeof endpoint !== "string" || !PROVIDER_ENDPOINTS.has(endpoint) ||
    typeof phase !== "string" || !PROVIDER_PHASES.has(phase) ||
    typeof kind !== "string" || !PROVIDER_KINDS.has(kind)) return;
  const details = {
    endpoint, phase, kind,
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? { status } : {}),
    ...(typeof aadsts === "number" && MICROSOFT_ERROR_CODES.has(aadsts) ? { aadsts } : {}),
  };
  console.warn("exchange_provider_failed", details);
}
