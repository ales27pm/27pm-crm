import assert from "node:assert/strict";
import test from "node:test";

import {
  internalApiBodyDigest,
  internalApiCriticalHeadersDigest,
  verifyInternalApiAssertion,
} from "../lib/internal-api-auth.ts";
import {
  INTERNAL_API_ASSERTION_HEADER,
  prepareInternalApiRequest,
} from "../lib/internal-api-edge.ts";
import {
  fetchPreparedVercelApiRequest,
  prepareVercelApiRequest,
} from "../lib/vercel-api-proxy.ts";

const SECRET = Buffer.alloc(32, 19).toString("base64url");
const CONFIGURATION = {
  apiOrigin: "https://crm-worker.example.workers.dev",
  audience: "27pm-sites-worker",
  operatorAllowlist: "owner@example.com",
  signingKey: SECRET,
};

test("an authenticated same-origin request is signed for the exact backend request", async () => {
  const body = JSON.stringify({ title: "Relance" });
  const request = new Request("https://crm.27pm.org/api/tasks?view=today", {
    method: "POST",
    body,
    headers: {
      cookie: "authjs.session-token=private",
      origin: "https://crm.27pm.org",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "oai-authenticated-user-email": "attacker@example.com",
      [INTERNAL_API_ASSERTION_HEADER]: "client-supplied",
    },
  });

  const prepared = await prepareVercelApiRequest(
    request,
    "OWNER@example.com",
    CONFIGURATION,
  );
  assert.equal(prepared instanceof Response, false);
  assert.equal(
    prepared.destination.toString(),
    "https://crm-worker.example.workers.dev/api/tasks?view=today",
  );
  assert.equal(prepared.headers.get("cookie"), null);
  assert.equal(prepared.headers.get("oai-authenticated-user-email"), null);
  const assertion = prepared.headers.get(INTERNAL_API_ASSERTION_HEADER);
  assert.ok(assertion);
  assert.ok(await verifyInternalApiAssertion(
    SECRET,
    assertion,
    {
      audience: CONFIGURATION.audience,
      method: "POST",
      pathname: "/api/tasks",
      queryDigest: await internalApiBodyDigest("?view=today"),
      bodyDigest: await internalApiBodyDigest(body),
      headerDigest: await internalApiCriticalHeadersDigest(prepared.headers),
    },
  ));
});

