import assert from "node:assert/strict";
import test from "node:test";

import {
  auditMailgunDeliverability,
  configFromEnvironment,
  MailgunAuditError,
  MAILGUN_AUDIT_DOMAIN,
  MAILGUN_AUDIT_MAX_RESPONSE_BYTES,
  parseArguments,
  runAudit,
} from "../scripts/audit-mailgun-deliverability.mjs";

const NOW_MS = Date.parse("2026-09-11T16:00:00.000Z");
const API_KEY = "key-private-audit-credential";
const VALID_ENV = {
  MAILGUN_API_KEY: API_KEY,
  MAILGUN_DOMAIN: MAILGUN_AUDIT_DOMAIN,
  MAILGUN_API_BASE: "https://api.mailgun.net",
};

test("requires the exact audited domain, a key, and an official HTTPS API origin", async (t) => {
  assert.deepEqual(configFromEnvironment(VALID_ENV), {
    apiBase: "https://api.mailgun.net",
    apiKey: API_KEY,
    domain: "27pm.org",
  });

  for (const { label, env } of [
    { label: "empty key", env: { ...VALID_ENV, MAILGUN_API_KEY: "" } },
    {
      label: "missing key",
      env: { ...VALID_ENV, MAILGUN_API_KEY: undefined },
    },
    {
      label: "missing domain",
      env: { ...VALID_ENV, MAILGUN_DOMAIN: undefined },
    },
    {
      label: "case-changed domain",
      env: { ...VALID_ENV, MAILGUN_DOMAIN: "27PM.ORG" },
    },
    {
      label: "whitespace-padded domain",
      env: { ...VALID_ENV, MAILGUN_DOMAIN: " 27pm.org " },
    },
  ]) {
    await t.test(label, () => {
      assert.throws(() => configFromEnvironment(env), MailgunAuditError);
    });
  }

  for (const apiBase of [
    "http://api.mailgun.net",
    "https://mailgun.example",
    "https://api.mailgun.net/v3",
    "https://user:password@api.mailgun.net",
    "https://api.mailgun.net:444",
  ]) {
    await t.test(apiBase, () => {
      assert.throws(
        () => configFromEnvironment({ ...VALID_ENV, MAILGUN_API_BASE: apiBase }),
        MailgunAuditError,
      );
    });
  }
});

test("bounds the Events window, page size, and page cap", () => {
  const defaults = parseArguments([], NOW_MS);
  assert.equal(defaults.endMs, NOW_MS);
  assert.equal(defaults.endMs - defaults.beginMs, 7 * 24 * 60 * 60 * 1_000);
  assert.equal(defaults.pageSize, 300);
  assert.equal(defaults.pageCap, 20);

  const explicit = parseArguments(
    [
      "--begin=2026-09-01T12:00:00-04:00",
      "--end=2026-09-02T12:00:00-04:00",
      "--limit=25",
      "--max-pages=4",
    ],
    NOW_MS,
  );
  assert.deepEqual(
    {
      begin: explicit.begin,
      end: explicit.end,
      pageSize: explicit.pageSize,
      pageCap: explicit.pageCap,
    },
    {
      begin: "2026-09-01T16:00:00.000Z",
      end: "2026-09-02T16:00:00.000Z",
      pageSize: 25,
      pageCap: 4,
    },
  );

  for (const args of [
    ["--limit=301"],
    ["--limit=0"],
    ["--max-pages=101"],
    ["--max-pages=0"],
    ["--begin=2026-08-01T00:00:00Z", "--end=2026-09-11T00:00:00Z"],
    ["--begin=2026-09-02T00:00:00Z", "--end=2026-09-01T00:00:00Z"],
    ["--end=2026-09-11T17:00:00Z"],
    ["--begin=2026-09-01"],
    ["--begin=2026-09-01T00:00:00Z", "--begin=2026-09-02T00:00:00Z"],
    ["--unknown"],
  ]) {
    assert.throws(() => parseArguments(args, NOW_MS), MailgunAuditError);
  }
});

