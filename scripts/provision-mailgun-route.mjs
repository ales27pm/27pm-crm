#!/usr/bin/env node

import { pathToFileURL } from "node:url";

export const MAIL_DOMAIN = "27pm.org";
export const ROUTE_DESCRIPTION =
  "27PM CRM inbound: bonjour@27pm.org + admin@27pm.org";
export const ROUTE_EXPRESSION =
  'match_recipient("^(bonjour|admin)@27pm\\.org$")';
export const ALEXIS_ROUTE_DESCRIPTION =
  "27PM CRM inbound: alexis@27pm.org";
export const ALEXIS_ROUTE_EXPRESSION =
  'match_recipient("^alexis@27pm\\.org$")';
export const COMBINED_ROUTE_DESCRIPTION =
  "27PM CRM inbound: bonjour@27pm.org + admin@27pm.org + alexis@27pm.org";
export const COMBINED_ROUTE_EXPRESSION =
  'match_recipient("^(bonjour|admin|alexis)@27pm\\.org$")';
export const ROUTE_PRIORITY = 0;

const ALLOWED_MAILGUN_API_BASES = new Set([
  "https://api.mailgun.net",
  "https://api.eu.mailgun.net",
]);
const INBOUND_PATH = "/api/webhooks/mailgun/inbound";
const HEALTH_PATH = "/api/health";
const PAGE_SIZE = 100;
const TRUSTED_INBOUND_ORIGINS = new Set([
  "https://crm.27pm.org",
  "https://crm-27pm.ales27pm.chatgpt.site",
]);

export class ProvisioningError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProvisioningError";
  }
}

function requiredEnvironmentValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ProvisioningError(`${name} is required in the environment.`);
  }
  return value.trim();
}

function parseApiBase(rawValue) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new ProvisioningError("MAILGUN_API_BASE must be a valid URL.");
  }

  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    !ALLOWED_MAILGUN_API_BASES.has(url.origin)
  ) {
    throw new ProvisioningError(
      "MAILGUN_API_BASE must be the official US or EU Mailgun HTTPS API origin.",
    );
  }

  return url.origin;
}

function parsePublicOrigin(rawValue) {
  let url;
  try {
    url = new URL(rawValue);
  } catch {
    throw new ProvisioningError("CRM_PUBLIC_ORIGIN must be a valid URL.");
  }

  if (url.protocol !== "https:") {
    throw new ProvisioningError("CRM_PUBLIC_ORIGIN must use HTTPS.");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new ProvisioningError(
      "CRM_PUBLIC_ORIGIN must be an origin only, without credentials, path, query, or fragment.",
    );
  }

  return url.origin;
}

export function configFromEnvironment(env = process.env) {
  const configuredDomain = env.MAILGUN_DOMAIN?.trim();
  if (configuredDomain && configuredDomain !== MAIL_DOMAIN) {
    throw new ProvisioningError(
      `MAILGUN_DOMAIN must remain exactly ${MAIL_DOMAIN} for this provisioner.`,
    );
  }

  const apiKey = requiredEnvironmentValue(env, "MAILGUN_API_KEY");
  const apiBase = parseApiBase(
    env.MAILGUN_API_BASE?.trim() || "https://api.mailgun.net",
  );
  const publicOrigin = parsePublicOrigin(
    requiredEnvironmentValue(env, "CRM_PUBLIC_ORIGIN"),
  );

  return {
    apiBase,
    apiKey,
    callbackUrl: new URL(INBOUND_PATH, publicOrigin).href,
    healthUrl: new URL(HEALTH_PATH, publicOrigin).href,
  };
}

export function expectedRoute(callbackUrl, mailbox = "core") {
  if (mailbox !== "core" && mailbox !== "alexis") {
    throw new ProvisioningError("Unknown managed mailbox route.");
  }
  return {
    priority: ROUTE_PRIORITY,
    description:
      mailbox === "alexis" ? ALEXIS_ROUTE_DESCRIPTION : ROUTE_DESCRIPTION,
    expression:
      mailbox === "alexis" ? ALEXIS_ROUTE_EXPRESSION : ROUTE_EXPRESSION,
    actions: [`store(notify="${callbackUrl}")`, "stop()"],
  };
}

