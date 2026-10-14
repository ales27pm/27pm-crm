import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import {
  ExchangeConnection,
  exchangeCompletionRequested,
  parseExchangeBrowserFlow,
  parseExchangeConnectionStatus,
  readExchangeRecordedStatus,
  validMicrosoftAuthorizationUrl,
} from "../app/components/exchange-connection.tsx";

const FLOW = { binder: "b".repeat(43), flowId: "a1234567-1234-1234-1234-123456789abc" };

test("the Exchange screen distinguishes connection from live mail flow", () => {
  const html = renderToStaticMarkup(createElement(ExchangeConnection, {
    initialStatus: { configured: true, status: "connected", mailFlowEnabled: false },
  }));
  assert.match(html, /Microsoft Exchange/u);
  assert.match(html, /État enregistré/u);
  assert.match(html, /aucune nouvelle vérification Microsoft n’a été effectuée/u);
  assert.match(html, /alexis@27pm\.org/u);
  assert.match(html, /bonjour@27pm\.org · admin@27pm\.org/u);
  assert.match(html, /Synchronisation CRM<\/dt><dd>Désactivée/u);
  assert.match(html, /Envoi Exchange<\/dt><dd>Désactivé/u);
  assert.match(html, /La réception actuelle et les MX ne changent pas/u);
  assert.match(html, /Vérifier l’état/u);
  assert.match(html, /Déconnecter le CRM/u);
  assert.doesNotMatch(html, />Connecter Microsoft</u);
  assert.doesNotMatch(html, /Envoyer un courriel/u);
  assert.match(html, /aria-live="polite"/u);
});

test("an unavailable recorded state is never presented as a connected mailbox", () => {
  const html = renderToStaticMarkup(createElement(ExchangeConnection));
  assert.match(html, /État enregistré<\/dt><dd>Inconnu/u);
  assert.doesNotMatch(html, /<dd>Connectée<\/dd>/u);
});

test("unconfigured status cannot offer an enabled connection action", () => {
  const html = renderToStaticMarkup(createElement(ExchangeConnection, {
    initialStatus: { configured: false, status: "disconnected", mailFlowEnabled: false },
  }));
  assert.match(html, /configuration sécurisée du serveur n’est pas encore complète/u);
  assert.match(html, /<button[^>]+disabled=""[^>]*>Connecter Microsoft<\/button>/u);
});

test("separates disconnected state, pending credential cleanup, and Microsoft consent", () => {
  const html = renderToStaticMarkup(createElement(ExchangeConnection, {
    initialStatus: { configured: true, status: "disconnected", mailFlowEnabled: false, cleanupPending: true },
  }));
  assert.match(html, /Déconnectée/u);
  assert.match(html, /Nettoyage en attente/u);
  assert.match(html, /justificatif chiffré/u);
  assert.match(html, /ne révoque pas automatiquement le consentement Microsoft/u);
  assert.equal(parseExchangeConnectionStatus({ configured: true, status: "disconnected", mailFlowEnabled: false, cleanupPending: true }).cleanupPending, true);
});

test("only the explicit single completion marker is eligible for finalization", () => {
  for (const suffix of ["", "?complete=0", "?complete=true", "?complete=1&complete=1", "?complete=1&complete=0", "?code=opaque"]) {
    assert.equal(exchangeCompletionRequested(new URL(`https://crm.example.com/settings/exchange${suffix}`)), false);
  }
  assert.equal(exchangeCompletionRequested(new URL("https://crm.example.com/settings/exchange?complete=1")), true);
});

test("session storage admits only the browser CSRF binder and optional unconsumed flow ID", () => {
  assert.deepEqual(parseExchangeBrowserFlow(JSON.stringify(FLOW)), FLOW);
  assert.deepEqual(parseExchangeBrowserFlow(JSON.stringify({ binder: FLOW.binder })), { binder: FLOW.binder });
  for (const value of [null, "invalid", "{}", "[]", JSON.stringify({ ...FLOW, accessToken: "secret" }),
    JSON.stringify({ ...FLOW, codeVerifier: "secret" }), JSON.stringify({ ...FLOW, refreshToken: "secret" }),
    JSON.stringify({ ...FLOW, binder: "short" }), JSON.stringify({ ...FLOW, flowId: "bad" })]) {
    assert.equal(parseExchangeBrowserFlow(value), null);
  }
});

