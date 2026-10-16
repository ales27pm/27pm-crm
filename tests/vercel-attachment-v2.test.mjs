import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  INTERNAL_API_ASSERTION_HEADER,
  INTERNAL_API_DEFAULT_AUDIENCE,
} from "../lib/internal-api-edge.ts";
import {
  internalApiBodyDigest,
  internalApiCriticalHeadersDigest,
  verifyInternalApiAssertion,
} from "../lib/internal-api-auth.ts";
import {
  fetchPreparedVercelApiRequest,
  prepareVercelApiRequest,
} from "../lib/vercel-api-proxy.ts";

// This suite verifies the local BFF boundary, not JWT/MAC validation in the
// Worker. Synthetic credentials never leave these in-process test fetchers.
const ORIGIN = "https://crm.27pm.org";
const BACKEND = "https://crm-worker.example.workers.dev";
const ID = "8b719718-3610-493e-9e94-87e24d3c4f0d";
const CHUNK_BYTES = 2_097_152;
const CONFIG = {
  apiOrigin: BACKEND,
  operatorAllowlist: "owner@example.test",
  signingKey: Buffer.alloc(32, 47).toString("base64url"),
};
const ENABLED = { ...CONFIG, attachmentV2Enabled: "1" };
const UPLOADS = "/api/mobile/attachment-uploads";
const ATTACHMENTS = "/api/mobile/attachments";
const SCANNER = "/api/internal/attachment-scanner/";

function request(path, options = {}) {
  return new Request(ORIGIN + path, {
    ...options,
    headers: { authorization: "Bearer synthetic-device-fixture", ...options.headers },
  });
}

async function rejection(value, status, code) {
  assert.ok(value instanceof Response);
  assert.equal(value.status, status);
  assert.equal(value.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await value.json(), { error: code });
}

async function bounded(promise, milliseconds = 1_000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("BFF body cancellation did not settle")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("attachment capabilities remain false unless the separate BFF flag is exactly one", async () => {
  for (const flag of [undefined, "", "0", "true", "enabled"]) {
    const prepared = await prepareVercelApiRequest(
      request("/api/mobile/capabilities", {
        headers: { "x-27pm-attachment-transport": "chunked-v2" },
      }),
      null,
      { ...CONFIG, attachmentV2Enabled: flag },
    );
    assert.ok(prepared instanceof Response);
    assert.equal(prepared.status, 200);
    assert.deepEqual(await prepared.json(), { attachments: false });
  }
});

test("native and scanner routes are both unavailable with the BFF activation flag off", async () => {
  for (const path of [
    UPLOADS, `${UPLOADS}/${ID}`, `${UPLOADS}/${ID}/chunks/0`, `${UPLOADS}/${ID}/complete`,
    ATTACHMENTS, `${ATTACHMENTS}/${ID}/manifest`, `${ATTACHMENTS}/${ID}/chunks/0?version=v1`,
    `${SCANNER}heartbeat`, `${SCANNER}claim`, `${SCANNER}jobs/${ID}/chunks/0`,
  ]) {
    await rejection(
      await prepareVercelApiRequest(request(path), null, CONFIG),
      503, "attachment_transport_disabled",
    );
  }
});

test("the legacy full-file endpoint cannot be revived by enabling chunked-v2", async () => {
  for (const path of [`${ATTACHMENTS}/${ID}/file`, `${ATTACHMENTS}/${ID}/file/`]) {
    await rejection(
      await prepareVercelApiRequest(request(path), null, ENABLED),
      503, "attachment_route_unavailable",
    );
  }
});

test("one exact 2MiB chunk is consumed once and forwarded intact through the same-origin BFF", async () => {
  const bytes = new Uint8Array(CHUNK_BYTES);
  for (let offset = 0; offset < bytes.length; offset += 1) bytes[offset] = offset % 251;
  const source = request(`${UPLOADS}/${ID}/chunks/9`, {
    method: "PUT", body: bytes,
    headers: { "content-type": "application/octet-stream", "content-length": String(bytes.length) },
  });
  const prepared = await prepareVercelApiRequest(source, "unrelated@example.test", ENABLED);
  assert.equal(prepared instanceof Response, false);
  assert.equal(source.bodyUsed, true);
  assert.equal(prepared.destination.toString(), `${BACKEND}${UPLOADS}/${ID}/chunks/9`);
  assert.equal(prepared.headers.get("content-length"), null);
  assert.deepEqual(prepared.body, bytes);
  let forwarded = 0;
  const response = await fetchPreparedVercelApiRequest(source, prepared, async (destination, init) => {
    forwarded += 1;
    assert.equal(destination.toString(), `${BACKEND}${UPLOADS}/${ID}/chunks/9`);
    assert.equal(init.method, "PUT");
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-device-fixture");
    assert.deepEqual(init.body, bytes);
    return Response.json({ id: ID, receivedChunks: [9] });
  });
  assert.equal(forwarded, 1);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: ID, receivedChunks: [9] });
});

