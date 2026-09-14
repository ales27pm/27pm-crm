import type { CrmDatabase } from "./d1";
import { normalizeEmailAddress } from "./mailboxes";

export const OPERATIONAL_REPLY_MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;

export type OperationalReplyEvidence = {
  conversationId: string;
  conversationSubject: string;
  mailboxId: string;
  mailboxAddress: string;
  contactId: string;
  contactComplianceVersion: number;
  recipient: string;
  inboundMessageId: string;
  inboundExternalMessageId: string;
  inboundOccurredAt: string;
  inboundCreatedAt: string;
};

export type OperationalReplyApproval = {
  conversationId: string;
  conversationSubject: string;
  mailboxId: string;
  mailboxAddress: string;
  recipient: string;
  inboundMessageId: string;
  inboundExternalMessageId: string;
  text: string;
};

type OperationalReplyRow = {
  conversationId: string;
  conversationSubject: string;
  mailboxId: string;
  mailboxAddress: string;
  mailboxPurpose: string;
  mailboxIsActive: number | boolean;
  contactId: string;
  contactComplianceVersion: number;
  recipient: string;
  contactDeletedAt: string | null;
  contactDoNotContact: number | boolean;
  contactUnsubscribedAt: string | null;
  contactEmailStatus: string;
  personalDataCategory: string;
  qualificationMode: string;
  organizationDeletedAt: string | null;
  organizationDoNotContact: number | boolean | null;
  inboundMessageId: string;
  inboundDirection: string;
  inboundStatus: string;
  inboundTransportProvider: string;
  inboundSender: string;
  inboundExternalMessageId: string | null;
  inboundOccurredAt: string;
  inboundCreatedAt: string;
  inboundReplyTo: string | null;
  inboundText: string | null;
  inboundHtml: string | null;
  suppressionCount: number;
};

export async function loadOperationalReplyEvidence(
  db: CrmDatabase,
  input: {
    conversationId: string;
    conversationSubject: string;
    mailboxId: string;
    mailboxAddress: string;
    recipient: string;
  },
  now = new Date(),
): Promise<OperationalReplyEvidence | null> {
  const recipient = normalizeEmailAddress(input.recipient);
  if (!recipient || recipient !== input.recipient) return null;
  const row = await db.prepare(
    `SELECT conversation.id AS conversationId,
            conversation.subject AS conversationSubject,
            conversation.mailbox_id AS mailboxId,
            lower(trim(mailbox.address)) AS mailboxAddress,
            mailbox.purpose AS mailboxPurpose,
            mailbox.is_active AS mailboxIsActive,
            contact.id AS contactId,
            contact.compliance_version AS contactComplianceVersion,
            lower(trim(contact.email)) AS recipient,
            contact.deleted_at AS contactDeletedAt,
            contact.do_not_contact AS contactDoNotContact,
            contact.unsubscribed_at AS contactUnsubscribedAt,
            contact.email_status AS contactEmailStatus,
            contact.personal_data_category AS personalDataCategory,
            contact.qualification_mode AS qualificationMode,
            organization.deleted_at AS organizationDeletedAt,
            organization.do_not_contact AS organizationDoNotContact,
            inbound.id AS inboundMessageId,
            inbound.direction AS inboundDirection,
            inbound.status AS inboundStatus,
            inbound.transport_provider AS inboundTransportProvider,
            lower(trim(inbound.sender)) AS inboundSender,
            inbound.external_message_id AS inboundExternalMessageId,
            inbound.occurred_at AS inboundOccurredAt,
            inbound.created_at AS inboundCreatedAt,
            lower(trim(inbound.reply_to)) AS inboundReplyTo,
            inbound.text_body AS inboundText,
            inbound.html_body AS inboundHtml,
            (SELECT COUNT(*) FROM contact_suppressions suppression
              WHERE suppression.channel='email'
                AND suppression.address_normalized=lower(trim(contact.email))) AS suppressionCount
       FROM conversations conversation
       JOIN mailboxes mailbox ON mailbox.id=conversation.mailbox_id
       JOIN contacts contact ON contact.id=conversation.contact_id
       LEFT JOIN organizations organization ON organization.id=contact.organization_id
       JOIN messages inbound ON inbound.id=(
         SELECT message.id FROM messages message
          WHERE message.conversation_id=conversation.id
          ORDER BY datetime(message.created_at) DESC, message.rowid DESC
          LIMIT 1
       )
      WHERE conversation.id=? LIMIT 1`,
  ).bind(input.conversationId).first<OperationalReplyRow>();

  if (!row || !validOperationalReplyRow(row, input, recipient, now)) return null;
  return {
    conversationId: row.conversationId,
    conversationSubject: row.conversationSubject,
    mailboxId: row.mailboxId,
    mailboxAddress: row.mailboxAddress,
    contactId: row.contactId,
    contactComplianceVersion: row.contactComplianceVersion,
    recipient: row.recipient,
    inboundMessageId: row.inboundMessageId,
    inboundExternalMessageId: row.inboundExternalMessageId!,
    inboundOccurredAt: row.inboundOccurredAt,
    inboundCreatedAt: row.inboundCreatedAt,
  };
}

