import assert from "node:assert/strict";
import test from "node:test";

import {
  createInternalApiAssertion,
  internalApiBodyDigest,
  internalApiCriticalHeadersDigest,
} from "../lib/internal-api-auth.ts";
import {
  INTERNAL_API_ASSERTION_HEADER,
  prepareInternalApiRequest,
} from "../lib/internal-api-edge.ts";

const SECRET = Buffer.alloc(32, 12).toString("base64url");
const AUDIENCE = "27pm-sites-worker";

test("internal mode strips spoofed identity when no assertion is present", async () => {
  const request = new Request("https://api.example.test/api/dashboard", {
    headers: { "oai-authenticated-user-email": "attacker@example.com" },
  });
  const prepared = await prepareInternalApiRequest(request, environment());

  assert.ok(prepared instanceof Request);
  assert.equal(prepared.headers.get("oai-authenticated-user-email"), null);
});

test("a valid assertion is one-time and becomes the only trusted identity", async () => {
  const url = new URL("https://api.example.test/api/dashboard?window=24h");
  const queryDigest = await internalApiBodyDigest(url.search);
  const { token } = await createInternalApiAssertion(SECRET, {
    subject: "Owner@Example.com",
    audience: AUDIENCE,
    method: "GET",
    pathname: url.pathname,
    headerDigest: await internalApiCriticalHeadersDigest(new Headers()),
    queryDigest,
  });
  const request = new Request(url, {
    headers: {
      [INTERNAL_API_ASSERTION_HEADER]: token,
      "oai-authenticated-user-email": "attacker@example.com",
      origin: "https://crm.27pm.org",
      "sec-fetch-site": "same-origin",
    },
  });
  const env = environment();

  const first = await prepareInternalApiRequest(request, env);
  assert.ok(first instanceof Request);
  assert.equal(first.headers.get(INTERNAL_API_ASSERTION_HEADER), null);
  assert.equal(first.headers.get("oai-authenticated-user-email"), "owner@example.com");
  assert.equal(first.headers.get("origin"), url.origin);
  assert.equal(first.headers.get("sec-fetch-site"), "same-origin");

  const replay = await prepareInternalApiRequest(request, env);
  assert.ok(replay instanceof Response);
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { error: "internal_assertion_replayed" });
});

test("query and body changes invalidate an assertion before nonce consumption", async () => {
  const url = new URL("https://api.example.test/api/tasks?view=today");
  const body = JSON.stringify({ title: "Relance" });
  const { token } = await createInternalApiAssertion(SECRET, {
    subject: "owner@example.com",
    audience: AUDIENCE,
    method: "POST",
    pathname: url.pathname,
    headerDigest: await internalApiCriticalHeadersDigest(new Headers({
      "content-type": "application/json",
    })),
    queryDigest: await internalApiBodyDigest(url.search),
    bodyDigest: await internalApiBodyDigest(body),
  });
  const env = environment();

  for (const request of [
    new Request("https://api.example.test/api/tasks?view=all", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        [INTERNAL_API_ASSERTION_HEADER]: token,
      },
    }),
    new Request(url, {
      method: "POST",
      body: JSON.stringify({ title: "Autre" }),
      headers: {
        "content-type": "application/json",
        [INTERNAL_API_ASSERTION_HEADER]: token,
      },
    }),
  ]) {
    const response = await prepareInternalApiRequest(request, env);
    assert.ok(response instanceof Response);
    assert.equal(response.status, 401);
  }
  assert.equal(env.consumed.size, 0);
});

test("missing and unknown auth modes fail closed", async () => {
  for (const mode of [undefined, "", "legacy"]) {
    const env = environment();
    if (mode === undefined) delete env.CRM_API_AUTH_MODE;
    else env.CRM_API_AUTH_MODE = mode;
    const response = await prepareInternalApiRequest(
      new Request("https://crm.27pm.org/api/dashboard", {
        headers: { "oai-authenticated-user-email": "owner@example.com" },
      }),
      env,
    );

    assert.ok(response instanceof Response);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      error: "internal_auth_mode_invalid",
    });
  }
});

