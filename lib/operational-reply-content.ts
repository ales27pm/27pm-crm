export type OperationalReplyContent = {
  text: string;
  html: string;
  unsubscribeUrl: undefined;
};

/**
 * Builds the transport representation of an approved, plain-text operational
 * reply without adding marketing copy, tracking, or unsubscribe metadata.
 */
export function operationalReplyContent(text: string): OperationalReplyContent {
  if (!text.trim() || text !== text.trim()) {
    throw new Error("operational_reply_content_invalid");
  }
  return {
    text,
    html: text
      .split(/\n{2,}/gu)
      .map((paragraph) =>
        `<p>${escapeHtml(paragraph).replace(/\n/gu, "<br>")}</p>`
      )
      .join(""),
    unsubscribeUrl: undefined,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}
