import assert from "node:assert/strict";
import test from "node:test";

import {
  EXCHANGE_GRAPH_COMMAND_PROPERTY, ExchangeGraphError, createExchangeDraft,
  findExchangeDraftsByCommand, findExchangeSentItemsByCommand,
  getExchangeFolder, getExchangeMessage, readExchangeDelta, submitExchangeDraft,
} from "../lib/exchange-graph.ts";

const MAILBOX = "b27823bf-22d1-4f1e-a461-c0e60523cdd3";
const COMMAND = "da7d66b0-e294-428a-8eb4-781af7a32881";
const BASE = `https://graph.microsoft.com/v1.0/users/${MAILBOX}`;
const folder = "opaque+folder/ID=";
const item = "opaque+message/ID=";
const pageUrl = `${BASE}/mailFolders/${encodeURIComponent(folder)}/messages/delta`;
const message = () => ({
  id: item, parentFolderId: folder, conversationId: "graph-conversation", subject: "Bonjour",
  body: { contentType: "text", content: "Texte sûr" },
  from: { emailAddress: { address: "client@example.com", name: "Client" } },
  sender: { emailAddress: { address: "client@example.com" } },
  toRecipients: [{ emailAddress: { address: "alexis@27pm.org" } }], ccRecipients: [], replyTo: [],
  receivedDateTime: "2026-10-14T12:00:00Z", isDraft: false, isRead: false,
});
const draftInput = () => ({
  commandId: COMMAND, fromAddress: "alexis@27pm.org", fromName: "Alexis — 27PM",
  to: ["witness@example.com"], subject: "Vérification", text: "Texte de test.", replyTo: "alexis@27pm.org",
});
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers });
const makeAccess = (handler) => {
  const calls = [];
  let assertions = 0;
  return {
    access: {
      accessToken: "synthetic-fixture-access-token", mailboxId: MAILBOX,
      async assertCurrent() { assertions += 1; },
      async fetcher(url, init) { calls.push({ url: String(url), init }); return handler(url, init); },
    }, calls, assertions: () => assertions,
  };
};
const rejects = (promise, code, phase, outcomeUnknown = false) => assert.rejects(promise, (error) => {
  assert.ok(error instanceof ExchangeGraphError);
  assert.equal(error.code, code); assert.equal(error.message, code);
  assert.equal(error.phase, phase); assert.equal(error.outcomeUnknown, outcomeUnknown);
  assert.equal(JSON.stringify(error).includes("synthetic-fixture-access-token"), false);
  return true;
});

test("folder and message reads pin the mailbox, encode opaque IDs and never request User.Read", async () => {
  const { access, calls, assertions } = makeAccess((url) => String(url).includes("/messages/") ? json(message()) : json({ id: folder }));
  assert.deepEqual(await getExchangeFolder(access, "inbox"), { id: folder });
  const result = await getExchangeMessage(access, item);
  assert.equal(result.id, item); assert.equal(result.text, "Texte sûr");
  assert.deepEqual(result.from, { address: "client@example.com", name: "Client" });
  assert.equal(calls[0].url, `${BASE}/mailFolders/inbox?$select=id`);
  assert.ok(calls[1].url.startsWith(`${BASE}/messages/${encodeURIComponent(item)}?`));
  assert.equal(assertions(), 2);
  for (const { init } of calls) {
    const headers = new Headers(init.headers);
    assert.match(headers.get("Prefer"), /IdType="ImmutableId"/u);
    assert.match(headers.get("Prefer"), /outlook.body-content-type="text"/u);
    assert.equal(init.redirect, "manual"); assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
  }
});