test("Sites mode trusts platform identity only at the configured origin", async () => {
  const trustedRequest = new Request("https://crm.27pm.org/api/dashboard", {
    headers: {
      [INTERNAL_API_ASSERTION_HEADER]: "client-supplied",
      "oai-authenticated-user-email": "owner@example.com",
      "oai-authenticated-user-full-name": "Owner",
      "oai-authenticated-user-full-name-encoding": "utf-8",
    },
  });
  const trusted = await prepareInternalApiRequest(
    trustedRequest,
    environment("sites"),
  );

  assert.ok(trusted instanceof Request);
  assert.equal(trusted.headers.get(INTERNAL_API_ASSERTION_HEADER), null);
  assert.equal(
    trusted.headers.get("oai-authenticated-user-email"),
    "owner@example.com",
  );
  assert.equal(trusted.headers.get("oai-authenticated-user-full-name"), "Owner");

  const backend = await prepareInternalApiRequest(
    new Request("https://crm-api.example.workers.dev/api/dashboard", {
      headers: {
        [INTERNAL_API_ASSERTION_HEADER]: "client-supplied",
        "oai-authenticated-user-email": "attacker@example.com",
        "oai-authenticated-user-full-name": "Attacker",
        "oai-authenticated-user-full-name-encoding": "utf-8",
      },
    }),
    environment("sites"),
  );
  assert.ok(backend instanceof Request);
  assert.equal(backend.headers.get(INTERNAL_API_ASSERTION_HEADER), null);
  assert.equal(backend.headers.get("oai-authenticated-user-email"), null);
  assert.equal(backend.headers.get("oai-authenticated-user-full-name"), null);
  assert.equal(
    backend.headers.get("oai-authenticated-user-full-name-encoding"),
    null,
  );
});

test("hybrid mode preserves Sites identity only when no assertion is supplied", async () => {
  const plain = new Request("https://crm.27pm.org/api/dashboard", {
    headers: { "oai-authenticated-user-email": "owner@example.com" },
  });
  const prepared = await prepareInternalApiRequest(plain, environment("hybrid"));
  assert.ok(prepared instanceof Request);
  assert.equal(
    prepared.headers.get("oai-authenticated-user-email"),
    "owner@example.com",
  );

  const forged = new Request("https://crm.27pm.org/api/dashboard", {
    headers: {
      [INTERNAL_API_ASSERTION_HEADER]: "invalid",
      "oai-authenticated-user-email": "attacker@example.com",
    },
  });
  const rejected = await prepareInternalApiRequest(forged, environment("hybrid"));
  assert.ok(rejected instanceof Response);
  assert.equal(rejected.status, 401);

  const backendOrigin = new Request("https://crm-api.example.workers.dev/api/dashboard", {
    headers: { "oai-authenticated-user-email": "attacker@example.com" },
  });
  const stripped = await prepareInternalApiRequest(
    backendOrigin,
    environment("hybrid"),
  );
  assert.ok(stripped instanceof Request);
  assert.equal(stripped.headers.get("oai-authenticated-user-email"), null);

  const missingTrustedOrigin = environment("hybrid");
  delete missingTrustedOrigin.CRM_SITES_TRUSTED_ORIGIN;
  const failClosed = await prepareInternalApiRequest(plain, missingTrustedOrigin);
  assert.ok(failClosed instanceof Request);
  assert.equal(failClosed.headers.get("oai-authenticated-user-email"), null);
});

function environment(mode = "internal") {
  const consumed = new Set();
  return {
    CRM_API_AUTH_MODE: mode,
    CRM_INTERNAL_API_AUDIENCE: AUDIENCE,
    CRM_INTERNAL_API_SIGNING_KEY: SECRET,
    CRM_SITES_TRUSTED_ORIGIN: "https://crm.27pm.org",
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
