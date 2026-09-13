import assert from "node:assert/strict";
import test from "node:test";

import {
  CAKEMAIL_PREFLIGHT_API_ORIGIN,
  CAKEMAIL_PREFLIGHT_MAX_OPENAPI_BYTES,
  CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT,
  CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT_PERIOD,
  CAKEMAIL_PREFLIGHT_WEBHOOK_URL,
  CAKEMAIL_REQUIRED_WEBHOOK_EVENTS,
  CakemailPreflightError,
  preflightCakemailActivation,
  preflightConfigFromEnvironment,
  runPreflight,
} from "../scripts/preflight-cakemail-activation.mjs";

const NOW_MS = Date.parse("2026-09-12T16:00:00.000Z");
const ACCOUNT_ID = 27;
const LIST_ID = 42;
const PREFLIGHT_PAT = `ck_pat_${"a".repeat(40)}`;
const RUNTIME_PAT = `ck_pat_${"b".repeat(40)}`;
const PREFLIGHT_PREFIX = PREFLIGHT_PAT.slice(0, 12);
const RUNTIME_PREFIX = RUNTIME_PAT.slice(0, 12);
const WEBHOOK_SECRETS = Object.fromEntries(
  CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.map((event, index) => [
    event,
    [`webhook-secret-${index}`],
  ]),
);
const VALID_ENV = {
  CAKEMAIL_PREFLIGHT_PAT: PREFLIGHT_PAT,
  CAKEMAIL_PAT: RUNTIME_PAT,
  CAKEMAIL_ACCOUNT_ID: String(ACCOUNT_ID),
  CAKEMAIL_LIST_ID: String(LIST_ID),
  CAKEMAIL_SENDER_ID_BONJOUR: "sender-bonjour",
  CAKEMAIL_SENDER_ID_ALEXIS: "sender-alexis",
  CAKEMAIL_TRACKING_HOSTNAME: "links.27pm.org",
  CAKEMAIL_BOUNCE_HOSTNAME: "bounce-cakemail.27pm.org",
  CAKEMAIL_WEBHOOK_SECRETS_JSON: JSON.stringify(WEBHOOK_SECRETS),
};

