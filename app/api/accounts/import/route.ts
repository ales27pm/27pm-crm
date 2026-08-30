import { requireOperatorRequest } from "@/lib/api-auth";
import { classifyAccountImportResult } from "@/lib/account-import";
import { parseAccountInput } from "@/lib/crm-accounts";
import { crmDatabase } from "@/lib/d1";
import { jsonError, optionalTrimmedString, readJsonObject } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = requireOperatorRequest(request);
  if (auth.response) return auth.response;
  const payload = await readJsonObject(request);
  if (!payload) return jsonError(400, "request_body_invalid");
  const importKey = key(payload.importKey);
  const sourceLabel = optionalTrimmedString(payload.sourceLabel, 200);
  const records = Array.isArray(payload.accounts) ? payload.accounts : null;
  if (!importKey || !sourceLabel || !records || records.length < 1 || records.length > 500) return jsonError(400, "account_import_invalid");
  const parsed = records.map((record) => record && typeof record === "object" && !Array.isArray(record) ? parseAccountInput({ sourceUrl: payload.sourceUrl, sourceDate: payload.sourceDate, ...(record as Record<string, unknown>), sourceLabel }) : { ok: false as const, code: "account_record_invalid" });
  const invalid = parsed.find((result) => !result.ok);
  if (invalid && !invalid.ok) return jsonError(400, invalid.code);
  try {
    const db = crmDatabase();
    const requestHash = await shortHash(JSON.stringify({ sourceLabel, sourceUrl: optionalText(payload.sourceUrl), sourceDate: optionalText(payload.sourceDate), accounts: parsed.map((result) => result.ok ? result.value : null) }));
    const existing = await db.prepare("SELECT record_count AS recordCount, request_hash AS requestHash FROM account_imports WHERE import_key=? LIMIT 1").bind(importKey).first<{ recordCount: number; requestHash: string | null }>();
    if (existing) {
      if (!existing.requestHash) return jsonError(409, "account_import_key_unverifiable");
      if (existing.requestHash !== requestHash) return jsonError(409, "account_import_key_reused");
      return Response.json({ imported: false, idempotent: true, recordCount: Number(existing.recordCount) });
    }
    const existingAccounts = await db.prepare("SELECT name FROM organizations").all<{ name: string }>();
    const seenNames = new Set(existingAccounts.results.map((account) => normalizedName(account.name)));
    const importId = crypto.randomUUID();
    const statements = [db.prepare(`INSERT OR IGNORE INTO account_imports (id, import_key, request_hash, source_label, source_url, source_date, record_count, actor_email) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(importId, importKey, requestHash, sourceLabel, optionalText(payload.sourceUrl), optionalText(payload.sourceDate), records.length, auth.operator.email)];
    for (let index = 0; index < parsed.length; index += 1) {
      const result = parsed[index];
      if (!result.ok) continue;
      const account = result.value;
      const accountNameKey = normalizedName(account.name);
      if (seenNames.has(accountNameKey)) continue;
      seenNames.add(accountNameKey);
      const externalKey = `import-account:${await shortHash(accountNameKey)}`;
      const id = `org-${await shortHash(externalKey)}`;
      const conversationId = `conversation-${await shortHash(externalKey)}`;
      const dealId = `deal-${await shortHash(externalKey)}`;
      statements.push(
        db.prepare(`INSERT OR IGNORE INTO organizations (id, external_key, name, website, source_label, source_url, source_date, score, priority, budget_min_cents, budget_max_cents, owner_email, do_not_contact, next_follow_up_at, next_step, notes, sort_order)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM account_imports WHERE id=? AND request_hash=?)`).bind(id, externalKey, account.name, account.website, account.sourceLabel, account.sourceUrl, account.sourceDate, account.score, account.priority, account.budgetMinCents, account.budgetMaxCents, account.ownerEmail, account.doNotContact ? 1 : 0, account.nextFollowUpAt, account.nextStep, account.notes, index + 1, importId, requestHash),
        db.prepare(`INSERT OR IGNORE INTO conversations (id, mailbox_id, contact_id, subject, normalized_subject, thread_key, is_unread, follow_up_state, follow_up_at, last_message_at)
          SELECT ?, 'mailbox_bonjour', NULL, ?, lower(trim(?)), ?, 0, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM account_imports WHERE id=? AND request_hash=?)`).bind(conversationId, account.name, account.name, `account:${externalKey}`, account.nextFollowUpAt ? "pending" : "none", account.nextFollowUpAt, new Date().toISOString(), importId, requestHash),
        db.prepare(`INSERT OR IGNORE INTO deals (id, conversation_id, organization_id, contact_id, stage, next_action, next_action_at, note)
          SELECT ?, ?, ?, NULL, 'new', ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM account_imports WHERE id=? AND request_hash=?)`).bind(dealId, conversationId, id, account.nextStep, account.nextFollowUpAt, account.notes, importId, requestHash),
      );
    }
    await db.batch(statements);
    const stored = await db.prepare("SELECT id, record_count AS recordCount, request_hash AS requestHash FROM account_imports WHERE import_key=? LIMIT 1").bind(importKey).first<{ id: string; recordCount: number; requestHash: string | null }>();
    const outcome = classifyAccountImportResult(stored, importId, requestHash);
    if (outcome.kind === "unverifiable") return jsonError(409, "account_import_key_unverifiable");
    if (outcome.kind === "reused") return jsonError(409, "account_import_key_reused");
    return Response.json({ imported: outcome.imported, idempotent: !outcome.imported, recordCount: outcome.recordCount }, { status: outcome.imported ? 201 : 200 });
  } catch {
    return jsonError(500, "account_import_failed");
  }
}

function key(value: unknown) { return typeof value === "string" && /^[a-zA-Z0-9._:-]{1,128}$/u.test(value) ? value : null; }
function optionalText(value: unknown) { return typeof value === "string" && value.trim() ? value.trim() : null; }
async function shortHash(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).slice(0, 12).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizedName(value: string) {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("fr-CA");
}
