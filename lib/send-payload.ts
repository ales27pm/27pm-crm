import { CRM_MAILBOXES, mailboxForAddress } from "./mailboxes";

type SendPayload = Record<string, unknown>;

export function sendMailboxFromPayload(payload: SendPayload) {
  const mailboxValue = mailboxValueFromPayload(payload);
  const mailbox =
    CRM_MAILBOXES.find((candidate) => candidate.id === mailboxValue) ??
    mailboxForAddress(mailboxValue);
  return { mailbox, mailboxValue };
}

export function sendContentFromPayload(payload: SendPayload) {
  return {
    subject: subjectFromPayload(payload.subject),
    text: textBodyFromPayload(payload),
    html: trimmedString(payload.html),
    conversationId: stringValue(payload.conversationId),
  };
}

function mailboxValueFromPayload(payload: SendPayload): string {
  const mailbox = trimmedString(payload.mailbox);
  if (mailbox !== null) return mailbox;
  return trimmedString(payload.from) ?? "";
}

function subjectFromPayload(value: unknown): string {
  const subject = stringValue(value);
  return subject === null ? "" : subject.replace(/[\r\n]+/gu, " ").trim();
}

function textBodyFromPayload(payload: SendPayload): string | null {
  const text = trimmedString(payload.text);
  return text === null ? trimmedString(payload.body) : text;
}

function trimmedString(value: unknown): string | null {
  const string = stringValue(value);
  return string === null ? null : string.trim();
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
