import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, url: "data:text/javascript,export {};" };
      }
      return nextResolve(specifier, context);
    }
  `)}`,
  import.meta.url,
);

const { CAKEMAIL_RESPONSE_MAX_BYTES, sendCakemailMessage } = await import(
  "../lib/cakemail-client.ts"
);
const {
  cakemailFailureKindForStatus,
  CakemailSendError,
  classifyCakemailFailure,
} = await import("../lib/cakemail-send-outcome.ts");

const externalMessageId =
  "cakemail.550e8400-e29b-41d4-a716-446655440000@27pm.org";
const providerMessageId = "3fbfa67e-c4c4-4e03-8dfd-556037960374";
const message = {
  fromAddress: "alexis@27pm.org",
  fromName: "Alexis Boulet — 27PM",
  to: ["client@example.com"],
  subject: "Bonjour",
  text: "Une observation.",
  html: "<p>Une observation.</p>",
  replyTo: "alexis@27pm.org",
  unsubscribeUrl:
    "https://crm.27pm.org/api/public/unsubscribe?token=opaque-token",
  tags: ["crm-manual", "traffic-prospecting"],
};
const config = {
  apiBase: "https://api.cakemail.dev",
  pat: `ck_pat_${"a".repeat(40)}`,
  accountId: 27,
  listId: 42,
  contentMode: "html",
  senderIds: { "alexis@27pm.org": "sender_27pm_alexis" },
};

function acceptedResponse(overrides = {}, status = 201) {
  return new Response(
    JSON.stringify({
      email: "client@example.com",
      object: "email",
      submitted: true,
      data: { id: providerMessageId, status: "queued" },
      ...overrides,
    }),
    { status, headers: { "content-type": "application/json" } },
  );
}

test("posts one validated JSON request to the pinned Cakemail API", async () => {
  const order = [];
  let capturedUrl;
  let capturedInit;
  const result = await sendCakemailMessage(message, config, {
    externalMessageId,
    onDispatchStart: () => order.push("start"),
    fetcher: async (url, init) => {
      order.push("fetch");
      capturedUrl = url;
      capturedInit = init;
      return acceptedResponse();
    },
  });

  assert.deepEqual(order, ["start", "fetch"]);
  assert.equal(
    capturedUrl,
    "https://api.cakemail.dev/v2/emails?account_id=27",
  );
  assert.equal(capturedInit.method, "POST");
  assert.equal(capturedInit.redirect, "error");
  assert.ok(capturedInit.signal instanceof AbortSignal);
  assert.equal(
    new Headers(capturedInit.headers).get("authorization"),
    `Bearer ck_pat_${"a".repeat(40)}`,
  );
  assert.equal(
    new Headers(capturedInit.headers).get("content-type"),
    "application/json",
  );
  const body = JSON.parse(capturedInit.body);
  assert.equal(body.email, "client@example.com");
  assert.equal(body.content.html, "<p>Une observation.</p>");
  assert.equal("text" in body.content, false);
  assert.deepEqual(body.tracking, {
    opens: false,
    clicks_html: false,
    clicks_text: false,
  });
  assert.deepEqual(result, {
    providerMessageId,
    externalMessageId,
    message: "Queued",
    responseStatus: 201,
  });
});

test("completes every local validation before crossing the provider boundary", async () => {
  for (const invalidConfig of [
    { ...config, apiBase: "https://api.cakemail.dev.evil.example" },
    { ...config, apiBase: "https://api.cakemail.dev/v2" },
    { ...config, apiBase: "http://api.cakemail.dev" },
    { ...config, pat: "bad token" },
    { ...config, accountId: 0 },
  ]) {
    const order = [];
    await assert.rejects(
      sendCakemailMessage(message, invalidConfig, {
        externalMessageId,
        onDispatchStart: () => order.push("start"),
        fetcher: async () => {
          order.push("fetch");
          return acceptedResponse();
        },
      }),
      /Cakemail/u,
    );
    assert.deepEqual(order, []);
  }
});

test("accepts an OpenAPI-compliant 201 queued response with optional submitted", async () => {
  const result = await sendCakemailMessage(message, config, {
    externalMessageId,
    fetcher: async () =>
      acceptedResponse({ submitted: undefined }),
  });
  assert.equal(result.providerMessageId, providerMessageId);
});