export async function advanceOperationalReplyAuthorization(
  db: CrmDatabase,
  commandId: string,
  evidence: OperationalReplyEvidence,
  approvalDigest: string,
  operatorEmail: string,
  fromStatus: "pending" | "authorized",
  toStatus: "authorized" | "dispatching",
  now = new Date(),
): Promise<boolean> {
  if (
    (fromStatus !== "pending" || toStatus !== "authorized") &&
    (fromStatus !== "authorized" || toStatus !== "dispatching")
  ) return false;
  const timestamp = now.toISOString();
  const cutoff = new Date(now.valueOf() - OPERATIONAL_REPLY_MAX_AGE_MS).toISOString();
  const result = await db.prepare(
    `UPDATE send_commands
        SET status=?,
            authorized_at=COALESCE(authorized_at, ?),
            dispatched_at=CASE WHEN ?='dispatching' THEN ? ELSE dispatched_at END,
            updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status=? AND transport_provider='mailgun'
        AND mailbox_id=? AND conversation_id=? AND contact_id=?
        AND contact_compliance_version=?
        AND operator_confirmed_at IS NOT NULL
        AND compliance_snapshot_json IS NOT NULL
        AND json_extract(compliance_snapshot_json, '$.operator.email')=?
        AND json_extract(
          compliance_snapshot_json,
          '$.evidence.operationalReply.inboundMessageId'
        )=?
        AND json_extract(compliance_snapshot_json, '$.approvalDigest')=?
        AND NOT EXISTS (
          SELECT 1 FROM send_commands other
           WHERE other.id<>send_commands.id
             AND other.transport_provider='mailgun'
             AND other.mailbox_id=send_commands.mailbox_id
             AND other.conversation_id=send_commands.conversation_id
             AND other.status IN ('authorized','dispatching','sent')
             AND json_extract(
               other.compliance_snapshot_json,
               '$.evidence.operationalReply.inboundMessageId'
             )=?
        )
        AND send_commands.id=(
          SELECT candidate.id FROM send_commands candidate
           WHERE candidate.transport_provider='mailgun'
             AND candidate.mailbox_id=send_commands.mailbox_id
             AND candidate.conversation_id=send_commands.conversation_id
             AND candidate.status=?
             AND json_extract(
               candidate.compliance_snapshot_json,
               '$.evidence.operationalReply.inboundMessageId'
             )=?
           ORDER BY datetime(candidate.created_at), candidate.rowid
           LIMIT 1
        )
        AND EXISTS (
          SELECT 1
            FROM conversations conversation
            JOIN mailboxes mailbox ON mailbox.id=conversation.mailbox_id
            JOIN contacts contact ON contact.id=conversation.contact_id
            LEFT JOIN organizations organization ON organization.id=contact.organization_id
            JOIN messages inbound ON inbound.id=?
           WHERE conversation.id=?
             AND conversation.mailbox_id=?
             AND lower(trim(mailbox.address))=?
             AND conversation.subject=?
             AND mailbox.purpose='operations'
             AND mailbox.is_active=1
             AND contact.id=?
             AND contact.compliance_version=?
             AND lower(trim(contact.email))=?
             AND contact.deleted_at IS NULL
             AND contact.do_not_contact=0
             AND contact.unsubscribed_at IS NULL
             AND contact.email_status IN ('unknown','valid')
             AND contact.personal_data_category='work_contact'
             AND contact.qualification_mode<>'fully_automated'
             AND (organization.id IS NULL OR
               (organization.deleted_at IS NULL AND organization.do_not_contact=0))
             AND inbound.conversation_id=conversation.id
             AND inbound.mailbox_id=conversation.mailbox_id
             AND inbound.direction='inbound'
             AND inbound.status='received'
             AND inbound.transport_provider='mailgun'
             AND lower(trim(inbound.sender))=?
             AND inbound.external_message_id=?
             AND inbound.occurred_at=?
             AND inbound.created_at=?
             AND (inbound.reply_to IS NULL OR lower(trim(inbound.reply_to))=?)
             AND julianday(inbound.created_at)>=julianday(?)
             AND julianday(inbound.created_at)<=julianday(?)
             AND (length(trim(COALESCE(inbound.text_body,'')))>0 OR
               length(trim(COALESCE(inbound.html_body,'')))>0)
             AND inbound.id=(
               SELECT message.id FROM messages message
                WHERE message.conversation_id=conversation.id
                ORDER BY datetime(message.created_at) DESC, message.rowid DESC
                LIMIT 1
             )
        )
        AND NOT EXISTS (
          SELECT 1 FROM contact_suppressions suppression
           WHERE suppression.channel='email'
             AND suppression.address_normalized=?
        )`,
  ).bind(
    toStatus,
    timestamp,
    toStatus,
    timestamp,
    commandId,
    fromStatus,
    evidence.mailboxId,
    evidence.conversationId,
    evidence.contactId,
    evidence.contactComplianceVersion,
    operatorEmail,
    evidence.inboundMessageId,
    approvalDigest,
    evidence.inboundMessageId,
    fromStatus,
    evidence.inboundMessageId,
    evidence.inboundMessageId,
    evidence.conversationId,
    evidence.mailboxId,
    evidence.mailboxAddress,
    evidence.conversationSubject,
    evidence.contactId,
    evidence.contactComplianceVersion,
    evidence.recipient,
    evidence.recipient,
    evidence.inboundExternalMessageId,
    evidence.inboundOccurredAt,
    evidence.inboundCreatedAt,
    evidence.recipient,
    cutoff,
    timestamp,
    evidence.recipient,
  ).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function operationalReplyApprovalDigest(
  approval: OperationalReplyApproval,
): Promise<string> {
  const canonical = JSON.stringify({
    version: 1,
    conversationId: approval.conversationId,
    conversationSubject: approval.conversationSubject,
    mailboxId: approval.mailboxId,
    mailboxAddress: approval.mailboxAddress,
    recipient: approval.recipient,
    inboundMessageId: approval.inboundMessageId,
    inboundExternalMessageId: approval.inboundExternalMessageId,
    text: approval.text,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function operationalReplyApprovalMatches(
  actualDigest: string,
  configuredDigest: string | null,
): boolean {
  return Boolean(
    configuredDigest &&
    /^[a-f0-9]{64}$/u.test(configuredDigest) &&
    actualDigest === configuredDigest,
  );
}

function validOperationalReplyRow(
  row: OperationalReplyRow,
  input: {
    conversationId: string;
    conversationSubject: string;
    mailboxId: string;
    mailboxAddress: string;
    recipient: string;
  },
  recipient: string,
  now: Date,
): boolean {
  const createdAt = serverTimestamp(row.inboundCreatedAt);
  const age = now.valueOf() - createdAt.valueOf();
  return row.conversationId === input.conversationId &&
    row.conversationSubject === input.conversationSubject &&
    row.mailboxId === input.mailboxId &&
    row.mailboxAddress === input.mailboxAddress &&
    row.mailboxPurpose === "operations" &&
    Boolean(row.mailboxIsActive) &&
    row.recipient === recipient &&
    row.inboundDirection === "inbound" &&
    row.inboundStatus === "received" &&
    row.inboundTransportProvider === "mailgun" &&
    row.inboundSender === recipient &&
    (!row.inboundReplyTo || row.inboundReplyTo === recipient) &&
    Boolean(row.inboundExternalMessageId) &&
    Boolean(row.inboundText?.trim() || row.inboundHtml?.trim()) &&
    Number.isFinite(createdAt.valueOf()) &&
    age >= 0 &&
    age <= OPERATIONAL_REPLY_MAX_AGE_MS &&
    !row.contactDeletedAt &&
    !Boolean(row.contactDoNotContact) &&
    !row.contactUnsubscribedAt &&
    ["unknown", "valid"].includes(row.contactEmailStatus) &&
    row.personalDataCategory === "work_contact" &&
    row.qualificationMode !== "fully_automated" &&
    !row.organizationDeletedAt &&
    !Boolean(row.organizationDoNotContact) &&
    Number(row.suppressionCount) === 0;
}

function serverTimestamp(value: string): Date {
  return new Date(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/u.test(value)
    ? `${value.replace(" ", "T")}Z`
    : value);
}