function sameActions(actual, expected) {
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every(
      (action, index) =>
        typeof action === "string" && action.trim() === expected[index],
    )
  );
}

function hasTrustedInboundActions(actions) {
  if (!Array.isArray(actions) || actions.length !== 2 || actions[1] !== "stop()") {
    return false;
  }

  const match = /^store\(notify="([^"]+)"\)$/u.exec(actions[0]);
  if (!match) return false;

  let callback;
  try {
    callback = new URL(match[1]);
  } catch {
    return false;
  }

  return (
    callback.protocol === "https:" &&
    callback.username === "" &&
    callback.password === "" &&
    TRUSTED_INBOUND_ORIGINS.has(callback.origin) &&
    callback.pathname === INBOUND_PATH &&
    callback.search === "" &&
    callback.hash === ""
  );
}

export function classifyAlexisCoverage(routes, expectedAdditive) {
  const additive = classifyCurrentRoutes(routes, expectedAdditive);
  if (additive.kind === "conflict") return additive;

  const combinedExact = routes.filter(
    (route) =>
      route?.priority === ROUTE_PRIORITY &&
      route?.description === COMBINED_ROUTE_DESCRIPTION &&
      route?.expression === COMBINED_ROUTE_EXPRESSION &&
      hasTrustedInboundActions(route.actions),
  );
  const combinedClaimed = routes.filter(
    (route) =>
      route?.description === COMBINED_ROUTE_DESCRIPTION ||
      route?.expression === COMBINED_ROUTE_EXPRESSION,
  );

  if (combinedExact.length > 1) {
    return {
      kind: "conflict",
      reason: "More than one route already has the combined 27PM contract.",
    };
  }
  if (combinedClaimed.length !== combinedExact.length) {
    return {
      kind: "conflict",
      reason:
        "An existing route claims the combined 27PM recipients but has an untrusted contract.",
    };
  }
  if (additive.kind === "existing" && combinedExact.length === 1) {
    return {
      kind: "conflict",
      reason: "Both additive and combined routes cover alexis@27pm.org.",
    };
  }
  if (additive.kind === "existing") {
    return { ...additive, coverage: "additive" };
  }
  if (combinedExact.length === 1) {
    return { kind: "existing", route: combinedExact[0], coverage: "combined" };
  }

  if (
    routes.length === 1 &&
    routes[0]?.priority === ROUTE_PRIORITY &&
    routes[0]?.description === ROUTE_DESCRIPTION &&
    routes[0]?.expression === ROUTE_EXPRESSION &&
    hasTrustedInboundActions(routes[0].actions) &&
    typeof routes[0]?.id === "string" &&
    routes[0].id !== ""
  ) {
    return { kind: "expandable", route: routes[0] };
  }

  return { kind: "absent" };
}

export function classifyCurrentRoutes(routes, expected) {
  const exact = routes.filter(
    (route) =>
      route?.priority === expected.priority &&
      route?.expression === expected.expression &&
      sameActions(route.actions, expected.actions),
  );

  if (exact.length > 1) {
    return {
      kind: "conflict",
      reason: "More than one route already has the exact 27PM contract.",
    };
  }
  if (exact.length === 1) {
    return { kind: "existing", route: exact[0] };
  }

  const claimed = routes.filter(
    (route) =>
      route?.description === expected.description ||
      route?.expression === expected.expression,
  );
  if (claimed.length > 0) {
    return {
      kind: "conflict",
      reason:
        "An existing route claims the managed description or recipient expression but has different actions.",
    };
  }

  return { kind: "absent" };
}

function basicAuthorization(apiKey) {
  return `Basic ${Buffer.from(`api:${apiKey}`, "utf8").toString("base64")}`;
}