test("an oversized unknown-length stream is cancelled without a clone/tee deadlock", { timeout: 3_000 }, async () => {
  let pulls = 0;
  let cancelled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(pulls === 1 ? CHUNK_BYTES : 1));
      // Deliberately remain open: only cancellation can release this source.
    },
    cancel() { cancelled += 1; },
  });
  const source = request(`${UPLOADS}/${ID}/chunks/0`, {
    method: "PUT", body: stream, duplex: "half",
    headers: { "content-type": "application/octet-stream" },
  });
  assert.equal(source.headers.get("content-length"), null);
  const prepared = await bounded(prepareVercelApiRequest(source, null, ENABLED));
  await rejection(prepared, 413, "attachment_body_invalid");
  assert.equal(source.bodyUsed, true);
  assert.equal(cancelled, 1);
  assert.ok(pulls <= 3, `read beyond the first over-limit chunk: ${pulls}`);
});

test("small manifest and machine bodies retain their independent 16KiB cap", async () => {
  for (const path of [UPLOADS, `${UPLOADS}/${ID}/complete`, `${SCANNER}heartbeat`]) {
    const source = request(path, {
      method: "POST", body: new Uint8Array(16_385),
      headers: { "content-type": "application/json" },
    });
    await rejection(
      await prepareVercelApiRequest(source, null, ENABLED),
      413, "attachment_body_invalid",
    );
  }
});

test("declared oversized, negative or malformed body lengths fail before buffering", async () => {
  for (const value of [String(CHUNK_BYTES + 1), "-1", "2.5", "not-a-length"]) {
    const source = request(`${UPLOADS}/${ID}/chunks/0`, {
      method: "PUT", body: new Uint8Array([1]),
      headers: { "content-type": "application/octet-stream", "content-length": value },
    });
    await rejection(
      await prepareVercelApiRequest(source, null, ENABLED),
      413, "attachment_body_too_large",
    );
    assert.equal(source.bodyUsed, false);
  }
});

test("the attachment prefix cannot proxy unknown routes, alternate chunk indices or trailing segments", async () => {
  for (const path of [
    `${UPLOADS}/unknown`, `${UPLOADS}/${ID}/reset`, `${UPLOADS}/${ID}/chunks/10`,
    `${UPLOADS}/${ID}/chunks/00`, `${UPLOADS}/${ID}/chunks/-1`, `${UPLOADS}/${ID}/chunks/0/extra`,
    `${ATTACHMENTS}/${ID}/signed-url`, `${ATTACHMENTS}/${ID}/chunks/10`,
    `${ATTACHMENTS}/${ID}/manifest/`, `${SCANNER}settings`, `${SCANNER}jobs/${ID}/delete`,
  ]) {
    await rejection(
      await prepareVercelApiRequest(request(path), null, ENABLED),
      503, "attachment_route_unavailable",
    );
  }
});

test("content and transfer encodings are refused before any body is read", async () => {
  for (const [name, value] of [
    ["content-encoding", "gzip"], ["content-encoding", "identity"],
    ["transfer-encoding", "chunked"], ["transfer-encoding", "invalid"],
  ]) {
    const source = request(`${UPLOADS}/${ID}/chunks/0`, {
      method: "PUT", body: new Uint8Array([1]), headers: { [name]: value },
    });
    await rejection(
      await prepareVercelApiRequest(source, null, ENABLED),
      403, "attachment_encoding_forbidden",
    );
    assert.equal(source.bodyUsed, false);
  }
});

test("scanner MAC traffic ignores an unrelated browser operator without gaining operator identity", async () => {
  const authorization = "Scanner sc1:synthetic-test-fixture-not-a-real-signature";
  const source = request(`${SCANNER}jobs/${ID}/complete`, {
    method: "POST", body: "{}",
    headers: {
      authorization, "content-type": "application/json",
      cookie: "authjs.session-token=untrusted-browser-fixture",
      origin: "https://unrelated-browser.example",
      "sec-fetch-site": "cross-site",
      "oai-authenticated-user-email": "spoof@example.test",
      "oai-authenticated-user-id": "spoof-user",
      [INTERNAL_API_ASSERTION_HEADER]: "client-supplied-assertion",
      "x-27pm-internal-subject": "spoof@example.test",
    },
  });
  const prepared = await prepareVercelApiRequest(source, "not-an-operator@example.test", ENABLED);
  assert.equal(prepared instanceof Response, false);
  assert.equal(prepared.headers.get("authorization"), authorization);
  assert.deepEqual(prepared.body, new TextEncoder().encode("{}"));
  for (const name of [
    "cookie", "oai-authenticated-user-email", "oai-authenticated-user-id",
    INTERNAL_API_ASSERTION_HEADER, "x-27pm-internal-subject",
  ]) assert.equal(prepared.headers.get(name), null, name);
});

