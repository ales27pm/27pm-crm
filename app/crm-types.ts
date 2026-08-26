import type {
  MessageDeliveryState,
  OutboundDeliveryState,
} from "@/lib/mailgun-lifecycle";

export type MailboxKind = "sales" | "operations";
export type TransportState = "operational" | "configuration" | "degraded";
export type NavView =
  | "inbox"
  | "contacts"
  | "pipeline"
  | "projects"
  | "tasks"
  | "settings";
export type PipelineStage =
  | "nouveau"
  | "qualifie"
  | "proposition"
  | "production"
  | "gagne";

export type Mailbox = {
  address: string;
  label: string;
  kind: MailboxKind;
  unreadCount: number;
};

export type CrmMessage = {
  id: string;
  direction: "inbound" | "outbound";
  senderName: string;
  senderEmail: string;
  recipientLabel: string;
  sentAt: string;
  sentAtIso: string;
  body: string;
  deliveryState: MessageDeliveryState;
  deliveryEvents: CrmDeliveryEvent[];
};

export type CrmDeliveryEvent = {
  state: OutboundDeliveryState;
  occurredAt: string;
  occurredLabel: string;
};

export type Conversation = {
  id: string;
  mailboxAddress: string;
  contactId: string;
  contactName: string;
  contactEmail: string;
  organization: string;
  subject: string;
  preview: string;
  updatedLabel: string;
  unread: boolean;
  followUp: boolean;
  messages: CrmMessage[];
  dealId: string | null;
};

export type Contact = {
  id: string;
  name: string;
  email: string;
  organization: string;
  source: string;
  status: string;
  conversationCount: number;
};

export type Deal = {
  id: string;
  contactId: string;
  conversationId: string;
  title: string;
  contactName: string;
  organization: string;
  projectType: "Site web" | "Application" | "Produit numérique";
  stage: PipelineStage;
  source: string;
  nextAction: string;
  nextActionDate: string;
  note: string;
};

export type CrmTask = {
  id: string;
  title: string;
  dueLabel: string;
  completed: boolean;
  dealId: string | null;
};

export type DashboardData = {
  mailboxes: Mailbox[];
  transportState: TransportState;
  conversations: Conversation[];
  contacts: Contact[];
  deals: Deal[];
  tasks: CrmTask[];
  live: boolean;
};