async function mailgunJsonRequest(fetchImpl, config, path, init = {}) {
  const url = new URL(path, `${config.apiBase}/`);
  const method = init.method ?? "GET";
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  headers.set("Authorization", basicAuthorization(config.apiKey));

  let response;
  try {
    response = await fetchImpl(url, {
      ...init,
      method,
      headers,
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ProvisioningError(
      `Mailgun ${method} ${url.pathname} failed before confirmation; inspect current routes before retrying.`,
    );
  }

  if (!response.ok) {
    throw new ProvisioningError(
      `Mailgun ${method} ${url.pathname} returned HTTP ${response.status}.`,
    );
  }

  try {
    return await response.json();
  } catch {
    throw new ProvisioningError(
      `Mailgun ${method} ${url.pathname} returned an invalid JSON response.`,
    );
  }
}

export async function listRoutes(fetchImpl, config) {
  const routes = [];
  let skip = 0;

  for (let page = 0; page < 1_000; page += 1) {
    const payload = await mailgunJsonRequest(
      fetchImpl,
      config,
      `/v3/routes?skip=${skip}&limit=${PAGE_SIZE}`,
    );
    if (!Array.isArray(payload?.items)) {
      throw new ProvisioningError(
        "Mailgun GET /v3/routes returned an invalid route list.",
      );
    }

    routes.push(...payload.items);
    const totalCount = Number(payload.total_count);
    if (!Number.isSafeInteger(totalCount) || totalCount < 0) {
      throw new ProvisioningError(
        "Mailgun GET /v3/routes returned an invalid total count.",
      );
    }
    if (routes.length >= totalCount) {
      return routes;
    }
    if (payload.items.length === 0) {
      throw new ProvisioningError(
        "Mailgun route pagination ended before total_count was reached.",
      );
    }

    skip += payload.items.length;
  }

  throw new ProvisioningError("Mailgun route pagination exceeded its safety limit.");
}

async function assertCheckpointHealthy(fetchImpl, healthUrl) {
  let response;
  try {
    response = await fetchImpl(healthUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
    });
  } catch {
    throw new ProvisioningError(
      "The deployed CRM health checkpoint is unreachable; the Mailgun route was not created.",
    );
  }

  if (!response.ok) {
    throw new ProvisioningError(
      `The deployed CRM health checkpoint returned HTTP ${response.status}; the Mailgun route was not created.`,
    );
  }
}

async function createRoute(fetchImpl, config, route) {
  const body = new URLSearchParams();
  body.set("priority", String(route.priority));
  body.set("description", route.description);
  body.set("expression", route.expression);
  for (const action of route.actions) {
    body.append("action", action);
  }

  return mailgunJsonRequest(fetchImpl, config, "/v3/routes", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function expandHistoricalRoute(fetchImpl, config, routeId) {
  const body = new URLSearchParams();
  body.set("description", COMBINED_ROUTE_DESCRIPTION);
  body.set("expression", COMBINED_ROUTE_EXPRESSION);

  return mailgunJsonRequest(
    fetchImpl,
    config,
    `/v3/routes/${encodeURIComponent(routeId)}`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  );
}

export function parseArguments(args) {
  let apply = false;
  let explicitDryRun = false;
  let help = false;
  let mailbox = "core";

  for (const argument of args) {
    if (argument === "--apply") {
      apply = true;
    } else if (argument === "--dry-run") {
      explicitDryRun = true;
    } else if (argument === "--mailbox=alexis") {
      mailbox = "alexis";
    } else if (argument === "--help" || argument === "-h") {
      help = true;
    } else {
      throw new ProvisioningError(
        "Unknown argument. Use --help to see the accepted flags.",
      );
    }
  }

  if (apply && explicitDryRun) {
    throw new ProvisioningError("Use either --apply or --dry-run, not both.");
  }
  return { apply, help, mailbox };
}

export function usage() {
  return [
    "Usage: node scripts/provision-mailgun-route.mjs [--mailbox=alexis] [--dry-run | --apply]",
    "",
    "No flag (or --dry-run): inspect Mailgun routes and print the planned change.",
    "--mailbox=alexis: manage only the non-overlapping alexis@27pm.org route.",
    "--apply: create the exact 27PM route only when it is absent and conflict-free.",
  ].join("\n");
}

export async function runProvisioner({
  args = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  log = console.log,
} = {}) {
  const { apply, help, mailbox } = parseArguments(args);
  if (help) {
    log(usage());
    return { status: "help" };
  }
  if (typeof fetchImpl !== "function") {
    throw new ProvisioningError("A Fetch-compatible implementation is required.");
  }

  const config = configFromEnvironment(env);
  const route = expectedRoute(config.callbackUrl, mailbox);

  log(`Mode: ${apply ? "APPLY" : "DRY RUN (read-only)"}`);
  const currentRoutes = await listRoutes(fetchImpl, config);
  log(`Inspected ${currentRoutes.length} account route(s).`);

  const current =
    mailbox === "alexis"
      ? classifyAlexisCoverage(currentRoutes, route)
      : classifyCurrentRoutes(currentRoutes, route);
  if (current.kind === "conflict") {
    throw new ProvisioningError(
      `Refusing to mutate Mailgun routes: ${current.reason} Review the account routes manually.`,
    );
  }
  if (current.kind === "existing") {
    log("No change: the exact 27PM inbound route already exists.");
    return { status: "unchanged", routeId: current.route.id ?? null };
  }

  if (current.kind === "expandable") {
    log(`Recipient filter: ${COMBINED_ROUTE_EXPRESSION}`);
    log(`Actions preserved: ${current.route.actions.join(" -> ")}`);
    if (!apply) {
      log(
        "Plan only: the one-route account would expand its exact historical route in place.",
      );
      return { status: "planned" };
    }

    await assertCheckpointHealthy(fetchImpl, config.healthUrl);
    log("Production checkpoint health check passed.");
    const original = current.route;
    await expandHistoricalRoute(fetchImpl, config, original.id);

    const verifiedRoutes = await listRoutes(fetchImpl, config);
    const verified = classifyAlexisCoverage(verifiedRoutes, route);
    if (
      verified.kind !== "existing" ||
      verified.coverage !== "combined" ||
      verified.route.id !== original.id ||
      verified.route.priority !== original.priority ||
      !sameActions(verified.route.actions, original.actions)
    ) {
      throw new ProvisioningError(
        "Mailgun accepted the route update, but the preserved combined contract could not be verified. Inspect the account route before retrying.",
      );
    }

    log(`Expanded and verified route ${original.id}.`);
    return { status: "expanded", routeId: original.id };
  }

  log(`Recipient filter: ${route.expression}`);
  log(`Actions: ${route.actions.join(" -> ")}`);
  if (!apply) {
    log("Plan only: one route would be created. Re-run with --apply after the production checkpoint is healthy.");
    return { status: "planned" };
  }

  await assertCheckpointHealthy(fetchImpl, config.healthUrl);
  log("Production checkpoint health check passed.");

  const creation = await createRoute(fetchImpl, config, route);
  const createdRouteId =
    typeof creation?.route?.id === "string" ? creation.route.id : null;

  const verifiedRoutes = await listRoutes(fetchImpl, config);
  const verified = classifyCurrentRoutes(verifiedRoutes, route);
  if (verified.kind !== "existing") {
    const rollbackHint = createdRouteId
      ? ` Route id ${createdRouteId} may need manual deletion.`
      : " Inspect Mailgun routes before retrying.";
    throw new ProvisioningError(
      `Mailgun accepted the create request, but the exact route could not be verified.${rollbackHint}`,
    );
  }

  const verifiedId = verified.route.id ?? createdRouteId;
  log(
    verifiedId
      ? `Created and verified route ${verifiedId}.`
      : "Created and verified the exact 27PM inbound route.",
  );
  return { status: "created", routeId: verifiedId ?? null };
}

function publicErrorMessage(error) {
  if (error instanceof ProvisioningError) {
    return error.message;
  }
  return "Unexpected provisioning failure. Inspect Mailgun routes before retrying.";
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  runProvisioner({ args: process.argv.slice(2) }).catch((error) => {
    console.error(publicErrorMessage(error));
    process.exitCode = 1;
  });
}