test("normalizes an uppercase provider UUID from an accepted response", async () => {
  const result = await sendCakemailMessage(message, config, {
    externalMessageId,
    fetcher: async () =>
      acceptedResponse({
        submitted: undefined,
        data: { id: providerMessageId.toUpperCase(), status: "queued" },
      }),
  });
  assert.equal(result.providerMessageId, providerMessageId);
});

test("keeps malformed or contradictory 201 responses outcome-unknown", async () => {
  const cases = [
    acceptedResponse({}, 200),
    acceptedResponse({ email: "other@example.com" }),
    acceptedResponse({ submitted: false }),
    acceptedResponse({ data: { id: providerMessageId, status: "submitted" } }),
    acceptedResponse({ data: { id: "not-a-uuid", status: "queued" } }),
    acceptedResponse({ submitted: "yes" }),
    new Response("not-json", { status: 201 }),
  ];

  for (const response of cases) {
    await assert.rejects(
      sendCakemailMessage(message, config, {
        externalMessageId,
        fetcher: async () => response,
      }),
      (error) =>
        error instanceof CakemailSendError &&
        error.kind === "outcome_unknown",
    );
  }
});

test("treats explicit 201 rejected and error outcomes as definitive", async () => {
  for (const response of [
    acceptedResponse({
      submitted: false,
      data: { id: providerMessageId, status: "rejected" },
    }),
    acceptedResponse({
      submitted: undefined,
      data: { id: providerMessageId, status: "rejected" },
    }),
    acceptedResponse({
      submitted: true,
      data: { id: providerMessageId, status: "rejected" },
    }),
    acceptedResponse({
      submitted: false,
      data: { id: providerMessageId, status: "error" },
    }),
  ]) {
    await assert.rejects(
      sendCakemailMessage(message, config, {
        externalMessageId,
        fetcher: async () => response,
      }),
      (error) =>
        error instanceof CakemailSendError && error.kind === "rejected",
    );
  }
});

test("bounds a successful provider response before parsing it", async () => {
  const oversized = new Response("{}", {
    status: 201,
    headers: {
      "content-length": String(CAKEMAIL_RESPONSE_MAX_BYTES + 1),
    },
  });
  await assert.rejects(
    sendCakemailMessage(message, config, {
      externalMessageId,
      fetcher: async () => oversized,
    }),
    (error) =>
      error instanceof CakemailSendError && error.kind === "outcome_unknown",
  );
});

test("treats only unambiguous 4xx responses as definitive rejections", async () => {
  for (const status of [400, 401, 422, 499]) {
    await assert.rejects(
      sendCakemailMessage(message, config, {
        externalMessageId,
        fetcher: async () => new Response("{}", { status }),
      }),
      (error) =>
        error instanceof CakemailSendError && error.kind === "rejected",
    );
  }
  assert.equal(cakemailFailureKindForStatus(400), "rejected");
  assert.equal(cakemailFailureKindForStatus(499), "rejected");
  assert.equal(cakemailFailureKindForStatus(408), "outcome_unknown");
  assert.equal(cakemailFailureKindForStatus(429), "outcome_unknown");
  assert.equal(cakemailFailureKindForStatus(500), "outcome_unknown");
  assert.equal(cakemailFailureKindForStatus(503), "outcome_unknown");
  assert.equal(cakemailFailureKindForStatus(302), "outcome_unknown");
});

test("does not make ambiguous 408 or 429 responses retryable", async () => {
  for (const status of [408, 429]) {
    await assert.rejects(
      sendCakemailMessage(message, config, {
        externalMessageId,
        fetcher: async () => new Response("{}", { status }),
      }),
      (error) =>
        error instanceof CakemailSendError &&
        error.kind === "outcome_unknown",
    );
  }
});

test("does not retry a network failure and classifies it as unknown after dispatch", async () => {
  let calls = 0;
  const networkFailure = new Error("connection reset");
  await assert.rejects(
    sendCakemailMessage(message, config, {
      externalMessageId,
      fetcher: async () => {
        calls += 1;
        throw networkFailure;
      },
    }),
    networkFailure,
  );
  assert.equal(calls, 1);
  assert.equal(
    classifyCakemailFailure(true, networkFailure),
    "outcome_unknown",
  );
  assert.equal(
    classifyCakemailFailure(false, networkFailure),
    "definitive_failure",
  );
  assert.equal(
    classifyCakemailFailure(true, new CakemailSendError(422, "rejected")),
    "definitive_failure",
  );
});