test("uses only bounded GET requests and returns aggregate redacted telemetry", async () => {
  const options = parseArguments(
    [
      "--begin=2026-09-10T16:00:00Z",
      "--end=2026-09-11T16:00:00Z",
      "--limit=2",
      "--max-pages=3",
    ],
    NOW_MS,
  );
  const requests = [];
  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    return auditFixtureResponse(url, options);
  };

  const logs = [];
  const result = await runAudit({
    args: [
      "--begin=2026-09-10T16:00:00Z",
      "--end=2026-09-11T16:00:00Z",
      "--limit=2",
      "--max-pages=3",
    ],
    env: VALID_ENV,
    fetchImpl,
    nowMs: NOW_MS,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result.events.byEvent, {
    complained: 1,
    delivered: 1,
    failed: 1,
  });
  assert.deepEqual(result.events.bySeverity, { none: 2, permanent: 1 });
  assert.deepEqual(result.events.byReason, { espblock: 1, none: 2 });
  assert.deepEqual(result.events.byProvider, {
    google: 1,
    microsoft: 1,
    yahoo: 1,
  });
  assert.deepEqual(result.events.byIp, {
    "159.135.228.14": 2,
    "159.135.228.15": 1,
  });
  assert.deepEqual(result.events.byDomain, {
    "gmail.com": 1,
    "outlook.com": 1,
    "yahoo.com": 1,
  });
  assert.equal(result.events.byTag["crm-prospecting"], 1);
  assert.equal(result.events.byTag["campaign-remediation"], 1);
  assert.equal(result.events.byTag.untagged, 1);
  assert.equal(result.events.byTag.redacted, 1);
  assert.deepEqual(result.suppressions, {
    bounces: { count: 3, pages: 2 },
    complaints: { count: 1, pages: 1 },
    unsubscribes: { count: 0, pages: 1 },
    total: 4,
  });

  assert.equal(logs.length, 1);
  assertRedactedAuditOutput(logs[0]);
  assertBoundedAuditRequests(requests);
});

test("fails closed before following untrusted or unbounded Events paging URLs", async (t) => {
  const options = parseArguments(
    [
      "--begin=2026-09-10T16:00:00Z",
      "--end=2026-09-11T16:00:00Z",
      "--limit=2",
      "--max-pages=2",
    ],
    NOW_MS,
  );
  const cases = [
    "https://attacker.example/v3/27pm.org/events?limit=2",
    "https://api.mailgun.net/v3/27pm.org/bounces?limit=2",
    "https://api.mailgun.net/v3/27pm.org/events?begin=0&limit=2",
  ];

  for (const next of cases) {
    await t.test(next, async () => {
      let requests = 0;
      await assert.rejects(
        auditMailgunDeliverability({
          config: configFromEnvironment(VALID_ENV),
          options,
          generatedAt: new Date(NOW_MS).toISOString(),
          fetchImpl: async () => {
            requests += 1;
            return jsonResponse({
              items: [{ event: "delivered" }],
              paging: { next },
            });
          },
        }),
        MailgunAuditError,
      );
      assert.equal(requests, 1);
    });
  }
});