test("a device bearer carries neither a cookie nor injected identity/assertion headers", async () => {
  const source = request(`${ATTACHMENTS}/${ID}/chunks/0?version=object-v1`, {
    headers: {
      cookie: "untrusted=value", "oai-authenticated-user-email": "spoof@example.test",
      "oai-authenticated-user-id": "spoof", [INTERNAL_API_ASSERTION_HEADER]: "spoof",
      "x-27pm-internal-subject": "spoof", "x-forwarded-host": "other.example",
    },
  });
  const prepared = await prepareVercelApiRequest(source, "unrelated@example.test", ENABLED);
  assert.equal(prepared instanceof Response, false);
  assert.equal(prepared.headers.get("authorization"), "Bearer synthetic-device-fixture");
  for (const name of [
    "cookie", "oai-authenticated-user-email", "oai-authenticated-user-id",
    INTERNAL_API_ASSERTION_HEADER, "x-27pm-internal-subject", "x-forwarded-host",
  ]) assert.equal(prepared.headers.get(name), null, name);
});

test("explicit capability negotiation reaches the backend but cannot create internal identity", async () => {
  const source = request("/api/mobile/capabilities", {
    headers: { "x-27pm-attachment-transport": "chunked-v2" },
  });
  const prepared = await prepareVercelApiRequest(source, "unrelated@example.test", ENABLED);
  assert.equal(prepared instanceof Response, false);
  assert.equal(prepared.headers.get("x-27pm-attachment-transport"), "chunked-v2");
  assert.equal(prepared.headers.get(INTERNAL_API_ASSERTION_HEADER), null);
});

test("backend path/query and the 25-second timeout survive the bounded-body forwarding branch", async t => {
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", milliseconds => {
    timeouts.push(milliseconds);
    return new AbortController().signal;
  });
  const path = `${ATTACHMENTS}/${ID}/chunks/9?version=revision%2B1%2Ftwo`;
  const source = request(path);
  const prepared = await prepareVercelApiRequest(source, null, ENABLED);
  assert.equal(prepared instanceof Response, false);
  let calls = 0;
  const response = await fetchPreparedVercelApiRequest(source, prepared, async (destination, init) => {
    calls += 1;
    assert.equal(destination.toString(), BACKEND + path);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "manual");
    assert.equal(init.cache, "no-store");
    assert.ok(init.signal instanceof AbortSignal);
    assert.equal(init.body, undefined);
    return new Response(new Uint8Array([1, 2, 3]), {
      headers: {
        "content-type": "application/octet-stream", "content-length": "3",
        "x-attachment-object-version": "revision+1/two", "set-cookie": "backend=private",
        "x-middleware-rewrite": BACKEND + path,
      },
    });
  });
  assert.equal(calls, 1);
  assert.deepEqual(timeouts, [25_000]);
  assert.equal(response.headers.get("x-attachment-object-version"), "revision+1/two");
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-middleware-rewrite"), null);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), new Uint8Array([1, 2, 3]));
});

test("a private-object redirect cannot expose another origin to the native caller", async () => {
  const source = request(`${ATTACHMENTS}/${ID}/chunks/0?version=v1`);
  const prepared = await prepareVercelApiRequest(source, null, ENABLED);
  assert.equal(prepared instanceof Response, false);
  let cancelled = false;
  const response = await fetchPreparedVercelApiRequest(source, prepared, async () => new Response(
    new ReadableStream({ cancel() { cancelled = true; } }),
    { status: 302, headers: { location: "https://private-r2.example/object?signature=not-real" } },
  ));
  await rejection(response, 502, "api_backend_redirect_forbidden");
  assert.equal(cancelled, true);
});

test("the integration source keeps attachment activation explicit at the environment boundary", async () => {
  const source = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  assert.match(source, /attachmentV2Enabled:\s*process\.env\.CRM_ATTACHMENT_V2_PROXY_ENABLED/u);
});