test("passes every read-only activation gate without exposing credentials", async () => {
  const requests = [];
  const logs = [];
  const result = await runPreflight({
    env: VALID_ENV,
    fetchImpl: fixtureFetch(requests),
    nowMs: NOW_MS,
    log: (message) => logs.push(message),
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(
    result.gates.map(({ name, status }) => ({ name, status })),
    [
      { name: "openapi_contract", status: "pass" },
      { name: "account_email_api_quota", status: "pass" },
      { name: "list_policy", status: "pass" },
      { name: "senders", status: "pass" },
      { name: "dkim_alignment", status: "pass" },
      { name: "tracking_domain", status: "pass" },
      { name: "webhooks", status: "pass" },
      { name: "preflight_pat", status: "pass" },
      { name: "runtime_pat", status: "pass" },
    ],
  );
  assert.equal(logs.length, 1);
  const output = logs[0];
  assert.doesNotMatch(output, /ck_pat_[a-f0-9]{40}/u);
  for (const secret of Object.values(WEBHOOK_SECRETS).flat()) {
    assert.doesNotMatch(output, new RegExp(secret, "u"));
  }
  assert.match(output, /"keyPrefix":"ck_pat_aaaaa"/u);
  assert.match(output, /"keyPrefix":"ck_pat_bbbbb"/u);

  assert.ok(requests.length > 10);
  for (const { url, init } of requests) {
    assert.equal(url.origin, CAKEMAIL_PREFLIGHT_API_ORIGIN);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.body, undefined);
  }
  assert.equal(
    requests.filter(({ url }) => url.pathname === "/openapi.json").length,
    1,
  );
  assert.equal(
    requests.filter(({ url }) => url.pathname.startsWith("/webhooks/")).length,
    8,
  );
});

test("fails closed when provider identity, DKIM, tracking, webhook, or PAT metadata drift", async () => {
  const result = await preflightCakemailActivation({
    config: preflightConfigFromEnvironment(VALID_ENV),
    nowMs: NOW_MS,
    fetchImpl: fixtureFetch([], {
      account: {
        data: {
          id: "27",
          status: "suspended",
          usage_limits: {
            use_email_api: false,
            remaining: 0,
            per_month: 0,
          },
        },
      },
      list: {
        data: { id: LIST_ID, status: "archived", policy_accepted: false },
      },
      senderAlexis: {
        data: {
          id: "sender-alexis",
          email: "wrong@27pm.org",
          confirmed: false,
        },
      },
      dkimDetail: {
        data: {
          id: 9,
          selector: "cakemail",
          domain: "27pm.org",
          status: "active",
          account_default: true,
          domain_default: true,
          live_dns_status: "invalid",
        },
      },
      domains: {
        data: {
          auth: "27pm.org",
          bounce: "bounce-cakemail.27pm.org",
          dkim: "subdomain.27pm.org",
          tracking: "https://email.27pm.org",
        },
      },
      domainValidation: {
        data: {
          bounce: [{ entry: "bounce", valid: true }],
          tracking: [{ entry: "tracking", valid: false }],
        },
      },
      webhookDetailOverride: {
        event: "Email.Delivered",
        signature: {
          key: WEBHOOK_SECRETS["Email.Delivered"][0],
          hash_function: "sha1",
        },
      },
      runtimePat: {
        key_prefix: RUNTIME_PREFIX,
        name: "runtime",
        scopes: ["emailapi:send", "lists:write"],
        allowed_account_ids: null,
        status: "active",
        created_at: 1,
      },
    }),
  });

  assert.equal(result.status, "fail");
  const statuses = Object.fromEntries(
    result.gates.map(({ name, status }) => [name, status]),
  );
  assert.equal(statuses.openapi_contract, "pass");
  assert.equal(statuses.account_email_api_quota, "fail");
  assert.equal(statuses.list_policy, "fail");
  assert.equal(statuses.senders, "fail");
  assert.equal(statuses.dkim_alignment, "fail");
  assert.equal(statuses.tracking_domain, "fail");
  assert.equal(statuses.webhooks, "fail");
  assert.equal(statuses.preflight_pat, "pass");
  assert.equal(statuses.runtime_pat, "fail");
});

test("requires distinct sender IDs and a new branded tracking hostname before requests", () => {
  for (const env of [
    {
      ...VALID_ENV,
      CAKEMAIL_SENDER_ID_ALEXIS: "sender-bonjour",
    },
    {
      ...VALID_ENV,
      CAKEMAIL_TRACKING_HOSTNAME: "email.27pm.org",
    },
    {
      ...VALID_ENV,
      CAKEMAIL_TRACKING_HOSTNAME: "tracking.example.com",
    },
    {
      ...VALID_ENV,
      CAKEMAIL_BOUNCE_HOSTNAME: "email.27pm.org",
    },
    {
      ...VALID_ENV,
      CAKEMAIL_BOUNCE_HOSTNAME: VALID_ENV.CAKEMAIL_TRACKING_HOSTNAME,
    },
  ]) {
    assert.throws(
      () => preflightConfigFromEnvironment(env),
      CakemailPreflightError,
    );
  }
});

test("requires a separate runtime PAT prefix and a complete per-event secret map", () => {
  assert.throws(
    () =>
      preflightConfigFromEnvironment({
        ...VALID_ENV,
        CAKEMAIL_PAT: undefined,
      }),
    /CAKEMAIL_RUNTIME_PAT_PREFIX or CAKEMAIL_PAT is required/u,
  );
  assert.throws(
    () =>
      preflightConfigFromEnvironment({
        ...VALID_ENV,
        CAKEMAIL_WEBHOOK_SECRETS_JSON: JSON.stringify({
          "Email.Sent": ["only-one-secret"],
        }),
      }),
    /incomplete/u,
  );
});

test("requires valid bounce DNS and matching webhook root/data identifiers", async () => {
  const result = await preflightCakemailActivation({
    config: preflightConfigFromEnvironment(VALID_ENV),
    nowMs: NOW_MS,
    fetchImpl: fixtureFetch([], {
      domainValidation: {
        data: {
          bounce: [{ entry: "bounce", valid: false }],
          tracking: [{ entry: "tracking", valid: true }],
        },
      },
      webhookDetailOverride: {
        event: "Email.Delivered",
        dataId: "different-webhook-id",
        signature: {
          key: WEBHOOK_SECRETS["Email.Delivered"][0],
          hash_function: "sha256",
        },
      },
    }),
  });

  assert.equal(result.status, "fail");
  const gates = Object.fromEntries(
    result.gates.map((gate) => [gate.name, gate]),
  );
  assert.equal(gates.tracking_domain.bounceDnsValid, false);
  assert.equal(gates.tracking_domain.trackingDnsValid, true);
  assert.equal(gates.webhooks.status, "fail");
  assert.equal(
    gates.webhooks.webhooks.find(
      ({ event }) => event === "Email.Delivered",
    ).dataId,
    "different-webhook-id",
  );
});

test("rejects overprivileged or schema-invalid PAT metadata", async () => {
  const result = await preflightCakemailActivation({
    config: preflightConfigFromEnvironment(VALID_ENV),
    nowMs: NOW_MS,
    fetchImpl: fixtureFetch([], {
      preflightPat: {
        key_prefix: PREFLIGHT_PREFIX,
        name: "activation-preflight",
        scopes: [
          "dkim:read",
          "domains:read",
          "lists:read",
          "senders:read",
          "tokens:read",
          "webhooks:read",
          "lists:delete",
        ],
        allowed_account_ids: [ACCOUNT_ID],
        status: "active",
        created_at: 1,
      },
      runtimePat: {
        key_prefix: RUNTIME_PREFIX,
        name: "crm-runtime",
        scopes: ["emailapi:send"],
        allowed_account_ids: [ACCOUNT_ID],
        status: "active",
        created_at: 1,
        expires_at: "never",
      },
    }),
  });

  const gates = Object.fromEntries(
    result.gates.map((gate) => [gate.name, gate]),
  );
  assert.equal(gates.preflight_pat.status, "fail");
  assert.equal(gates.runtime_pat.status, "fail");
  assert.equal(gates.runtime_pat.expiryMetadataValid, false);
});

test("rejects occupied DKIM selectors and additional active webhooks", async () => {
  const result = await preflightCakemailActivation({
    config: preflightConfigFromEnvironment(VALID_ENV),
    nowMs: NOW_MS,
    fetchImpl: fixtureFetch([], {
      dkimDetail: {
        data: {
          id: 9,
          selector: "pdk1",
          domain: "27pm.org",
          status: "active",
          account_default: true,
          domain_default: true,
          live_dns_status: "valid",
        },
      },
      extraActiveWebhook: true,
    }),
  });

  const gates = Object.fromEntries(
    result.gates.map((gate) => [gate.name, gate]),
  );
  assert.equal(gates.dkim_alignment.selectorCollision, true);
  assert.equal(gates.dkim_alignment.status, "fail");
  assert.equal(gates.webhooks.activeRequiredSetExact, false);
  assert.equal(gates.webhooks.status, "fail");
});

test("rejects hand-built configs that bypass environment invariants", async () => {
  const config = preflightConfigFromEnvironment(VALID_ENV);
  await assert.rejects(
    preflightCakemailActivation({
      config: {
        ...config,
        runtimePatPrefix: config.preflightPatPrefix,
      },
      fetchImpl: async () => {
        throw new Error("network boundary should not be crossed");
      },
    }),
    /config is invalid/u,
  );
});

test("bounds the live OpenAPI response and performs no retry", async () => {
  let calls = 0;
  await assert.rejects(
    preflightCakemailActivation({
      config: preflightConfigFromEnvironment(VALID_ENV),
      nowMs: NOW_MS,
      fetchImpl: async () => {
        calls += 1;
        return new Response("{}", {
          status: 200,
          headers: {
            "content-length": String(CAKEMAIL_PREFLIGHT_MAX_OPENAPI_BYTES + 1),
          },
        });
      },
    }),
    /byte limit/u,
  );
  assert.equal(calls, 1);
});

test("fails closed on every refactored OpenAPI contract family", async () => {
  const mutations = [
    (document) => {
      document.paths["/accounts/self"].get.operationId = "renamedOperation";
    },
    (document) => {
      delete document.components.schemas.PatResponse.properties.scopes;
    },
    (document) => {
      document.paths["/webhooks"].post.requestBody.required = false;
    },
    (document) => {
      document.components.schemas.CreateWebhook.required = ["event"];
    },
    (document) => {
      document.components.schemas.RateLimitPeriod.enum = ["second"];
    },
    (document) => {
      document.paths["/webhooks/{webhook_id}"].delete = {
        operationId: "deleteWebhook",
      };
    },
    (document) => {
      document.components.schemas.WebhookEventType.enum = ["Email.Sent"];
    },
  ];

  for (const mutateOpenapi of mutations) {
    const result = await preflightCakemailActivation({
      config: preflightConfigFromEnvironment(VALID_ENV),
      nowMs: NOW_MS,
      fetchImpl: fixtureFetch([], { mutateOpenapi }),
    });
    assert.equal(result.gates[0].name, "openapi_contract");
    assert.equal(result.gates[0].status, "fail");
    assert.equal(result.status, "fail");
  }
});

test("accepts complete webhook pagination and rejects a changing count", async () => {
  const requests = [];
  const paginated = await preflightCakemailActivation({
    config: preflightConfigFromEnvironment(VALID_ENV),
    nowMs: NOW_MS,
    fetchImpl: fixtureFetch(requests, {
      webhookPage: ({ data, page }) => ({
        pagination: { page, per_page: 100, count: data.length },
        data: page === 1 ? data.slice(0, 4) : data.slice(4),
      }),
    }),
  });
  assert.equal(paginated.status, "pass");
  assert.equal(
    requests.filter(({ url }) => url.pathname === "/webhooks").length,
    2,
  );

  await assert.rejects(
    preflightCakemailActivation({
      config: preflightConfigFromEnvironment(VALID_ENV),
      nowMs: NOW_MS,
      fetchImpl: fixtureFetch([], {
        webhookPage: ({ data, page }) => ({
          pagination: {
            page,
            per_page: 100,
            count: page === 1 ? data.length + 1 : data.length,
          },
          data: page === 1 ? data.slice(0, 4) : data.slice(4),
        }),
      }),
    }),
    /pagination changed during the preflight/u,
  );
});

function fixtureFetch(requests, overrides = {}) {
  return async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    assert.equal(url.origin, CAKEMAIL_PREFLIGHT_API_ORIGIN);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");

    if (url.pathname === "/openapi.json") {
      assert.equal(init.headers.authorization, undefined);
      return Response.json(configuredOpenapiFixture(overrides));
    }
    assert.equal(init.headers.authorization, `Bearer ${PREFLIGHT_PAT}`);
    assert.equal(url.searchParams.get("account_id") ?? "27", "27");
    return providerFixtureResponse(url, overrides);
  };
}