test("accepts explicit sync and mail capabilities, not malformed live modes", () => {
  const status = { configured: true, status: "connected", mailFlowEnabled: false, updatedAt: "2026-10-14T04:00:00Z" };
  assert.deepEqual(parseExchangeConnectionStatus({ ok: true, ...status }), status);
  assert.deepEqual(
    parseExchangeConnectionStatus({ ...status, mailFlowEnabled: true, syncEnabled: true }),
    { ...status, mailFlowEnabled: true, syncEnabled: true },
  );
  for (const changed of [{ status: "unknown" }, { status: ["connected"] }, { mailFlowEnabled: "yes" }, { syncEnabled: "yes" }, { updatedAt: "invalid" }, { configured: 1 }, { cleanupPending: "yes" }]) {
    assert.equal(parseExchangeConnectionStatus({ ...status, ...changed }), null);
  }
});

test("never follows an arbitrary authorization link returned in a malformed response", () => {
  const good = "https://login.microsoftonline.com/a1234567-1234-1234-1234-123456789abc/oauth2/v2.0/authorize?response_type=code&response_mode=form_post&code_challenge_method=S256";
  assert.equal(validMicrosoftAuthorizationUrl(good), true);
  for (const bad of [good.replace("login.microsoftonline.com", "attacker.example"), good.replace("https:", "http:"),
    good.replace("response_type=code", "response_type=token"), good.replace("form_post", "query"),
    good.replace("S256", "plain"), good.replace("a1234567-1234-1234-1234-123456789abc", "common"), `${good}#secret`, `${good}&response_mode=query`]) {
    assert.equal(validMicrosoftAuthorizationUrl(bad), false);
  }
});

test("guards the server page and consumes local replay markers before the one-time finalization POST", async () => {
  const [page, component, settings] = await Promise.all([
    readFile(new URL("../app/settings/exchange/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/exchange-connection.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/work-views.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(page, /await getChatGPTUser\(\)/u);
  assert.match(page, /if \(!user\) return <AccessScreen state="signed-out"/u);
  assert.match(page, /if \(!isCrmOperator\(user.email\)\)/u);
  assert.match(component, /const finalizationAttempted = useRef\(false\)/u);
  assert.match(component, /completion && flow\?\.flowId && !finalizationAttempted.current/u);
  assert.ok(component.indexOf('url.searchParams.delete("complete")') < component.indexOf("void finalize("));
  assert.ok(component.indexOf("writeFlow({ binder: flow.binder })") < component.indexOf('exchangeRequest("finalize"'));
  assert.equal((component.match(/exchangeRequest\("finalize"/gu) ?? []).length, 1);
  assert.doesNotMatch(component, /setInterval|localStorage|access_token|refresh_token/u);
  assert.match(settings, /href="\/settings\/exchange"/u);
});

test("after a failed check the UI reads the stored state without retrying the mutation", async () => {
  const component = await readFile(new URL("../app/components/exchange-connection.tsx", import.meta.url), "utf8");
  assert.match(component, /const recordedStatus = action === "check" \? await readExchangeRecordedStatus\(\) : null/u);
  assert.match(component, /if \(action === "check"\) setConnection\(recordedStatus\)/u);
  assert.equal((component.match(/exchangeRequest\(action\)/gu) ?? []).length, 1);
});

test("recovery performs one read-only uncached GET and returns the updated reauthorization state", async (t) => {
  const calls = [];
  const recorded = { configured: true, status: "reauth_required", mailFlowEnabled: false };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    calls.push({ url, init });
    return Response.json(recorded);
  });
  assert.deepEqual(await readExchangeRecordedStatus(), recorded);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/integrations/exchange");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.cache, "no-store");
  assert.equal(calls[0].init.redirect, "error");
});

test("failed or malformed recovery returns unknown, never an old connected result or retry", async (t) => {
  const replies = [
    () => { throw new Error("network unavailable"); },
    () => Response.json({ error: "unavailable" }, { status: 503 }),
    () => Response.json({ configured: true, status: "connected", mailFlowEnabled: true, syncEnabled: "yes" }),
  ];
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    assert.equal(init.method, "GET");
    return replies[calls++]();
  });
  for (let i = 0; i < replies.length; i++) {
    assert.equal(await readExchangeRecordedStatus(), null);
    assert.equal(calls, i + 1);
  }
});
