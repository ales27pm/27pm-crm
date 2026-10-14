const ACTIONS = new Set(["connect", "finalize", "check", "disconnect", "callback"]);
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
]);

/** Never accept error objects or coerce caller input into diagnostic strings. */
export function reportExchangeFailure(action: unknown, errorCode: unknown): void {
  if (typeof action !== "string" || !ACTIONS.has(action)) return;
  const code = typeof errorCode === "string" && ERROR_CODES.has(errorCode)
    ? errorCode
    : "exchange_connection_unavailable";
  console.warn("exchange_connection_failed", { action, code });
}
