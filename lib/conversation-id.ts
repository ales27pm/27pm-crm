// Keep existing UUID/seed IDs and the deterministic IDs emitted by
// recordAcceptedOutboundMessage. Do not allow arbitrary colon-delimited keys.
export function isConversationId(value: unknown): value is string {
  return typeof value === "string" && (
    /^[a-zA-Z0-9_-]{1,128}$/u.test(value) ||
    /^accepted-conversation:[a-f0-9]{64}$/u.test(value)
  );
}
