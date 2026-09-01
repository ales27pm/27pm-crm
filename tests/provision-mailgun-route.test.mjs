import assert from "node:assert/strict";
import test from "node:test";

import {
  ALEXIS_ROUTE_DESCRIPTION,
  ALEXIS_ROUTE_EXPRESSION,
  COMBINED_ROUTE_DESCRIPTION,
  COMBINED_ROUTE_EXPRESSION,
  ROUTE_DESCRIPTION,
  ROUTE_EXPRESSION,
  expectedRoute,
  runProvisioner,
} from "../scripts/provision-mailgun-route.mjs";

const SECRET = "key-secret-that-must-not-be-printed";
const ORIGIN = "https://crm.27pm.org";
const CALLBACK = `${ORIGIN}/api/webhooks/mailgun/inbound`;
const ENV = Object.freeze({
  MAILGUN_API_KEY: SECRET,
  MAILGUN_API_BASE: "https://api.mailgun.net",
  MAILGUN_DOMAIN: "27pm.org",
  CRM_PUBLIC_ORIGIN: ORIGIN,
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function exactRoute(id = "route-27pm") {
  return { id, ...expectedRoute(CALLBACK) };
}

function exactAlexisRoute(id = "route-27pm-alexis") {
  return { id, ...expectedRoute(CALLBACK, "alexis") };
}

function exactCombinedRoute(id = "route-27pm") {
  return {
    id,
    priority: 0,
    description: COMBINED_ROUTE_DESCRIPTION,
    expression: COMBINED_ROUTE_EXPRESSION,
    actions: [`store(notify="${CALLBACK}")`, "stop()"],
  };
}

test("recipient expression accepts only the two lowercase 27pm.org mailboxes", () => {
  const prefix = 'match_recipient("';
  const pattern = ROUTE_EXPRESSION.slice(prefix.length, -2);
  const recipient = new RegExp(pattern);

  assert.equal(recipient.test("bonjour@27pm.org"), true);
  assert.equal(recipient.test("admin@27pm.org"), true);
  assert.equal(recipient.test("hello@27pm.org"), false);
  assert.equal(recipient.test("bonjour+test@27pm.org"), false);
  assert.equal(recipient.test("bonjour@sub.27pm.org"), false);
  assert.equal(recipient.test("Bonjour@27pm.org"), false);
});

test("the additive Alexis route is exact and cannot overlap the historical route", () => {
  const prefix = 'match_recipient("';
  const historical = new RegExp(ROUTE_EXPRESSION.slice(prefix.length, -2));
  const alexis = new RegExp(ALEXIS_ROUTE_EXPRESSION.slice(prefix.length, -2));

  assert.equal(historical.test("alexis@27pm.org"), false);
  assert.equal(alexis.test("alexis@27pm.org"), true);
  assert.equal(alexis.test("bonjour@27pm.org"), false);
  assert.equal(alexis.test("admin@27pm.org"), false);
  assert.equal(alexis.test("Alexis@27pm.org"), false);
  assert.equal(alexis.test("alexis+test@27pm.org"), false);
  assert.equal(alexis.test("alexis@sub.27pm.org"), false);
});

test("Alexis dry run plans a guarded in-place expansion for a one-route account", async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    return jsonResponse({ total_count: 1, items: [exactRoute("historical")] });
  };

  const result = await runProvisioner({
    args: ["--mailbox=alexis"],
    env: ENV,
    fetchImpl,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { status: "planned" });
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
  assert.match(logs.join("\n"), /bonjour\|admin\|alexis/);
  assert.match(logs.join("\n"), /expand its exact historical route in place/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET));
});

test("Alexis apply creates and verifies only the additive exact route", async () => {
  const calls = [];
  let routeListReadCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url, method, init });

    if (url.href === `${ORIGIN}/api/health` && method === "GET") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v3/routes" && method === "GET") {
      routeListReadCount += 1;
      const items = routeListReadCount === 1
        ? []
        : [exactAlexisRoute()];
      return jsonResponse({ total_count: items.length, items });
    }
    if (url.pathname === "/v3/routes" && method === "POST") {
      return jsonResponse({ message: "created", route: exactAlexisRoute() });
    }

    throw new Error(`Unexpected fake request: ${method} ${url.href}`);
  };

  const result = await runProvisioner({
    args: ["--mailbox=alexis", "--apply"],
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.deepEqual(result, {
    status: "created",
    routeId: "route-27pm-alexis",
  });
  const post = calls.find((call) => call.method === "POST");
  assert.ok(post);
  assert.equal(post.init.body.get("description"), ALEXIS_ROUTE_DESCRIPTION);
  assert.equal(post.init.body.get("expression"), ALEXIS_ROUTE_EXPRESSION);
  assert.deepEqual(post.init.body.getAll("action"), [
    `store(notify="${CALLBACK}")`,
    "stop()",
  ]);
});