test("enforces the page cap and rejects malformed Mailgun schemas", async () => {
  const options = parseArguments(
    [
      "--begin=2026-09-10T16:00:00Z",
      "--end=2026-09-11T16:00:00Z",
      "--limit=1",
      "--max-pages=2",
    ],
    NOW_MS,
  );
  let pageRequests = 0;
  await assert.rejects(
    auditMailgunDeliverability({
      config: configFromEnvironment(VALID_ENV),
      options,
      generatedAt: new Date(NOW_MS).toISOString(),
      fetchImpl: async (input) => {
        pageRequests += 1;
        const url = new URL(input);
        const nextPage = Number(url.searchParams.get("page") || "1") + 1;
        return jsonResponse({
          items: [{ event: "delivered" }],
          paging: {
            next: eventsPageUrl(options, nextPage, 1),
          },
        });
      },
    }),
    /page cap/u,
  );
  assert.equal(pageRequests, 2);

  let schemaRequests = 0;
  await assert.rejects(
    auditMailgunDeliverability({
      config: configFromEnvironment(VALID_ENV),
      options,
      generatedAt: new Date(NOW_MS).toISOString(),
      fetchImpl: async (input) => {
        schemaRequests += 1;
        const url = new URL(input);
        if (url.pathname.endsWith("/events")) {
          return jsonResponse({ items: [], paging: {} });
        }
        return jsonResponse({ items: "not-an-array", paging: {} });
      },
    }),
    /invalid items schema/u,
  );
  assert.equal(schemaRequests, 2);
});

test("rejects oversized responses before reading or parsing their content", async (t) => {
  const options = oneDayAuditOptions();

  await t.test("advertised content length", async () => {
    let bodyAccessed = false;
    const oversizedResponse = {
      ok: true,
      status: 200,
      headers: new Headers({
        "content-length": String(MAILGUN_AUDIT_MAX_RESPONSE_BYTES + 1),
      }),
      get body() {
        bodyAccessed = true;
        throw new Error("response body must not be accessed");
      },
    };

    await assert.rejects(
      auditMailgunDeliverability({
        config: configFromEnvironment(VALID_ENV),
        options,
        generatedAt: new Date(NOW_MS).toISOString(),
        fetchImpl: async () => oversizedResponse,
      }),
      (error) => {
        assert.match(error.message, /response size limit/u);
        assert.doesNotMatch(error.message, new RegExp(API_KEY, "u"));
        return true;
      },
    );
    assert.equal(bodyAccessed, false);
  });

  await t.test("chunked body without content length", async () => {
    const oversizedBytes = new Uint8Array(
      MAILGUN_AUDIT_MAX_RESPONSE_BYTES + 1,
    );
    oversizedBytes.fill("{".charCodeAt(0));
    const response = new Response(oversizedBytes, {
      headers: { "content-type": "application/json" },
      status: 200,
    });

    await assert.rejects(
      auditMailgunDeliverability({
        config: configFromEnvironment(VALID_ENV),
        options,
        generatedAt: new Date(NOW_MS).toISOString(),
        fetchImpl: async () => response,
      }),
      /response size limit/u,
    );
  });
});

test("keeps transport failures and provider error bodies credential-safe", async (t) => {
  const options = oneDayAuditOptions();

  await t.test("transport failure", async () => {
    await assert.rejects(
      auditMailgunDeliverability({
        config: configFromEnvironment(VALID_ENV),
        options,
        generatedAt: new Date(NOW_MS).toISOString(),
        fetchImpl: async () => {
          throw new Error(`provider leaked ${API_KEY}`);
        },
      }),
      (error) => safeAuditError(error, /failed before a response/u),
    );
  });

  await t.test("HTTP error response", async () => {
    const providerSecret = "provider-private-error-body";
    await assert.rejects(
      auditMailgunDeliverability({
        config: configFromEnvironment(VALID_ENV),
        options,
        generatedAt: new Date(NOW_MS).toISOString(),
        fetchImpl: async () =>
          new Response(JSON.stringify({ message: providerSecret }), {
            status: 401,
          }),
      }),
      (error) => {
        assert.equal(safeAuditError(error, /HTTP 401/u), true);
        assert.doesNotMatch(error.message, new RegExp(providerSecret, "u"));
        return true;
      },
    );
  });
});

function oneDayAuditOptions() {
  return parseArguments(
    [
      "--begin=2026-09-10T16:00:00Z",
      "--end=2026-09-11T16:00:00Z",
      "--limit=2",
      "--max-pages=2",
    ],
    NOW_MS,
  );
}

