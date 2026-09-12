import { requireOperatorRequest } from "@/lib/api-auth";
import { crmDatabase } from "@/lib/d1";
import {
  classifyDeliverabilityEvent,
  reputationDailyVolumeCeiling,
  REPUTATION_MODES,
  type DeliverabilityEventClass,
  type MailboxProvider,
  type ReputationMode,
} from "@/lib/deliverability-policy";
import {
  summarizeDeliverability,
  type DeliverabilityTelemetryEvent,
  type DeliverabilityTelemetryMessage,
} from "@/lib/deliverability-metrics";
import {
  parseDeliverabilityWindow,
  type DeliverabilityWindow,
} from "@/lib/deliverability-window";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";

const MESSAGE_LIMIT = 10_000;
const EVENT_LIMIT = 50_000;
const CAVEATS = [
  "Un événement delivered confirme la remise au serveur destinataire, pas le placement en boîte de réception.",
  "Les pourcentages locaux utilisent des messages uniques; les faibles volumes restent des données insuffisantes et exigent une revue humaine.",
  "Le taux de spam Gmail et le placement Inbox/Junk proviennent de sources externes et ne sont pas déduits des événements Mailgun.",
];

const WINDOW_DURATIONS: Record<DeliverabilityWindow, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

type MessageRow = {
  id: string;
  recipientsJson: string;
  status: string;
  trafficType: string;
  tagsJson: string;
  occurredAt: string;
};

type EventRow = {
  messageId: string;
  eventType: string;
  severity: string | null;
  reason: string | null;
  failureClass: string | null;
  mailboxProvider: string | null;
  sendingDomain: string | null;
  sendingIp: string | null;
  smtpCode: number | null;
  enhancedStatusCode: string | null;
  smtpDescription: string | null;
  tagsJson: string;
  eventTimestamp: string;
};

export async function GET(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;

  const windowName = parseDeliverabilityWindow(
    new URL(request.url).searchParams.get("window"),
  );
  if (!windowName) return deliverabilityError(400, "deliverability_window_invalid");
  const generatedAt = new Date();
  const windowStart = new Date(
    generatedAt.valueOf() - windowDurationMs(windowName),
  );

  try {
    return await buildDeliverabilityResponse(windowName, generatedAt, windowStart);
  } catch {
    return deliverabilityError(500, "deliverability_unavailable");
  }
}

async function buildDeliverabilityResponse(
  windowName: DeliverabilityWindow,
  generatedAt: Date,
  windowStart: Date,
): Promise<Response> {
  const { eventRows, messageRows } = await loadTelemetryRows(windowStart);
  const messagesTruncated = messageRows.length > MESSAGE_LIMIT;
  const eventsTruncated = eventRows.length > EVENT_LIMIT;
  const eventsByMessage = groupEventObservations(eventRows.slice(0, EVENT_LIMIT));
  const messages = telemetryMessages(
    messageRows.slice(0, MESSAGE_LIMIT),
    eventsByMessage,
  );

  return Response.json(
    {
      generatedAt: generatedAt.toISOString(),
      window: {
        name: windowName,
        startsAt: windowStart.toISOString(),
        endsAt: generatedAt.toISOString(),
      },
      reputation: reputationConfiguration(),
      summary: summarizeDeliverability(messages),
      completeness: {
        complete: !messagesTruncated && !eventsTruncated,
        messagesTruncated,
        eventsTruncated,
        messageLimit: MESSAGE_LIMIT,
        eventLimit: EVENT_LIMIT,
      },
      caveats: CAVEATS,
    },
    { headers: noStoreHeaders() },
  );
}

async function loadTelemetryRows(windowStart: Date) {
  const db = crmDatabase();
  const [messages, events] = await Promise.all([
    db
      .prepare(
        `SELECT id, recipients_json AS recipientsJson, status,
                traffic_type AS trafficType, tags_json AS tagsJson,
                occurred_at AS occurredAt
         FROM messages
         WHERE direction='outbound' AND occurred_at >= ?
         ORDER BY occurred_at DESC, rowid DESC
         LIMIT ?`,
      )
      .bind(windowStart.toISOString(), MESSAGE_LIMIT + 1)
      .all<MessageRow>(),
    db
      .prepare(
        `SELECT event.message_id AS messageId,
                event.event_type AS eventType, event.severity, event.reason,
                event.failure_class AS failureClass,
                event.mailbox_provider AS mailboxProvider,
                event.sending_domain AS sendingDomain,
                event.sending_ip AS sendingIp,
                event.smtp_code AS smtpCode,
                event.enhanced_status_code AS enhancedStatusCode,
                event.smtp_description AS smtpDescription,
                event.tags_json AS tagsJson,
                event.event_timestamp AS eventTimestamp
         FROM message_events event
         JOIN messages message ON message.id=event.message_id
         WHERE message.direction='outbound' AND message.occurred_at >= ?
         ORDER BY event.event_timestamp, event.rowid
         LIMIT ?`,
      )
      .bind(windowStart.toISOString(), EVENT_LIMIT + 1)
      .all<EventRow>(),
  ]);
  return { eventRows: events.results, messageRows: messages.results };
}

