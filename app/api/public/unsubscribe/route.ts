import { crmDatabase } from "@/lib/d1";
import { boundedRequest } from "@/lib/bounded-request";
import { runtimeString } from "@/lib/runtime";
import { applyEmailUnsubscribe, validUnsubscribeSecret, verifyUnsubscribeToken } from "@/lib/unsubscribe";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  if (!validTokenShape(token)) return html(400, confirmationPage("Lien invalide", "Ce lien de désabonnement est invalide."));
  const secret = runtimeString("CRM_UNSUBSCRIBE_SIGNING_KEY");
  if (!validUnsubscribeSecret(secret)) return html(503, confirmationPage("Service indisponible", "Le mécanisme de désabonnement n’est pas configuré."));
  const verified = await verifyUnsubscribeToken(secret, token);
  if (!verified) return html(400, confirmationPage("Lien expiré", "Ce lien est invalide ou expiré."));
  return html(200, `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Désabonnement 27PM</title><body><main><h1>Préférences de communication</h1><p>La demande sera appliquée immédiatement et ne nécessite aucune connexion.</p><form method="post"><input type="hidden" name="token" value="${escapeHtml(token)}"><label><input type="radio" name="scope" value="global" checked> Ne plus recevoir aucun courriel commercial de 27PM</label><br><label><input type="radio" name="scope" value="category"> Ne plus recevoir la catégorie prospection</label><input type="hidden" name="category" value="prospecting"><p><button type="submit">Confirmer le désabonnement</button></p></form></main></body></html>`);
}

export async function POST(request: Request) {
  const payload = await unsubscribePayload(request);
  if (!payload) return Response.json({ error: "unsubscribe_invalid" }, { status: 400 });
  const secret = runtimeString("CRM_UNSUBSCRIBE_SIGNING_KEY");
  if (!validUnsubscribeSecret(secret)) return Response.json({ error: "unsubscribe_not_configured" }, { status: 503 });
  const verified = await verifyUnsubscribeToken(secret, payload.token);
  if (!verified) return Response.json({ error: "unsubscribe_token_invalid" }, { status: 400 });
  const evidenceRef = `unsubscribe-token-sha256:${await sha256(payload.token)}`;
  const result = await applyEmailUnsubscribe(crmDatabase(), { contactId: verified.contactId, email: verified.email, scope: payload.scope, category: payload.category, evidenceRef });
  if (request.headers.get("content-type")?.includes("application/x-www-form-urlencoded")) {
    return html(200, confirmationPage("Désabonnement confirmé", "La demande a été appliquée immédiatement."));
  }
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}

async function unsubscribePayload(request: Request): Promise<{ token: string; scope: "global" | "category"; category: "all" | "prospecting" } | null> {
  const bounded = await boundedRequest(request, 8_192);
  if (!bounded) return null;
  const contentType = request.headers.get("content-type") ?? "";
  let token: unknown; let scope: unknown; let category: unknown;
  if (contentType.includes("application/json")) {
    const json = await bounded.json().catch(() => null) as Record<string, unknown> | null;
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    token = json.token; scope = json.scope; category = json.category;
  } else if (contentType.includes("application/x-www-form-urlencoded")) {
    const text = await bounded.text();
    const form = new URLSearchParams(text);
    token = form.get("token"); scope = form.get("scope"); category = form.get("category");
  } else return null;
  if (typeof token !== "string" || !validTokenShape(token)) return null;
  if (scope !== "global" && scope !== "category") return null;
  const normalizedCategory = scope === "global" ? "all" : category === "prospecting" ? "prospecting" : null;
  return normalizedCategory ? { token, scope, category: normalizedCategory } : null;
}

function validTokenShape(token: string) {
  return token.length >= 32 && token.length <= 2_048 && /^[A-Za-z0-9._-]+$/u.test(token);
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function html(status: number, body: string) {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" } });
}

function confirmationPage(title: string, message: string) {
  return `<!doctype html><html lang="fr"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(title)}</title><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function escapeHtml(value: string) {
  return value.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}
