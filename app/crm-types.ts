import type {
  MessageDeliveryState,
  OutboundDeliveryState,
} from "@/lib/mailgun-lifecycle";

export type MailboxKind = "sales" | "operations";
export type TransportState = "operational" | "configuration" | "degraded";
export type NavView =
  | "today"
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
  phone: string;
  organization: string;
  organizationId: string;
  role: string;
  source: string;
  sourceUrl: string | null;
  sourceDate: string | null;
  contactBasis: string;
  roleRelevance: string;
  roleRelevanceDetail?: string;
  personalDataCategory?: string;
  qualificationMode?: string;
  provenanceType?: string;
  evidenceRef?: string | null;
  lawfulBasis?: string;
  basisEvidenceRef?: string | null;
  basisVerifiedBy?: string | null;
  basisVerifiedAt?: string | null;
  basisExpiresAt?: string | null;
  publicationByRecipient?: boolean;
  publicationNoRestriction?: boolean;
  publicationRoleRelevance?: string;
  directDisclosureNoRestriction?: boolean;
  b2bRelationshipEvidence?: string;
  b2bMessageRelevance?: string;
  phoneEvidenceRef?: string | null;
  recipientTimezone?: string | null;
  dnclCheckedAt?: string | null;
  dnclEvidenceRef?: string | null;
  dnclStatus: string;
  emailStatus: string;
  unsubscribed: boolean;
  doNotCall: boolean;
  doNotContact: boolean;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  validated: boolean;
  emailReady: boolean;
  emailBlockReasons: string[];
  emailEvaluatedAt: string | null;
  status: string;
  conversationCount: number;
};

export type Organization = {
  id: string;
  name: string;
  website: string | null;
  sourceLabel: string;
  sourceUrl: string | null;
  sourceDate: string | null;
  score: number | null;
  priority: "very_high" | "high" | "normal" | "low";
  budgetMinCents: number | null;
  budgetMaxCents: number | null;
  budgetIsHypothesis: boolean;
  ownerEmail: string | null;
  doNotContact: boolean;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  nextStep: string | null;
  notes: string;
  contactCount: number;
};

export type IntakeSubmission = {
  id: string; organizationName: string; contactName: string; contactEmail: string;
  projectType: string | null; message: string; createdAt: string; createdLabel: string;
};

export type CrmInteraction = {
  id: string;
  kind: "call" | "email" | "meeting" | "note" | "other";
  summary: string;
  occurredAt: string;
  occurredLabel: string;
  createdBy: string;
};

export type Deal = {
  id: string;
  organizationId: string;
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
  interactions: CrmInteraction[];
};

export type CrmTask = {
  id: string;
  title: string;
  dueLabel: string;
  dueAt: string | null;
  overdue: boolean;
  completed: boolean;
  dealId: string | null;
  conversationId: string | null;
  organizationId: string;
  organization: string;
};

export type OutreachStep = {
  id: string;
  sequenceIndex: number;
  businessDayOffset: number;
  actionType: "research" | "review" | "email" | "call" | "nurture";
  title: string;
  purpose: string;
  requiresContact: boolean;
  status: "planned" | "ready" | "blocked" | "done" | "skipped";
  scheduledAt: string;
  scheduledLabel: string;
  completedAt: string | null;
};

export type OutreachStrategy = {
  id: string;
  organizationId: string;
  organization: string;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  version: number;
  status: "draft" | "ready" | "active" | "paused" | "completed" | "archived";
  objective: string;
  targetName: string | null;
  targetRole: string;
  valueProposition: string;
  openingAngle: string;
  timingRationale: string;
  contactResearchNotes: string;
  recommendedStartAt: string;
  recipientTimezone: string;
  researchSource: string;
  researchSourceUrl: string | null;
  researchCapturedAt: string | null;
  emailReady: boolean;
  emailBlockReasons: string[];
  steps: OutreachStep[];
};

export type ActivityEntry = {
  id: string; actorEmail: string; action: string; entityType: string;
  entityId: string; createdAt: string; createdLabel: string;
};

export type DashboardData = {
  mailboxes: Mailbox[];
  transportState: TransportState;
  conversations: Conversation[];
  organizations: Organization[];
  contacts: Contact[];
  deals: Deal[];
  tasks: CrmTask[];
  strategies: OutreachStrategy[];
  intakes: IntakeSubmission[];
  activities: ActivityEntry[];
  live: boolean;
};
