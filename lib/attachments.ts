export type AttachmentScanStatus =
  | "unscanned"
  | "clean"
  | "infected"
  | "rejected";

export type AttachmentDownloadDecision =
  | { allowed: true }
  | {
      allowed: false;
      status: 403 | 423;
      code: "attachment_unscanned" | "attachment_blocked";
    };

export function attachmentDownloadDecision(
  scanStatus: string,
): AttachmentDownloadDecision {
  if (scanStatus === "clean") return { allowed: true };
  if (scanStatus === "unscanned") {
    return { allowed: false, status: 423, code: "attachment_unscanned" };
  }
  return { allowed: false, status: 403, code: "attachment_blocked" };
}
