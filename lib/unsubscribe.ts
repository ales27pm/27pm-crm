import type { ComplianceConfiguration } from "./compliance";
import type { CrmDatabase } from "./d1";

type TokenPayload = { contactId: string; email: string; expiresAt: string };

export async function createUnsubscribeToken(
  secret: string,
  payload: TokenPayload,
): Promise<string> {
  if (!validUnsubscribeSecret(secret)) throw new Error("unsubscribe_secret_invalid");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    await encryptionKey(secret),
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return `${base64UrlEncodeBytes(iv)}.${base64UrlEncodeBytes(new Uint8Array(ciphertext))}`;
}

export async function verifyUnsubscribeToken(
  secret: string,
  token: string,
  now = new Date(),
): Promise<TokenPayload | null> {
  if (!validUnsubscribeSecret(secret)) return null;
  const [encodedIv, encodedCiphertext, extra] = token.split(".");
  if (!encodedIv || !encodedCiphertext || extra) return null;
  try {
    const iv = base64UrlDecodeBytes(encodedIv);
    if (iv.length !== 12) return null;
    const ciphertext = base64UrlDecodeBytes(encodedCiphertext);
    if (base64UrlEncodeBytes(iv) !== encodedIv || base64UrlEncodeBytes(ciphertext) !== encodedCiphertext) return null;
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv.buffer },
      await encryptionKey(secret),
      ciphertext.buffer,
    );
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<TokenPayload>;
    if (
      typeof parsed.contactId !== "string" ||
      typeof parsed.email !== "string" ||
      typeof parsed.expiresAt !== "string" ||
      !Number.isFinite(new Date(parsed.expiresAt).valueOf()) ||
      new Date(parsed.expiresAt).valueOf() < now.valueOf()
    ) return null;
    return parsed as TokenPayload;
  } catch {
    return null;
  }
}

export function validUnsubscribeSecret(secret: string | null | undefined): secret is string {
  return typeof secret === "string" && new TextEncoder().encode(secret).byteLength >= 32;
}

export function appendComplianceFooter(
  text: string | null,
  html: string | null,
  configuration: ComplianceConfiguration,
  unsubscribeUrl: string,
): { text: string; html: string } {
  const safeUnsubscribeUrl = validatedUnsubscribeUrl(unsubscribeUrl);
  const footerLines = [
    configuration.senderName,
    configuration.organizationName,
    configuration.postalAddress,
    configuration.contactMethod,
    `Se désabonner : ${safeUnsubscribeUrl}`,
  ];
  const operatorText = canonicalOperatorText(text, html);
  const footerText = footerLines.join("\n");
  const footerHtml = `<hr><p>${footerLines
    .slice(0, -1)
    .map(escapeHtml)
    .join("<br>")}<br><a href="${escapeHtml(safeUnsubscribeUrl)}">Se désabonner</a></p>`;
  return {
    text: appendPlainTextFooter(operatorText, footerText),
    html: appendHtmlFooter(html, operatorText, footerHtml),
  };
}

