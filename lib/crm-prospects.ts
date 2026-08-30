import type { CrmDatabase } from "./d1";
import { optionalTrimmedString, validIsoTimestamp } from "./http";

export const INTERACTION_KINDS = [
  "call",
  "email",
  "meeting",
  "note",
  "other",
] as const;

export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export type InteractionInput = {
  dealId: string;
  kind: InteractionKind;
  summary: string;
  occurredAt: string;
};

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string };

export function parseInteractionInput(
  payload: Record<string, unknown>,
  now = new Date(),
): ParseResult<InteractionInput> {
  const dealId = entityId(payload.dealId);
  const summary = optionalTrimmedString(payload.summary, 5_000);
  const kind =
    typeof payload.kind === "string" &&
    INTERACTION_KINDS.includes(payload.kind as InteractionKind)
      ? (payload.kind as InteractionKind)
      : null;
  const occurredAt =
    payload.occurredAt === undefined
      ? now.toISOString()
      : validIsoTimestamp(payload.occurredAt);

  if (!dealId) return { ok: false, code: "deal_id_invalid" };
  if (!kind) return { ok: false, code: "interaction_kind_invalid" };
  if (!summary) return { ok: false, code: "interaction_summary_invalid" };
  if (!occurredAt) return { ok: false, code: "interaction_date_invalid" };

  return {
    ok: true,
    value: { dealId, kind, summary, occurredAt },
  };
}

export async function createInteraction(
  db: CrmDatabase,
  input: InteractionInput,
  actorEmail: string,
) {
  const deal = await db
    .prepare(
      `SELECT COALESCE(d.contact_id, c.contact_id) AS contactId,
              d.organization_id AS organizationId
       FROM deals d
       JOIN conversations c ON c.id = d.conversation_id
       WHERE d.id = ?
       LIMIT 1`,
    )
    .bind(input.dealId)
    .first<{ contactId: string | null; organizationId: string | null }>();
  if (!deal) return null;
  if (!deal.contactId && !deal.organizationId) {
    throw new Error("interaction_parent_missing");
  }

  const id = crypto.randomUUID();
  const recordsContact = input.kind === "call" || input.kind === "email" || input.kind === "meeting";
  await db.batch([
    db
      .prepare(
        `INSERT INTO interactions
          (id, organization_id, contact_id, deal_id, kind, summary, occurred_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        deal.organizationId,
        deal.contactId,
        input.dealId,
        input.kind,
        input.summary,
        input.occurredAt,
        actorEmail,
      ),
    db
      .prepare(
        `INSERT INTO audit_entries
          (id, actor_email, action, entity_type, entity_id, details_json)
         VALUES (?, ?, 'interaction.created', 'interaction', ?, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        actorEmail,
        id,
        JSON.stringify({ dealId: input.dealId, kind: input.kind }),
      ),
    ...(recordsContact && deal.contactId ? [
      db.prepare("UPDATE contacts SET last_contact_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(input.occurredAt, deal.contactId),
    ] : []),
    ...(recordsContact && deal.organizationId ? [
      db.prepare("UPDATE organizations SET last_contact_at=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(input.occurredAt, deal.organizationId),
    ] : []),
  ]);
  return { id, contactId: deal.contactId, organizationId: deal.organizationId, ...input };
}

function entityId(value: unknown): string | null {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/u.test(value)
    ? value
    : null;
}