function configuredOpenapiFixture(overrides) {
  const document = openapiFixture();
  if (typeof overrides.mutateOpenapi === "function") {
    overrides.mutateOpenapi(document);
  }
  return document;
}

function providerFixtureResponse(url, overrides) {
  const exactBody = exactProviderFixtureBodies(overrides).get(url.pathname);
  if (exactBody !== undefined) return Response.json(exactBody);
  if (url.pathname === "/webhooks") {
    return Response.json(webhookListFixture(url, overrides));
  }
  if (url.pathname.startsWith("/webhooks/")) {
    return Response.json(webhookDetailFixture(url, overrides));
  }
  return Response.json({}, { status: 404 });
}

function exactProviderFixtureBodies(overrides) {
  return new Map([
    [
      "/accounts/self",
      overrideFixture(overrides, "account", accountFixture()),
    ],
    [
      `/lists/${LIST_ID}`,
      overrideFixture(overrides, "list", listFixture()),
    ],
    ["/brands/default/senders/sender-bonjour", bonjourSenderFixture()],
    [
      "/brands/default/senders/sender-alexis",
      overrideFixture(overrides, "senderAlexis", alexisSenderFixture()),
    ],
    ["/brands/default/dkim", dkimListFixture()],
    [
      "/brands/default/dkim/9",
      overrideFixture(overrides, "dkimDetail", dkimDetailFixture()),
    ],
    [
      "/brands/default/domains/default",
      overrideFixture(overrides, "domains", domainsFixture()),
    ],
    [
      "/brands/default/domains/default/validate",
      overrideFixture(
        overrides,
        "domainValidation",
        domainValidationFixture(),
      ),
    ],
    [
      `/users/self/pats/${PREFLIGHT_PREFIX}`,
      overrideFixture(overrides, "preflightPat", preflightPatFixture()),
    ],
    [
      `/users/self/pats/${RUNTIME_PREFIX}`,
      overrideFixture(overrides, "runtimePat", runtimePatFixture()),
    ],
  ]);
}