export async function applyEmailUnsubscribe(
  db: CrmDatabase,
  input: { contactId: string; email: string; scope: "global" | "category"; category: "all" | "prospecting"; evidenceRef: string },
  now = new Date(),
): Promise<{ applied: true; idempotent: boolean }> {
  const normalizedEmail = input.email.toLowerCase().trim();
  const contact = await db.prepare("SELECT id, email FROM contacts WHERE id=? LIMIT 1")
    .bind(input.contactId).first<{ id: string; email: string }>();
  const identityStillMatches = contact?.email.toLowerCase() === normalizedEmail;
  const existing = await db.prepare(`SELECT 1 AS present FROM contact_suppressions
    WHERE channel='email' AND address_normalized=? AND scope=? AND category=? LIMIT 1`)
    .bind(normalizedEmail, input.scope, input.category).first();
  const idempotent = Boolean(existing);
  const timestamp = now.toISOString();
  const stableKey = await sha256(`${input.contactId}:${normalizedEmail}:${input.scope}:${input.category}:${input.evidenceRef}`);
  const statements = [
    db.prepare(`INSERT OR IGNORE INTO contact_suppressions
      (id, channel, address_normalized, scope, category, reason, evidence_ref,
       requested_at, effective_at, created_by)
      VALUES (?, 'email', ?, ?, ?, 'unsubscribe', ?, ?, ?, 'public:unsubscribe')`)
      .bind(`unsubscribe:${stableKey}`, normalizedEmail, input.scope, input.category, input.evidenceRef, timestamp, timestamp),
    ...(identityStillMatches && contact ? [
      ...(input.scope === "global" ? [
        db.prepare(`UPDATE contact_channel_compliance SET status='unsubscribed', updated_at=CURRENT_TIMESTAMP
          WHERE contact_id=? AND channel='email'`).bind(contact.id),
        db.prepare(`UPDATE contacts SET
          compliance_version=compliance_version + CASE WHEN email_status<>'unsubscribed' OR do_not_contact=0 THEN 1 ELSE 0 END,
          email_status='unsubscribed', unsubscribed_at=COALESCE(unsubscribed_at, ?),
          do_not_contact=1, updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(timestamp, contact.id),
      ] : []),
      db.prepare(`UPDATE tasks SET status='cancelled', updated_at=CURRENT_TIMESTAMP
      WHERE contact_action=1 AND status='open'
        AND (?='global' OR contact_channel='email')
        AND (conversation_id IN (SELECT id FROM conversations WHERE contact_id=?)
          OR deal_id IN (SELECT id FROM deals WHERE contact_id=?))`).bind(input.scope, contact.id, contact.id),
      db.prepare(`UPDATE send_commands SET status='cancelled', failure_code='contact_unsubscribed', updated_at=CURRENT_TIMESTAMP
      WHERE contact_id=? AND status IN ('pending','authorized')
        AND (?='global' OR mailbox_id IN (SELECT id FROM mailboxes WHERE purpose='sales'))`).bind(contact.id, input.scope),
    ] : []),
    db.prepare(`INSERT OR IGNORE INTO audit_entries (id, actor_email, action, entity_type, entity_id, details_json)
      VALUES (?, 'public:unsubscribe', 'contact.unsubscribed', 'contact', ?, ?)`)
      .bind(`unsubscribe-audit:${stableKey}`, input.contactId, JSON.stringify({ scope: input.scope, category: input.category, evidenceRef: input.evidenceRef, addressNormalized: normalizedEmail, identityStillMatches })),
  ];
  await db.batch(statements);
  return { applied: true, idempotent };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function encryptionKey(secret: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function base64UrlEncodeBytes(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlDecodeBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  const output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) output[index] = binary.charCodeAt(index);
  return output;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&#39;");
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/gu, " ").replace(/\s+/gu, " ").trim();
}

function normalizePlainText(value: string): string {
  return value.replace(/\r\n?/gu, "\n").trim();
}

function canonicalOperatorText(text: string | null, html: string | null): string {
  const source = text?.trim() || stripHtml(html ?? "");
  return normalizePlainText(source);
}

function appendPlainTextFooter(operatorText: string, footerText: string): string {
  return operatorText
    ? `${operatorText}\n\n—\n${footerText}`
    : `—\n${footerText}`;
}

function appendHtmlFooter(
  html: string | null,
  operatorText: string,
  footerHtml: string,
): string {
  const bodyHtml = html || plainTextToMinimalHtml(operatorText);
  return `${bodyHtml}${footerHtml}`;
}

function plainTextToMinimalHtml(value: string): string {
  if (!value) return "";
  return value
    .split(/\n{2,}/gu)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph).replace(/\n/gu, "<br>")}</p>`,
    )
    .join("");
}

function validatedUnsubscribeUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("unsubscribe_url_invalid");
  }
  const safeComponents = [
    url.protocol === "https:",
    !url.username,
    !url.password,
    !url.hash,
  ];
  if (!safeComponents.every(Boolean)) {
    throw new Error("unsubscribe_url_invalid");
  }
  return url.toString();
}