test("Alexis apply expands the exact historical route and preserves its transport", async () => {
  const calls = [];
  let routeListReadCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url, method, init });

    if (url.href === `${ORIGIN}/api/health` && method === "GET") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v3/routes" && method === "GET") {
      routeListReadCount += 1;
      const items = routeListReadCount === 1
        ? [exactRoute("historical")]
        : [exactCombinedRoute("historical")];
      return jsonResponse({ total_count: 1, items });
    }
    if (url.pathname === "/v3/routes/historical" && method === "PUT") {
      return jsonResponse({
        message: "updated",
        route: exactCombinedRoute("historical"),
      });
    }

    throw new Error(`Unexpected fake request: ${method} ${url.href}`);
  };

  const result = await runProvisioner({
    args: ["--mailbox=alexis", "--apply"],
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.deepEqual(result, { status: "expanded", routeId: "historical" });
  const put = calls.find((call) => call.method === "PUT");
  assert.ok(put);
  assert.equal(put.init.body.get("description"), COMBINED_ROUTE_DESCRIPTION);
  assert.equal(put.init.body.get("expression"), COMBINED_ROUTE_EXPRESSION);
  assert.deepEqual(put.init.body.getAll("action"), []);
  assert.equal(put.init.body.get("priority"), null);
});

test("Alexis apply is idempotent when the combined route already exists", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    return jsonResponse({
      total_count: 1,
      items: [exactCombinedRoute("existing-combined")],
    });
  };

  const result = await runProvisioner({
    args: ["--mailbox=alexis", "--apply"],
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.deepEqual(result, {
    status: "unchanged",
    routeId: "existing-combined",
  });
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("Alexis apply is idempotent when the additive route already exists", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    return jsonResponse({
      total_count: 2,
      items: [exactRoute("historical"), exactAlexisRoute("existing-alexis")],
    });
  };

  const result = await runProvisioner({
    args: ["--mailbox=alexis", "--apply"],
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.deepEqual(result, {
    status: "unchanged",
    routeId: "existing-alexis",
  });
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("default mode inspects routes and remains read-only", async () => {
  const calls = [];
  const logs = [];
  const fetchImpl = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ total_count: 0, items: [] });
  };

  const result = await runProvisioner({
    env: ENV,
    fetchImpl,
    log: (message) => logs.push(message),
  });

  assert.deepEqual(result, { status: "planned" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(new URL(calls[0].url).pathname, "/v3/routes");
  assert.match(logs.join("\n"), /DRY RUN \(read-only\)/);
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET));
});

test("--apply checks the deployed checkpoint, creates the exact route, and verifies it", async () => {
  const calls = [];
  let routeListReadCount = 0;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    calls.push({ url, method, init });

    if (url.href === `${ORIGIN}/api/health` && method === "GET") {
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/v3/routes" && method === "GET") {
      routeListReadCount += 1;
      return routeListReadCount === 1
        ? jsonResponse({ total_count: 0, items: [] })
        : jsonResponse({ total_count: 1, items: [exactRoute()] });
    }
    if (url.pathname === "/v3/routes" && method === "POST") {
      return jsonResponse({ message: "created", route: exactRoute() });
    }

    throw new Error(`Unexpected fake request: ${method} ${url.href}`);
  };

  const result = await runProvisioner({
    args: ["--apply"],
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.deepEqual(result, { status: "created", routeId: "route-27pm" });
  assert.deepEqual(
    calls.map(({ url, method }) => `${method} ${url.origin}${url.pathname}`),
    [
      "GET https://api.mailgun.net/v3/routes",
      `GET ${ORIGIN}/api/health`,
      "POST https://api.mailgun.net/v3/routes",
      "GET https://api.mailgun.net/v3/routes",
    ],
  );

  const post = calls.find((call) => call.method === "POST");
  assert.ok(post);
  assert.equal(post.init.body.get("priority"), "0");
  assert.equal(post.init.body.get("description"), ROUTE_DESCRIPTION);
  assert.equal(
    post.init.body.get("expression"),
    'match_recipient("^(bonjour|admin)@27pm\\.org$")',
  );
  assert.deepEqual(post.init.body.getAll("action"), [
    `store(notify="${CALLBACK}")`,
    "stop()",
  ]);

  const health = calls.find((call) => call.url.origin === ORIGIN);
  assert.ok(health);
  assert.equal(new Headers(health.init.headers).has("Authorization"), false);
  for (const call of calls.filter((item) => item.url.origin.includes("mailgun"))) {
    assert.match(
      new Headers(call.init.headers).get("Authorization") ?? "",
      /^Basic /,
    );
  }
});

test("--apply is idempotent when the exact route already exists", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    calls.push({ url: String(input), method: init.method ?? "GET" });
    return jsonResponse({ total_count: 1, items: [exactRoute("existing")] });
  };

  const result = await runProvisioner({
    args: ["--apply"],
    env: ENV,
    fetchImpl,
    log: () => {},
  });

  assert.deepEqual(result, { status: "unchanged", routeId: "existing" });
  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("rejects a non-HTTPS callback before making any request", async () => {
  let called = false;

  await assert.rejects(
    runProvisioner({
      env: { ...ENV, CRM_PUBLIC_ORIGIN: "http://crm.27pm.org" },
      fetchImpl: async () => {
        called = true;
        return jsonResponse({ total_count: 0, items: [] });
      },
      log: () => {},
    }),
    /CRM_PUBLIC_ORIGIN must use HTTPS/,
  );

  assert.equal(called, false);
});

test("refuses to overwrite a route that claims the exact recipients with different actions", async () => {
  const calls = [];
  const conflictingRoute = {
    id: "unsafe-route",
    description: "unrelated description",
    expression: ROUTE_EXPRESSION,
    actions: ["forward(\"https://elsewhere.example/inbound\")", "stop()"],
  };

  await assert.rejects(
    runProvisioner({
      args: ["--apply"],
      env: ENV,
      fetchImpl: async (input, init = {}) => {
        calls.push({ url: String(input), method: init.method ?? "GET" });
        return jsonResponse({ total_count: 1, items: [conflictingRoute] });
      },
      log: () => {},
    }),
    /Refusing to mutate Mailgun routes/,
  );

  assert.deepEqual(calls.map((call) => call.method), ["GET"]);
});

test("a failed production health check blocks route creation", async () => {
  const methods = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    methods.push(`${method} ${url.origin}${url.pathname}`);
    if (url.origin === ORIGIN) {
      return new Response(null, { status: 503 });
    }
    return jsonResponse({ total_count: 0, items: [] });
  };

  await assert.rejects(
    runProvisioner({
      args: ["--apply"],
      env: ENV,
      fetchImpl,
      log: () => {},
    }),
    /health checkpoint returned HTTP 503/,
  );

  assert.deepEqual(methods, [
    "GET https://api.mailgun.net/v3/routes",
    `GET ${ORIGIN}/api/health`,
  ]);
});

test("Mailgun failures do not expose the API key", async () => {
  const logs = [];
  let failure;
  try {
    await runProvisioner({
      env: ENV,
      fetchImpl: async () => jsonResponse({ message: SECRET }, 401),
      log: (message) => logs.push(message),
    });
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof Error);
  assert.match(failure.message, /HTTP 401/);
  assert.doesNotMatch(failure.message, new RegExp(SECRET));
  assert.doesNotMatch(logs.join("\n"), new RegExp(SECRET));
});

test("an accidental secret-like command argument is not echoed", async () => {
  await assert.rejects(
    runProvisioner({
      args: [`--api-key=${SECRET}`],
      env: {},
      fetchImpl: async () => {
        throw new Error("must not fetch");
      },
      log: () => {},
    }),
    (error) => {
      assert.match(error.message, /Unknown argument/);
      assert.doesNotMatch(error.message, new RegExp(SECRET));
      return true;
    },
  );
});