function overrideFixture(overrides, name, fallback) {
  const value = overrides[name];
  return value === null || value === undefined ? fallback : value;
}

function accountFixture() {
  return {
    data: {
      id: "27",
      status: "active",
      usage_limits: {
        use_email_api: true,
        remaining: 900,
        per_month: 1_000,
      },
    },
  };
}

function listFixture() {
  return {
    data: { id: LIST_ID, status: "active", policy_accepted: true },
  };
}

function bonjourSenderFixture() {
  return {
    data: {
      id: "sender-bonjour",
      email: "bonjour@27pm.org",
      confirmed: true,
    },
  };
}

function alexisSenderFixture() {
  return {
    data: {
      id: "sender-alexis",
      email: "alexis@27pm.org",
      confirmed: true,
    },
  };
}

function dkimListFixture() {
  return {
    data: [
      {
        id: 9,
        selector: "cakemail",
        domain: "27pm.org",
        status: "active",
        account_default: true,
        domain_default: true,
      },
    ],
  };
}

function dkimDetailFixture() {
  return {
    data: {
      id: 9,
      selector: "cakemail",
      domain: "27pm.org",
      status: "active",
      account_default: true,
      domain_default: true,
      live_dns_status: "valid",
    },
  };
}

function domainsFixture() {
  return {
    data: {
      auth: "27pm.org",
      bounce: "bounce-cakemail.27pm.org",
      dkim: "27pm.org",
      tracking: "https://links.27pm.org",
    },
  };
}