test("delta preserves absent fields, returns tombstones separately and keeps the exact opaque cursor", async () => {
  const cursor = `${pageUrl}?$skiptoken=opaque%2Btoken%2F%3D`;
  const { access, calls } = makeAccess(() => json({ value: [{ id: item, isRead: true }, { id: "removed", "@removed": { reason: "deleted" } }], "@odata.nextLink": cursor }));
  const result = await readExchangeDelta(access, folder);
  assert.deepEqual(result.messages, [{ id: item, isRead: true }]);
  assert.deepEqual(result.removedIds, ["removed"]);
  assert.equal(result.nextLink, cursor); assert.equal(result.deltaLink, null);
  await readExchangeDelta(access, folder, cursor);
  assert.equal(calls[1].url, cursor);
  assert.match(new Headers(calls[0].init.headers).get("Prefer"), /odata.maxpagesize=4/u);
});

test("delta accepts Graph's documented OData-key cursor spelling without weakening mailbox or folder pinning", async () => {
  const folderKey = encodeURIComponent(`mailFolders('${folder.replaceAll("'", "''")}')`);
  const canonical = `https://graph.microsoft.com/v1.0/users('${MAILBOX}')/${folderKey}/messages/delta?$skiptoken=opaque%2Btoken%2F%3D`;
  const mixed = `https://graph.microsoft.com/v1.0/users/${MAILBOX}/${folderKey}/messages/delta?$deltatoken=opaque%2Btoken%2F%3D`;
  for (const cursor of [canonical, mixed]) {
    const { access, calls } = makeAccess(() => json({ value: [], "@odata.deltaLink": mixed }));
    const first = await readExchangeDelta(access, folder, cursor);
    assert.equal(calls[0].url, cursor);
    assert.equal(first.deltaLink, mixed);
  }
  for (const cursor of [
    canonical.replace(MAILBOX, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"),
    canonical.replace(folderKey, encodeURIComponent("mailFolders('different-folder')")),
    canonical.replace("/messages/delta", "/messages"),
  ]) {
    const { access, calls } = makeAccess(() => { throw new Error("must not fetch"); });
    await rejects(readExchangeDelta(access, folder, cursor), "exchange_graph_request_invalid", "read");
    assert.equal(calls.length, 0);
  }
});

test("hostile, cross-mailbox, cross-folder and non-Graph cursors fail before any bearer request", async () => {
  for (const cursor of [
    "http://graph.microsoft.com/v1.0/me/messages", "https://graph.microsoft.com.evil.invalid/test",
    pageUrl.replace(MAILBOX, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"), pageUrl.replace(encodeURIComponent(folder), "other"),
    pageUrl.replace("/messages/delta", "/messages"), pageUrl.replace("https://", "https://user:pass@"),
    `${pageUrl}#fragment`, `${pageUrl}?$skiptoken=a&$skiptoken=b`, `${pageUrl}?$format=xml`,
  ]) {
    const { access, calls } = makeAccess(() => { throw new Error("must not fetch"); });
    await rejects(readExchangeDelta(access, folder, cursor), "exchange_graph_request_invalid", "read");
    assert.equal(calls.length, 0);
  }
});

test("redirects are rejected before body access and never followed", async () => {
  for (const status of [301, 302, 303, 307, 308]) {
    const { access, calls } = makeAccess(() => ({ status, redirected: false, body: { getReader() { throw new Error("body must not be read"); } }, headers: new Headers({ Location: "https://evil.invalid/collect" }) }));
    await rejects(getExchangeMessage(access, item), "exchange_graph_response_invalid", "read");
    assert.equal(calls.length, 1); assert.equal(calls[0].init.redirect, "manual");
  }
});

test("JSON draft creation attaches a fixed command correlation property and preserves approved content", async () => {
  const { access, calls } = makeAccess(() => json({ ...message(), isDraft: true }, 201));
  const input = draftInput();
  const result = await createExchangeDraft(access, input);
  assert.equal(result.isDraft, true); assert.equal(calls.length, 1);
  const payload = JSON.parse(calls[0].init.body);
  assert.equal(calls[0].url, `${BASE}/messages`); assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(payload.singleValueExtendedProperties[0], { id: EXCHANGE_GRAPH_COMMAND_PROPERTY, value: COMMAND });
  assert.deepEqual(payload.from.emailAddress, { address: input.fromAddress, name: input.fromName });
  assert.deepEqual(payload.toRecipients, [{ emailAddress: { address: input.to[0] } }]);
  assert.deepEqual(payload.body, { contentType: "Text", content: input.text });
  assert.equal(payload.subject, input.subject);
  assert.equal(payload.isReadReceiptRequested, undefined); assert.equal(payload.attachments, undefined);
});

test("threading inputs use documented MAPI proptags, never forbidden custom non-x headers", async () => {
  const { access, calls } = makeAccess(() => json({ ...message(), isDraft: true }, 201));
  const inReplyTo = "<parent@example.com>";
  await createExchangeDraft(access, { ...draftInput(), inReplyTo, references: ["<first@example.com>", inReplyTo] });
  const payload = JSON.parse(calls[0].init.body);
  assert.deepEqual(payload.singleValueExtendedProperties.slice(1), [
    { id: "String 0x1042", value: inReplyTo }, { id: "String 0x1039", value: `<first@example.com> ${inReplyTo}` },
  ]);
  assert.ok(payload.internetMessageHeaders.every(header => header.name.startsWith("x-")));
  for (const extra of [{ inReplyTo: "<parent@example.com>\r\nBcc: victim@example.com" }, { references: ["not a message id"] }, { references: "<a@b>\n<c@d>" }]) {
    await rejects(createExchangeDraft(access, { ...draftInput(), ...extra }), "exchange_graph_request_invalid", "draft_create");
  }
  assert.equal(calls.length, 1);
});

test("draft success with contradictory correlation or malformed content remains an uncertain creation", async () => {
  for (const value of [
    { ...message(), isDraft: false },
    { ...message(), conversationId: undefined, isDraft: true },
    { ...message(), isDraft: true, body: { contentType: "html", content: "<b>changed</b>" } },
    { ...message(), isDraft: true, singleValueExtendedProperties: [{ id: EXCHANGE_GRAPH_COMMAND_PROPERTY, value: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }] },
  ]) {
    const { access, calls } = makeAccess(() => json(value, 201));
    await rejects(createExchangeDraft(access, draftInput()), "exchange_graph_draft_outcome_unknown", "draft_create", true);
    assert.equal(calls.length, 1);
  }
});

test("draft reconciliation is read-only, command-filtered and refuses to infer uniqueness from a partial page", async () => {
  const found = { id: item, isDraft: true, parentFolderId: "draftfolder", singleValueExtendedProperties: [{ id: EXCHANGE_GRAPH_COMMAND_PROPERTY, value: COMMAND }] };
  for (const complete of [true, false]) {
    const { access, calls } = makeAccess(() => json({ value: [found], ...(complete ? {} : { "@odata.nextLink": `${BASE}/mailFolders/drafts/messages?$skiptoken=opaque` }) }));
    const result = await findExchangeDraftsByCommand(access, COMMAND);
    assert.equal(result.complete, complete); assert.equal(result.messages.length, 1);
    const url = new URL(calls[0].url);
    assert.equal(url.pathname, `/v1.0/users/${MAILBOX}/mailFolders/drafts/messages`);
    assert.equal(url.searchParams.get("$top"), "2");
    assert.match(url.searchParams.get("$filter"), new RegExp(COMMAND, "u"));
    assert.match(url.searchParams.get("$expand"), /27PMCommandId/u);
    assert.equal(calls[0].init.method, "GET"); assert.equal(calls.length, 1);
  }
  for (const value of [
    { value: [found, { ...found, id: "second" }, { ...found, id: "third" }] },
    { value: [{ ...found, isDraft: false }] }, { value: [{ id: item, isDraft: true }] },
    { value: [{ ...found, singleValueExtendedProperties: [{ id: EXCHANGE_GRAPH_COMMAND_PROPERTY, value: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" }] }] },
    { value: [found, found] },
    { value: [found], "@odata.nextLink": `${BASE}/mailFolders/inbox/messages?$skiptoken=bad` },
  ]) {
    const { access } = makeAccess(() => json(value));
    await rejects(findExchangeDraftsByCommand(access, COMMAND), "exchange_graph_response_invalid", "read");
  }
});

test("sent-item reconciliation is read-only, command-filtered and requires non-draft results", async () => {
  const found = {
    id: item, isDraft: false, parentFolderId: "sentfolder", conversationId: "provider-thread",
    sentDateTime: "2026-10-14T12:01:00Z",
    singleValueExtendedProperties: [{ id: EXCHANGE_GRAPH_COMMAND_PROPERTY, value: COMMAND }],
  };
  const { access, calls } = makeAccess(() => json({ value: [found] }));
  const result = await findExchangeSentItemsByCommand(access, COMMAND);
  assert.equal(result.complete, true);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].conversationId, "provider-thread");
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, `/v1.0/users/${MAILBOX}/mailFolders/sentitems/messages`);
  assert.match(url.searchParams.get("$select"), /conversationId/u);
  assert.equal(calls[0].init.method, "GET");

  const invalid = makeAccess(() => json({ value: [{ ...found, isDraft: true }] }));
  await rejects(findExchangeSentItemsByCommand(invalid.access, COMMAND), "exchange_graph_response_invalid", "read");
});

test("submission accepts only 202 as submission acceptance and never calls sendMail or returns delivery proof", async () => {
  const { access, calls } = makeAccess(() => new Response(null, { status: 202 }));
  assert.equal(await submitExchangeDraft(access, item), undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/messages/${encodeURIComponent(item)}/send`);
  assert.equal(calls[0].init.method, "POST"); assert.equal(calls[0].init.body, undefined);
});

test("ambiguous draft creation and send are never retried and expose only a fixed unknown-outcome code", async () => {
  for (const [operation, phase, code] of [
    [(access) => createExchangeDraft(access, draftInput()), "draft_create", "exchange_graph_draft_outcome_unknown"],
    [(access) => submitExchangeDraft(access, item), "draft_submit", "exchange_graph_send_outcome_unknown"],
  ]) {
    for (const handler of [
      () => { throw new Error("secret provider body synthetic-fixture-access-token"); },
      () => json({ secret: "must not leak" }, 503),
      () => new Response("not JSON and synthetic-fixture-access-token", { status: 200 }),
      () => new Response(null, { status: 307, headers: { Location: "https://evil.invalid" } }),
    ]) {
      const { access, calls } = makeAccess(handler);
      await rejects(operation(access), code, phase, true); assert.equal(calls.length, 1);
    }
  }
});

test("401,403,404,429 and expired delta are sanitized; Retry-After is bounded", async () => {
  for (const [status, code] of [[401, "exchange_graph_reauthentication_required"], [403, "exchange_graph_forbidden"], [404, "exchange_graph_not_found"], [429, "exchange_graph_throttled"], [410, "exchange_graph_delta_reset"]]) {
    const { access, calls } = makeAccess(() => json({ error: { code: "SECRET", message: "synthetic-fixture-access-token" } }, status, { "Retry-After": "999999999" }));
    await assert.rejects(readExchangeDelta(access, folder), (e) => e instanceof ExchangeGraphError && e.code === code && e.status === status && (status !== 429 || e.retryAfterSeconds === 3600));
    assert.equal(calls.length, 1);
  }
  const { access } = makeAccess(() => json({ error: { code: "syncStateNotFound", message: "secret" } }, 400));
  await rejects(readExchangeDelta(access, folder), "exchange_graph_delta_reset", "read");
});

test("read payloads, page size, headers and plaintext content are validated without leaking raw data", async () => {
  for (const value of [
    { value: Array.from({ length: 5 }, () => ({ id: item })), "@odata.deltaLink": `${pageUrl}?$deltatoken=x` },
    { value: [], "@odata.deltaLink": `${pageUrl}?$deltatoken=x`, "@odata.nextLink": `${pageUrl}?$skiptoken=x` },
    { value: [], "@odata.nextLink": "https://evil.invalid/steal" },
    { value: [{ id: "bad\r\nID" }], "@odata.deltaLink": `${pageUrl}?$deltatoken=x` },
    { value: [{ id: item, "@removed": { reason: { toString: "hostile" } } }], "@odata.deltaLink": `${pageUrl}?$deltatoken=x` },
  ]) {
    const { access } = makeAccess(() => json(value));
    await rejects(readExchangeDelta(access, folder), "exchange_graph_response_invalid", "read");
  }
  const { access } = makeAccess(() => json({ ...message(), body: { contentType: "html", content: "<script>evil</script>" } }));
  await rejects(getExchangeMessage(access, item), "exchange_graph_response_invalid", "read");
  const read = makeAccess(() => json({ ...message(), internetMessageHeaders: [
    { name: "Authentication-Results", value: "mx.test; spf=pass" },
    { name: "Authorization", value: "Bearer secret" }, { name: "Set-Cookie", value: "secret" },
    { name: "Subject", value: "ok\r\nInjected: not-ok" },
  ] }));
  assert.deepEqual((await getExchangeMessage(read.access, item)).headers, [{ name: "authentication-results", value: "mx.test; spf=pass" }]);
});

test("response body is streamed with a 2MiB cap instead of trusting Content-Length", async () => {
  const { access } = makeAccess(() => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1)); controller.close(); },
  }), { status: 200 }));
  await rejects(getExchangeMessage(access, item), "exchange_graph_response_invalid", "read");
});

test("the provider deadline is eight seconds, covers response reading and remains safe for mutations", async (t) => {
  const timeout = t.mock.method(AbortSignal, "timeout", (duration) => {
    assert.equal(duration, 8000);
    return AbortSignal.abort(new DOMException("synthetic secret", "TimeoutError"));
  });
  const { access } = makeAccess(() => new Response(new ReadableStream({ start() {} }), { status: 200 }));
  await rejects(getExchangeMessage(access, item), "exchange_graph_timeout", "read");
  const mutation = makeAccess(() => { throw new DOMException("synthetic secret", "TimeoutError"); });
  await rejects(createExchangeDraft(mutation.access, draftInput()), "exchange_graph_draft_outcome_unknown", "draft_create", true);
  timeout.mock.restore();
});

test("native workerd accepts the actual Graph Request options with manual redirects", { timeout: 30000 }, async () => {
  const { access, calls } = makeAccess(() => new Response(null, { status: 202 }));
  await submitExchangeDraft(access, item);
  const captured = calls[0];
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, compatibilityDate: "2026-09-11", compatibilityFlags: ["nodejs_compat"],
    script: `export default { fetch() {
      const request = new Request(${JSON.stringify(captured.url)}, {
        ...${JSON.stringify({ ...captured.init, signal: undefined })}, signal: AbortSignal.timeout(8000)
      });
      return Response.json({method:request.method,redirect:request.redirect,prefer:request.headers.get('Prefer')});
    } };`,
  }));
  try {
    const response = await mf.dispatchFetch("http://local.invalid");
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.method, "POST"); assert.equal(result.redirect, "manual");
    assert.match(result.prefer, /IdType="ImmutableId"/u);
  } finally { await mf.dispose(); }
});

test("invalid input and revoked local connection are rejected without provider mutations", async () => {
  const { access, calls } = makeAccess(() => json(message()));
  for (const changes of [{ fromAddress: "a@example.com\r\nBcc:b@example.com" }, { to: [] }, { commandId: "invalid" }, { subject: "subject\nInjected" }]) {
    await rejects(createExchangeDraft(access, { ...draftInput(), ...changes }), "exchange_graph_request_invalid", "draft_create");
  }
  access.assertCurrent = async () => { throw new Error("raw private state"); };
  await rejects(submitExchangeDraft(access, item), "exchange_graph_connection_changed", "draft_submit");
  assert.equal(calls.length, 0);
});
