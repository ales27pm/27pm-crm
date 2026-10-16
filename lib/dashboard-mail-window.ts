export const DASHBOARD_CONVERSATION_LIMIT = 100;

export const DASHBOARD_CONVERSATION_ORDER =
  "c.last_message_at DESC, c.id DESC";

export type DashboardConversationScope = {
  sql: string;
  bindings: string[];
};

/**
 * Builds the message-side scope from the exact conversation IDs selected by
 * the dashboard query. Reusing the IDs avoids a second top-N query choosing a
 * different row when several conversations have the same activity timestamp.
 */
export function dashboardConversationScope(
  conversationIds: readonly string[],
): DashboardConversationScope {
  if (conversationIds.length === 0) {
    return { sql: "1 = 0", bindings: [] };
  }
  return {
    sql: `m.conversation_id IN (${conversationIds.map(() => "?").join(", ")})`,
    bindings: [...conversationIds],
  };
}