test("client-supplied Sites authorization cannot cross the BFF under header-case or duplicate aliases", async () => {
  for (const authorization of [
    "Bearer synthetic-device-fixture",
    "Scanner sc1:synthetic-fixture-not-a-valid-signature",
  ]) {
    const headers = new Headers({ authorization });
    headers.append("OAI-Sites-Authorization", "first-synthetic-sites-fixture");
    headers.append("oai-sites-authorization", "second-synthetic-sites-fixture");
    headers.set("oai-authenticated-user-email", "spoof@example.test");
    headers.set(INTERNAL_API_ASSERTION_HEADER, "client-supplied-assertion");
    headers.set("x-27pm-attachment-transport", "chunked-v2");
    const path = authorization.startsWith("Scanner")
      ? `${SCANNER}heartbeat` : `${ATTACHMENTS}/${ID}/manifest`;
    const source = new Request(ORIGIN + path, { headers });
    const prepared = await prepareVercelApiRequest(source, "unrelated@example.test", ENABLED);
    assert.equal(prepared instanceof Response, false);
    assert.equal(prepared.headers.get("oai-sites-authorization"), null);
    assert.equal(prepared.headers.get("oai-authenticated-user-email"), null);
    assert.equal(prepared.headers.get(INTERNAL_API_ASSERTION_HEADER), null);
    assert.equal(prepared.headers.get("authorization"), authorization);
    assert.equal(prepared.headers.get("x-27pm-attachment-transport"), "chunked-v2");
  }
});

test("OAI and current or legacy internal response namespaces never reach public API callers", async () => {
  const privateHeaders = [
    "OAI-Sites-Authorization", "OaI-Authenticated-User-Email", "OAI-Authenticated-User-Full-Name",
    "OAI-Authenticated-User-Full-Name-Encoding", "OAI-Session-Token", "OAI-Unknown-Future-Header",
    "X-27PM-Internal-Assertion", "x-27pm-internal-subject", "x-27pm-internal-future",
    "X-CRM-Internal-Assertion", "x-crm-internal-subject", "x-crm-internal-future",
  ];
  for (const path of ["/api/health", `${ATTACHMENTS}/${ID}/chunks/0?version=v1`]) {
    const source = request(path);
    const prepared = await prepareVercelApiRequest(source, null, ENABLED);
    assert.equal(prepared instanceof Response, false);
    const body = new Uint8Array([1, 2, 3]);
    const response = await fetchPreparedVercelApiRequest(source, prepared, async () => {
      const headers = new Headers({
        "content-type": "application/octet-stream", "x-attachment-object-version": "v1",
        "x-27pm-attachment-transport": "chunked-v2", "retry-after": "45",
      });
      for (const name of privateHeaders) headers.append(name, "synthetic-private-fixture");
      // Headers with mixed case and repeated representations must be deleted
      // together, not skipped by a mutation of a live Headers iterator.
      headers.append("oai-sites-authorization", "duplicate-synthetic-fixture");
      return new Response(body, { headers });
    });
    assert.equal(response.status, 200);
    for (const name of privateHeaders) assert.equal(response.headers.get(name), null, name);
    assert.equal(response.headers.get("x-attachment-object-version"), "v1");
    assert.equal(response.headers.get("x-27pm-attachment-transport"), "chunked-v2");
    assert.equal(response.headers.get("retry-after"), "45");
    assert.equal(response.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), body);
  }
});

test("stripping a client Sites credential does not remove the BFF-generated Google operator assertion", async () => {
  const source = new Request(`${ORIGIN}/api/tasks?view=today`, {
    headers: {
      origin: ORIGIN, "sec-fetch-site": "same-origin", cookie: "authjs.session-token=synthetic-fixture",
      "OAI-Sites-Authorization": "client-sites-fixture", [INTERNAL_API_ASSERTION_HEADER]: "client-assertion-fixture",
      "oai-authenticated-user-email": "spoof@example.test",
    },
  });
  const prepared = await prepareVercelApiRequest(source, "owner@example.test", ENABLED);
  assert.equal(prepared instanceof Response, false);
  const assertion = prepared.headers.get(INTERNAL_API_ASSERTION_HEADER);
  assert.ok(assertion);
  assert.notEqual(assertion, "client-assertion-fixture");
  assert.equal(prepared.headers.get("oai-sites-authorization"), null);
  assert.equal(prepared.headers.get("oai-authenticated-user-email"), null);
  assert.equal(prepared.headers.get("cookie"), null);
  assert.ok(await verifyInternalApiAssertion(CONFIG.signingKey, assertion, {
    audience: INTERNAL_API_DEFAULT_AUDIENCE, method: "GET", pathname: "/api/tasks",
    queryDigest: await internalApiBodyDigest("?view=today"),
    headerDigest: await internalApiCriticalHeadersDigest(prepared.headers),
  }));
});