function domainValidationFixture() {
  return {
    data: {
      bounce: [{ entry: "bounce", valid: true }],
      tracking: [
        { entry: "tracking-cname", valid: true },
        { entry: "tracking-txt", valid: true },
      ],
    },
  };
}

function preflightPatFixture() {
  return {
    key_prefix: PREFLIGHT_PREFIX,
    name: "activation-preflight",
    scopes: [
      "dkim:read",
      "domains:read",
      "lists:read",
      "senders:read",
      "tokens:read",
      "webhooks:read",
    ],
    allowed_account_ids: [ACCOUNT_ID],
    status: "active",
    created_at: 1,
  };
}

function runtimePatFixture() {
  return {
    key_prefix: RUNTIME_PREFIX,
    name: "crm-runtime",
    scopes: ["emailapi:send"],
    allowed_account_ids: [ACCOUNT_ID],
    status: "active",
    created_at: 1,
  };
}

function webhookListFixture(url, overrides) {
  const data = CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.map((event, index) => ({
    id: `webhook-${index}`,
    event,
    status: "active",
    url: CAKEMAIL_PREFLIGHT_WEBHOOK_URL,
  }));
  if (overrides.extraActiveWebhook) data.push(extraWebhookFixture());
  if (typeof overrides.webhookPage === "function") {
    return overrides.webhookPage({
      data,
      page: Number(url.searchParams.get("page")),
    });
  }
  return {
    pagination: { page: 1, per_page: 100, count: data.length },
    data,
  };
}