function groupEventObservations(rows: EventRow[]) {
  const eventsByMessage = new Map<string, DeliverabilityTelemetryEvent[]>();
  for (const row of rows) {
    const current = eventsByMessage.get(row.messageId) ?? [];
    current.push(eventObservation(row));
    eventsByMessage.set(row.messageId, current);
  }
  return eventsByMessage;
}

function telemetryMessages(
  rows: MessageRow[],
  eventsByMessage: Map<string, DeliverabilityTelemetryEvent[]>,
): DeliverabilityTelemetryMessage[] {
  return rows.map((row) => ({
    id: row.id,
    recipient: singleRecipient(row.recipientsJson),
    trafficType: safeTrafficType(row.trafficType),
    tags: safeTags(row.tagsJson),
    status: row.status,
    occurredAt: row.occurredAt,
    events: eventsByMessage.get(row.id) ?? [],
  }));
}

function eventObservation(row: EventRow): DeliverabilityTelemetryEvent {
  const eventClass = validEventClass(row.failureClass)
    ? row.failureClass
    : classifyDeliverabilityEvent({
        event: row.eventType,
        severity: row.severity,
        reason: row.reason,
        smtpCode: row.smtpCode,
        enhancedStatusCode: row.enhancedStatusCode,
        description: row.smtpDescription,
      });
  return {
    eventType: row.eventType,
    reason: row.reason,
    eventClass,
    mailboxProvider: validMailboxProvider(row.mailboxProvider)
      ? row.mailboxProvider
      : null,
    sendingDomain: safeDimension(row.sendingDomain),
    sendingIp: safeIp(row.sendingIp),
    tags: safeTags(row.tagsJson),
    occurredAt: row.eventTimestamp,
  };
}

function windowDurationMs(value: DeliverabilityWindow): number {
  return WINDOW_DURATIONS[value];
}

function singleRecipient(value: string): string {
  const recipients = parsedJson(value);
  if (!Array.isArray(recipients) || recipients.length !== 1) return "";
  const [recipient] = recipients;
  return typeof recipient === "string" ? recipient.trim().toLowerCase() : "";
}

function safeTags(value: string): string[] {
  const tags = parsedJson(value);
  return Array.isArray(tags)
    ? [...new Set(tags.filter(isSafeTag))].slice(0, 32).toSorted()
    : [];
}

function parsedJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    // Malformed storage remains unclassified and is never reflected to clients.
    return null;
  }
}

function isSafeTag(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 64 &&
    /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(value)
  );
}

function safeTrafficType(value: string): string {
  return [
    "unclassified",
    "administrative",
    "transactional",
    "prospecting",
    "marketing",
  ].includes(value)
    ? value
    : "unclassified";
}

function validMailboxProvider(value: string | null): value is MailboxProvider {
  return value === "google" || value === "microsoft" || value === "yahoo" || value === "other";
}

function validEventClass(value: string | null): value is DeliverabilityEventClass {
  return [
    "accepted_transport",
    "delivered_transport",
    "hard_bounce",
    "complaint",
    "unsubscribe",
    "temporary",
    "policy_block",
    "auth_failure",
    "other_permanent",
    "unknown",
  ].includes(value ?? "");
}

function safeDimension(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9.-]{0,252}$/u.test(normalized)
    ? normalized
    : null;
}

function safeIp(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return /^[0-9a-f:.]{3,45}$/u.test(normalized) ? normalized : null;
}

function reputationConfiguration() {
  const mode = reputationMode(runtimeString("CRM_REPUTATION_MODE"));
  const rampDay = positiveInteger(runtimeString("CRM_REPUTATION_RAMP_DAY"));
  const configuredCap = nonNegativeInteger(
    runtimeString("CRM_REPUTATION_DAILY_CAP"),
  );
  return {
    mode,
    rampDay,
    dailyCap: configuredCap ?? warmupVolumeCeiling(mode, rampDay),
    automaticAdvancement: false,
    trackingEnabled: false,
    bulkSendingAvailable: false,
  };
}

function reputationMode(value: string | null): ReputationMode {
  return (REPUTATION_MODES as readonly string[]).includes(value ?? "")
    ? (value as ReputationMode)
    : "normal";
}

function warmupVolumeCeiling(
  mode: ReputationMode,
  rampDay: number | null,
): number | null {
  if (mode !== "dedicated_ip_warmup" || rampDay === null) return null;
  return reputationDailyVolumeCeiling(mode, rampDay);
}

function positiveInteger(value: string | null): number | null {
  return boundedInteger(value, 1);
}

function nonNegativeInteger(value: string | null): number | null {
  return boundedInteger(value, 0);
}

function boundedInteger(value: string | null, minimum: number): number | null {
  const parsed = /^\d+$/u.test(String(value)) ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= minimum ? parsed : null;
}

function noStoreHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}

function deliverabilityError(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders() });
}
