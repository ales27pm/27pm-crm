import { crmDatabase } from "@/lib/d1";
import { jsonError, optionalTrimmedString } from "@/lib/http";
import { normalizeEmailAddress } from "@/lib/mailboxes";
import { runtimeString } from "@/lib/runtime";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 32_000;

export async function OPTIONS(request: Request) {
  const allowed = allowedOrigin(request);
  if (!allowed) return jsonError(403, "origin_forbidden");
  return new Response(null, { status: 204, headers: corsHeaders(allowed) });
}

export async function POST(request: Request) {
  const origin = allowedOrigin(request);
  if (!origin) return jsonError(403, "origin_forbidden");
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (!Number.isFinite(contentLength) || contentLength > MAX_BODY_BYTES) return intakeError(413, "request_too_large", origin);
  const secret = runtimeString("TURNSTILE_SECRET_KEY");
  const hashSalt = runtimeString("PUBLIC_INTAKE_HASH_SALT");
  if (!secret || !hashSalt) return intakeError(503, "intake_not_configured", origin);
  const idempotencyKey = normalizedKey(request.headers.get("idempotency-key"));
  if (!idempotencyKey) return intakeError(400, "idempotency_key_invalid", origin);
  const body = await readBoundedJson(request);
  if (body.tooLarge) return intakeError(413, "request_too_large", origin);
  const payload = body.payload;
  if (!payload) return intakeError(400, "request_body_invalid", origin);
  if (optionalTrimmedString(payload.website, 200)) return accepted(origin);
  const organizationName = optionalTrimmedString(payload.organizationName, 200);
  const contactName = optionalTrimmedString(payload.contactName, 200);
  const contactEmail = typeof payload.contactEmail === "string" ? normalizeEmailAddress(payload.contactEmail) : null;
  const projectType = optionalTrimmedString(payload.projectType, 100);
  const message = optionalTrimmedString(payload.message, 5_000);
  const token = optionalTrimmedString(payload.turnstileToken, 4_000);
  if (!organizationName || !contactName || !contactEmail || !message || !token || payload.privacyAcknowledged !== true) return intakeError(400, "intake_invalid", origin);
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const requesterHash = await sha256(`${hashSalt}:${ip}`);
  try {
    const db = crmDatabase();
    const existing = await db.prepare("SELECT id FROM intake_submissions WHERE idempotency_key=? LIMIT 1").bind(idempotencyKey).first();
    if (existing) return accepted(origin);
    const windowStart = Math.floor(Date.now() / 900_000) * 900_000;
    const bucketKey = `${requesterHash}:${windowStart}`;
    const expiresAt = new Date(windowStart + 1_800_000).toISOString();
    const reservation = await db.prepare(
      `INSERT INTO intake_rate_limits (bucket_key, requester_hash, count, expires_at)
       VALUES (?, ?, 1, ?)
       ON CONFLICT(bucket_key) DO UPDATE SET
         count = intake_rate_limits.count + 1,
         updated_at = CURRENT_TIMESTAMP
       WHERE intake_rate_limits.count < 5
       RETURNING count`,
    ).bind(bucketKey, requesterHash, expiresAt).first<{ count: number }>();
    if (!reservation) return intakeError(429, "intake_rate_limited", origin);
    if (!(await verifyTurnstile(secret, token, ip, origin))) return intakeError(400, "human_verification_failed", origin);
    await db.prepare(`INSERT OR IGNORE INTO intake_submissions (id, idempotency_key, requester_hash, origin, organization_name, contact_name, contact_email, project_type, message, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`).bind(crypto.randomUUID(), idempotencyKey, requesterHash, origin, organizationName, contactName, contactEmail, projectType ?? null, message).run();
    return accepted(origin);
  } catch {
    return intakeError(503, "intake_unavailable", origin);
  }
}

function allowedOrigin(request: Request): string | null {
  const configured = runtimeString("PUBLIC_SITE_ORIGIN");
  const origin = request.headers.get("origin");
  if (!configured || !origin) return null;
  try {
    const expected = new URL(configured).origin;
    return new URL(origin).origin === expected ? expected : null;
  } catch { return null; }
}

function corsHeaders(origin: string) {
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, idempotency-key", "access-control-max-age": "600", vary: "Origin", "cache-control": "no-store" };
}
function accepted(origin: string) { return Response.json({ accepted: true, status: "pending_review" }, { status: 202, headers: corsHeaders(origin) }); }
function intakeError(status: number, code: string, origin: string) { return Response.json({ error: code }, { status, headers: corsHeaders(origin) }); }
function normalizedKey(value: string | null) { return value && /^[a-zA-Z0-9._:-]{8,128}$/u.test(value) ? value : null; }
async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
async function verifyTurnstile(secret: string, token: string, ip: string, origin: string) {
  try {
    const body = new URLSearchParams({ secret, response: token, remoteip: ip });
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body, signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return false;
    const result = await response.json() as { success?: boolean; hostname?: string; action?: string };
    return result.success === true && result.hostname === new URL(origin).hostname && result.action === (runtimeString("PUBLIC_INTAKE_TURNSTILE_ACTION") ?? "crm_intake");
  } catch { return false; }
}

async function readBoundedJson(request: Request): Promise<{ payload: Record<string, unknown> | null; tooLarge: boolean }> {
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) return { payload: null, tooLarge: true };
    const value = JSON.parse(text) as unknown;
    return { payload: value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null, tooLarge: false };
  } catch {
    return { payload: null, tooLarge: false };
  }
}