function extraWebhookFixture() {
  return {
    id: "webhook-extra",
    event: "Email.Queued",
    status: "active",
    url: CAKEMAIL_PREFLIGHT_WEBHOOK_URL,
    rate_limit: CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT,
    rate_limit_period: CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT_PERIOD,
  };
}

function webhookDetailFixture(url, overrides) {
  const index = Number(url.pathname.slice("/webhooks/webhook-".length));
  const event = CAKEMAIL_REQUIRED_WEBHOOK_EVENTS[index];
  const selectedOverride = matchingWebhookDetailOverride(overrides, event);
  const id = `webhook-${index}`;
  const signature = optionalFixtureProperty(
    selectedOverride,
    "signature",
    {
      key: WEBHOOK_SECRETS[event][0],
      hash_function: "sha256",
    },
  );
  return {
    id,
    signature,
    data: {
      id: optionalFixtureProperty(selectedOverride, "dataId", id),
      event,
      status: "active",
      url: CAKEMAIL_PREFLIGHT_WEBHOOK_URL,
      rate_limit: CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT,
      rate_limit_period: CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT_PERIOD,
    },
  };
}

function matchingWebhookDetailOverride(overrides, event) {
  const configuredOverride = overrides.webhookDetailOverride;
  if (configuredOverride?.event !== event) return null;
  return configuredOverride;
}

function optionalFixtureProperty(value, property, fallback) {
  if (value === null) return fallback;
  return overrideFixture(value, property, fallback);
}

function openapiFixture() {
  const paths = {};
  for (const [path, operationId] of [
    ["/accounts/self", "getSelfAccount"],
    ["/lists/{list_id}", "getList"],
    ["/brands/default/senders/{sender_id}", "getSender"],
    ["/brands/default/dkim", "list_dkim_keys_brands_default_dkim_get"],
    ["/brands/default/dkim/{id}", "get_dkim_key_brands_default_dkim__id__get"],
    ["/brands/default/domains/default", "showDomains"],
    ["/brands/default/domains/default/validate", "validateDomains"],
    ["/webhooks", "listWebhooks"],
    ["/webhooks/{webhook_id}", "getWebhook"],
    [
      "/users/self/pats/{key_prefix}",
      "show_pat_endpoint_users_self_pats__key_prefix__get",
    ],
  ]) {
    paths[path] = { get: { operationId } };
  }
  paths["/webhooks"].post = {
    operationId: "createWebhook",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: { $ref: "#/components/schemas/CreateWebhook" },
        },
      },
    },
  };
  paths["/webhooks/{webhook_id}/archive"] = {
    post: { operationId: "archiveWebhook" },
  };
  const schema = (...fields) => ({
    properties: Object.fromEntries(fields.map((field) => [field, {}])),
  });
  return {
    openapi: "3.1.0",
    info: { title: "Cakemail API", version: "1.25.3" },
    paths,
    components: {
      schemas: {
        AccountFullResponse: schema("usage_limits"),
        UsageLimitsResponse: schema("remaining", "use_email_api"),
        ListFullResponse: schema("policy_accepted"),
        SenderFullResponse: schema("confirmed"),
        DkimKeyFullResponse: schema("live_dns_status"),
        DomainsFullResponse: schema("dkim", "tracking"),
        WebhookResponse: schema("signature"),
        SignatureInfo: schema("key", "hash_function"),
        PatResponse: schema("scopes", "allowed_account_ids"),
        SignatureHashFunction: { enum: ["sha256"] },
        WebhookEventType: { enum: [...CAKEMAIL_REQUIRED_WEBHOOK_EVENTS] },
        EventType: { enum: [...CAKEMAIL_REQUIRED_WEBHOOK_EVENTS] },
        CreateWebhook: {
          required: ["event", "url"],
          properties: {
            event: { $ref: "#/components/schemas/WebhookEventType" },
            rate_limit: {
              default: CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT,
            },
            rate_limit_period: {
              allOf: [{ $ref: "#/components/schemas/RateLimitPeriod" }],
              default: CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT_PERIOD,
            },
          },
        },
        RateLimitPeriod: { enum: ["second", "minute"] },
      },
    },
  };
}