test("cross-origin browser requests are never signed", async () => {
  const prepared = await prepareVercelApiRequest(
    new Request("https://crm.27pm.org/api/tasks", {
      method: "POST",
      body: "{}",
      headers: {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
    }),
    "owner@example.com",
    CONFIGURATION,
  );

  assert.ok(prepared instanceof Response);
  assert.equal(prepared.status, 403);
  assert.deepEqual(await prepared.json(), { error: "cross_origin_request_forbidden" });
});

test("unauthenticated mobile/public traffic is proxied without web identity", async () => {
  const prepared = await prepareVercelApiRequest(
    new Request("https://crm.27pm.org/api/mobile/token", {
      method: "POST",
      body: "grant_type=refresh_token",
      headers: {
        authorization: "Bearer mobile-token",
        cookie: "untrusted=value",
        "cf-connecting-ip": "203.0.113.10",
        forwarded: "for=203.0.113.10",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-port": "43112",
        "x-real-ip": "203.0.113.10",
        [INTERNAL_API_ASSERTION_HEADER]: "untrusted",
      },
    }),
    null,
    CONFIGURATION,
  );

  assert.equal(prepared instanceof Response, false);
  assert.equal(prepared.headers.get(INTERNAL_API_ASSERTION_HEADER), null);
  assert.equal(prepared.headers.get("cookie"), null);
  assert.equal(prepared.headers.get("authorization"), "Bearer mobile-token");
  for (const name of [
    "cf-connecting-ip",
    "forwarded",
    "x-forwarded-for",
    "x-forwarded-port",
    "x-real-ip",
  ]) assert.equal(prepared.headers.get(name), null, name);
});

test("public intake is refused at the Vercel BFF until its client-IP boundary is migrated", async () => {
  for (const pathname of ["/api/public/intake", "/api/public/intake/"]) {
    const prepared = await prepareVercelApiRequest(
      new Request(`https://crm.27pm.org${pathname}`, {
        method: "POST",
        body: "{}",
        headers: {
          origin: "https://27pm.org",
          "content-type": "application/json",
          "idempotency-key": "request-1234",
          "cf-connecting-ip": "203.0.113.99",
        },
      }),
      null,
      CONFIGURATION,
    );

    assert.ok(prepared instanceof Response);
    assert.equal(prepared.status, 503);
    assert.deepEqual(await prepared.json(), {
      error: "public_intake_requires_direct_worker",
    });
  }
});

test("critical header changes invalidate the assertion before nonce consumption", async () => {
  const body = JSON.stringify({ to: ["recipient@example.com"], text: "Bonjour" });
  const source = new Request("https://crm.27pm.org/api/messages/send", {
    method: "POST",
    body,
    headers: {
      origin: "https://crm.27pm.org",
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      "idempotency-key": "original-request",
    },
  });
  const prepared = await prepareVercelApiRequest(
    source,
    "owner@example.com",
    CONFIGURATION,
  );
  assert.equal(prepared instanceof Response, false);

  const environment = nonceEnvironment();
  for (const [name, value] of [
    ["idempotency-key", "altered-request"],
    ["content-type", "text/plain"],
  ]) {
    const alteredHeaders = new Headers(prepared.headers);
    alteredHeaders.set(name, value);
    const altered = await prepareInternalApiRequest(
      new Request(prepared.destination, {
        method: "POST",
        body,
        headers: alteredHeaders,
      }),
      environment,
    );
    assert.ok(altered instanceof Response);
    assert.equal(altered.status, 401, name);
  }
  assert.equal(environment.consumed.size, 0);

  const original = await prepareInternalApiRequest(
    new Request(prepared.destination, {
      method: "POST",
      body,
      headers: prepared.headers,
    }),
    environment,
  );
  assert.ok(original instanceof Request);
  assert.equal(original.headers.get("idempotency-key"), "original-request");
  assert.equal(original.headers.get("oai-authenticated-user-email"), "owner@example.com");
  assert.equal(environment.consumed.size, 1);
});

test("public, webhook, and bearer routes ignore an unrelated Web session", async () => {
  for (const [url, headers = {}] of [
    ["https://crm.27pm.org/api/public/unsubscribe?token=opaque"],
    ["https://crm.27pm.org/api/webhooks/mailgun/events"],
    ["https://crm.27pm.org/api/mobile/token"],
    [
      "https://crm.27pm.org/api/dashboard",
      { authorization: "Bearer mobile-token" },
    ],
  ]) {
    const prepared = await prepareVercelApiRequest(
      new Request(url, {
        headers: {
          ...headers,
          origin: "https://mail.example",
          "sec-fetch-site": "cross-site",
        },
      }),
      "owner@example.com",
      CONFIGURATION,
    );
    assert.equal(prepared instanceof Response, false, url);
    assert.equal(
      prepared.headers.get(INTERNAL_API_ASSERTION_HEADER),
      null,
      url,
    );
  }
});

test("invalid, insecure, or looping backend origins fail closed", async () => {
  const request = new Request("https://crm.27pm.org/api/dashboard", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  for (const apiOrigin of [
    undefined,
    "http://backend.example",
    "https://crm.27pm.org",
    "https://backend.example/path",
  ]) {
    const prepared = await prepareVercelApiRequest(request, null, {
      ...CONFIGURATION,
      apiOrigin,
    });
    assert.ok(prepared instanceof Response);
    assert.equal(prepared.status, 503);
  }
});

test("the BFF streams a sanitized backend response without exposing its origin", async () => {
  const source = new Request("https://crm.27pm.org/api/health", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  const prepared = await prepareVercelApiRequest(source, null, CONFIGURATION);
  assert.equal(prepared instanceof Response, false);

  const response = await fetchPreparedVercelApiRequest(
    source,
    prepared,
    async (destination, init) => {
      assert.equal(destination.toString(), "https://crm-worker.example.workers.dev/api/health");
      assert.equal(init.method, "GET");
      return new Response('{"ok":true}', {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "backend=must-not-leak",
          "x-middleware-rewrite": destination.toString(),
        },
      });
    },
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("x-middleware-rewrite"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(await response.text(), '{"ok":true}');
});

test("same-backend redirects are rebased to the public CRM origin", async () => {
  const source = new Request("https://crm.27pm.org/api/example", {
    headers: { "sec-fetch-site": "same-origin" },
  });
  const prepared = await prepareVercelApiRequest(source, null, CONFIGURATION);
  assert.equal(prepared instanceof Response, false);

  const response = await fetchPreparedVercelApiRequest(
    source,
    prepared,
    async () => new Response(null, {
      status: 307,
      headers: { location: "https://crm-worker.example.workers.dev/api/other?x=1" },
    }),
  );
  assert.equal(response.headers.get("location"), "https://crm.27pm.org/api/other?x=1");
});

test("external and cross-scheme backend redirects fail closed", async () => {
  const source = new Request("https://crm.27pm.org/api/example");
  const prepared = await prepareVercelApiRequest(source, null, CONFIGURATION);
  assert.equal(prepared instanceof Response, false);

  for (const location of [
    "https://attacker.example/collect",
    "http://crm-worker.example.workers.dev/insecure",
    "javascript:alert(1)",
  ]) {
    const response = await fetchPreparedVercelApiRequest(
      source,
      prepared,
      async () => new Response(null, {
        status: 302,
        headers: { location },
      }),
    );
    assert.equal(response.status, 502, location);
    assert.equal(response.headers.get("location"), null, location);
    assert.deepEqual(await response.json(), {
      error: "api_backend_redirect_forbidden",
    });
  }
});

function nonceEnvironment() {
  const consumed = new Set();
  return {
    CRM_API_AUTH_MODE: "internal",
    CRM_INTERNAL_API_AUDIENCE: CONFIGURATION.audience,
    CRM_INTERNAL_API_SIGNING_KEY: SECRET,
    consumed,
    DB: {
      prepare(query) {
        let values = [];
        return {
          bind(...nextValues) {
            values = nextValues;
            return this;
          },
          async run() {
            if (query.startsWith("DELETE")) {
              return { success: true, meta: { changes: 0 } };
            }
            const nonce = values[0];
            if (consumed.has(nonce)) {
              return { success: true, meta: { changes: 0 } };
            }
            consumed.add(nonce);
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
  };
}