function safeAuditError(error, expectedMessage) {
  assert.ok(error instanceof MailgunAuditError);
  assert.match(error.message, expectedMessage);
  assert.doesNotMatch(error.message, new RegExp(API_KEY, "u"));
  return true;
}

function assertRedactedAuditOutput(output) {
  for (const privateValue of [
    API_KEY,
    "private.person",
    "second.private",
    "third.private",
    "hidden-one",
    "hidden-two",
    "hidden-complaint",
    "raw-private-payload",
  ]) {
    assert.doesNotMatch(output, new RegExp(privateValue, "u"));
  }
}

function assertBoundedAuditRequests(requests) {
  assert.equal(requests.length, 6);
  for (const { url, init } of requests) {
    assert.equal(init.method, "GET");
    assert.equal(init.body, undefined);
    assert.equal(init.redirect, "error");
    assert.equal(url.origin, "https://api.mailgun.net");
    assert.match(
      url.pathname,
      /^\/v3\/27pm\.org\/(?:events(?:\/[a-zA-Z0-9._~+=-]+)?|bounces|complaints|unsubscribes)$/u,
    );
    assertBoundedRequestLimit(url);
  }
}

function assertBoundedRequestLimit(url) {
  const limit = Number(url.searchParams.get("limit"));
  assert.equal(Number.isInteger(limit), true);
  assert.ok(limit >= 1);
  assert.ok(limit <= 2);
}

function auditFixtureResponse(url, options) {
  if (url.pathname.includes("/events")) {
    return eventFixtureResponse(url, options);
  }
  const endpoint = url.pathname.split("/").at(-1);
  const handler = SUPPRESSION_FIXTURE_HANDLERS.get(endpoint);
  if (!handler) throw new Error("unexpected_test_endpoint");
  return handler(url);
}

function eventFixtureResponse(url, options) {
  if (url.pathname.endsWith("/cursor-2")) {
    return jsonResponse({
      items: [
        {
          event: "complained",
          recipient: "third.private@yahoo.com",
          ip: "159.135.228.14",
          tags: ["campaign-remediation"],
        },
      ],
      paging: {},
    });
  }
  return jsonResponse({
    items: [
      {
        event: "delivered",
        recipient: "private.person@outlook.com",
        ip: "159.135.228.14",
        tags: ["crm-prospecting", "private.person@example.com"],
        provider_payload: "raw-private-payload",
      },
      {
        event: "failed",
        severity: "permanent",
        reason: "espblock",
        recipient: "second.private@gmail.com",
        envelope: { "sending-ip": "159.135.228.15" },
      },
    ],
    paging: { next: eventsPageUrl(options, 2) },
  });
}

function bounceFixtureResponse(url) {
  if (url.searchParams.get("page") === "2") {
    return jsonResponse({ items: [{}], paging: {} });
  }
  return jsonResponse({
    items: [
      { address: "hidden-one@example.com" },
      { address: "hidden-two@example.com" },
    ],
    paging: {
      next: "https://api.mailgun.net/v3/27pm.org/bounces?page=2&limit=2",
    },
  });
}

function complaintFixtureResponse() {
  return jsonResponse({
    items: [{ address: "hidden-complaint@example.com" }],
    paging: {},
  });
}

function unsubscribeFixtureResponse() {
  return jsonResponse({ items: [], paging: {} });
}

const SUPPRESSION_FIXTURE_HANDLERS = new Map([
  ["bounces", bounceFixtureResponse],
  ["complaints", complaintFixtureResponse],
  ["unsubscribes", unsubscribeFixtureResponse],
]);

function eventsPageUrl(options, page, limit = options.pageSize) {
  const url = new URL(
    `https://api.mailgun.net/v3/27pm.org/events/cursor-${page}`,
  );
  url.searchParams.set("begin", String(Math.floor(options.beginMs / 1_000)));
  url.searchParams.set("end", String(Math.floor(options.endMs / 1_000)));
  url.searchParams.set("limit", String(limit));
  return url.href;
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { "content-type": "application/json" },
    status: 200,
  });
}
