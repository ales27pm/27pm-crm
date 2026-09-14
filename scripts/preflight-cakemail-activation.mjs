#!/usr/bin/env node

import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";

import { parseCakemailWebhookSecrets } from "../lib/cakemail-webhook.ts";
import {
  readBoundedResponseBytes,
  ResponseByteLimitError,
} from "./read-bounded-response.mjs";

export const CAKEMAIL_PREFLIGHT_API_ORIGIN = "https://api.cakemail.dev";
export const CAKEMAIL_PREFLIGHT_WEBHOOK_URL =
  "https://crm.27pm.org/api/webhooks/cakemail/events";
export const CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT = 50;
export const CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT_PERIOD = "second";
export const CAKEMAIL_PREFLIGHT_MAX_RESPONSE_BYTES = 256 * 1_024;
export const CAKEMAIL_PREFLIGHT_MAX_OPENAPI_BYTES = 1_024 * 1_024;

export const CAKEMAIL_REQUIRED_WEBHOOK_EVENTS = Object.freeze([
  "Email.Sent",
  "Email.Delivered",
  "Email.Rejected",
  "Email.Error",
  "Email.Bounced",
  "Email.ReportedAsSpam",
  "Email.Unsubscribed",
  "Email.GlobalUnsubscribed",
]);

const API_TIMEOUT_MS = 20_000;
const ACCOUNT_DOMAIN = "27pm.org";
const WEBHOOK_PAGE_SIZE = 100;
const WEBHOOK_PAGE_CAP = 10;
const MAX_DKIM_KEYS = 100;
const MAX_DOMAIN_DKIM_KEYS = 20;
const OCCUPIED_MAILGUN_DKIM_SELECTORS = new Set(["pdk1", "pdk2"]);
const PAT = /^ck_pat_[a-f0-9]{40}$/u;
const PAT_PREFIX = /^ck_pat_[a-f0-9]{5}$/u;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/u;
const PROVIDER_ID = /^[^\u0000-\u001f\u007f-\u009f]{1,128}$/u;
const HOSTNAME =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const FORBIDDEN_TRACKING_HOSTNAMES = new Set([
  ACCOUNT_DOMAIN,
  "crm.27pm.org",
  "email.27pm.org",
  "mail.27pm.org",
  "www.27pm.org",
]);
const PREFLIGHT_REQUIRED_SCOPES = Object.freeze([
  "dkim:read",
  "domains:read",
  "lists:read",
  "senders:read",
  "tokens:read",
  "webhooks:read",
]);
// Cakemail expands a PAT requested with only `emailapi:send` to this effective
// read/send scope closure in the token metadata returned by the API.
const RUNTIME_REQUIRED_SCOPES = Object.freeze([
  "emailapi:read",
  "emailapi:send",
]);
const SENDER_ENVIRONMENT = Object.freeze([
  {
    address: "bonjour@27pm.org",
    name: "CAKEMAIL_SENDER_ID_BONJOUR",
    required: true,
  },
  {
    address: "alexis@27pm.org",
    name: "CAKEMAIL_SENDER_ID_ALEXIS",
    required: true,
  },
  {
    address: "admin@27pm.org",
    name: "CAKEMAIL_SENDER_ID_ADMIN",
    required: false,
  },
]);
const WEBHOOK_SECRET_KEYS = new Map([
  ["Email.Sent", "sent"],
  ["Email.Delivered", "delivered"],
  ["Email.Rejected", "rejected"],
  ["Email.Error", "error"],
  ["Email.Bounced", "bounced"],
  ["Email.ReportedAsSpam", "reported-as-spam"],
  ["Email.Unsubscribed", "unsubscribed"],
  ["Email.GlobalUnsubscribed", "global-unsubscribed"],
]);

const OPENAPI_OPERATIONS = new Map([
  ["/accounts/self", "getSelfAccount"],
  ["/lists/{list_id}", "getList"],
  ["/brands/default/senders/{sender_id}", "getSender"],
  ["/brands/default/dkim", "list_dkim_keys_brands_default_dkim_get"],
  ["/brands/default/dkim/{id}", "get_dkim_key_brands_default_dkim__id__get"],
  ["/brands/default/domains/default", "showDomains"],
  ["/brands/default/domains/default/validate", "validateDomains"],
  ["/webhooks", "listWebhooks"],
  ["/webhooks/{webhook_id}", "getWebhook"],
  ["/users/self/pats/{key_prefix}", "show_pat_endpoint_users_self_pats__key_prefix__get"],
]);
const OPENAPI_REQUIRED_SCHEMA_FIELDS = Object.freeze([
  ["AccountFullResponse", "usage_limits"],
  ["UsageLimitsResponse", "remaining"],
  ["UsageLimitsResponse", "use_email_api"],
  ["ListFullResponse", "policy_accepted"],
  ["SenderFullResponse", "confirmed"],
  ["DkimKeyFullResponse", "live_dns_status"],
  ["DomainsFullResponse", "dkim"],
  ["DomainsFullResponse", "tracking"],
  ["WebhookResponse", "signature"],
  ["SignatureInfo", "key"],
  ["SignatureInfo", "hash_function"],
  ["PatResponse", "scopes"],
  ["PatResponse", "allowed_account_ids"],
]);

export class CakemailPreflightError extends Error {
  constructor(message) {
    super(message);
    this.name = "CakemailPreflightError";
  }
}

export function preflightConfigFromEnvironment(env = process.env) {
  const preflightPat = requiredValue(env, "CAKEMAIL_PREFLIGHT_PAT");
  if (!PAT.test(preflightPat)) {
    throw new CakemailPreflightError("CAKEMAIL_PREFLIGHT_PAT is invalid.");
  }

  const accountId = positiveInteger(env, "CAKEMAIL_ACCOUNT_ID");
  const listId = positiveInteger(env, "CAKEMAIL_LIST_ID");
  const trackingHostname = brandedTrackingHostname(
    requiredValue(env, "CAKEMAIL_TRACKING_HOSTNAME"),
  );
  const bounceHostname = brandedTrackingHostname(
    requiredValue(env, "CAKEMAIL_BOUNCE_HOSTNAME"),
  );
  if (bounceHostname === trackingHostname) {
    throw new CakemailPreflightError(
      "Cakemail bounce and tracking hostnames must be distinct.",
    );
  }
  const runtimePatPrefix = configuredRuntimePatPrefix(env);
  const senders = configuredSenders(env);
  const webhookSecrets = configuredWebhookSecrets(env);

  return {
    accountId,
    bounceHostname,
    listId,
    preflightPat,
    preflightPatPrefix: preflightPat.slice(0, 12),
    runtimePatPrefix,
    senders,
    trackingHostname,
    webhookSecrets,
  };
}

export async function preflightCakemailActivation({
  config,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
}) {
  assertConfig(config);
  if (typeof fetchImpl !== "function") {
    throw new CakemailPreflightError(
      "A Fetch-compatible implementation is required.",
    );
  }
  if (!Number.isFinite(nowMs)) {
    throw new CakemailPreflightError("The preflight clock is invalid.");
  }

  const request = (pathname, query = undefined) =>
    fetchCakemailJson({
      fetchImpl,
      pathname,
      query,
      pat: config.preflightPat,
      maxBytes: CAKEMAIL_PREFLIGHT_MAX_RESPONSE_BYTES,
    });
  const accountQuery = { account_id: config.accountId };

  const openapi = await fetchCakemailJson({
    fetchImpl,
    pathname: "/openapi.json",
    maxBytes: CAKEMAIL_PREFLIGHT_MAX_OPENAPI_BYTES,
  });
  const contractGate = openapiContractGate(openapi);

  const [
    accountResponse,
    listResponse,
    senderResponses,
    dkimResponse,
    domainsResponse,
    domainValidationResponse,
    webhooks,
    preflightPatResponse,
    runtimePatResponse,
  ] = await Promise.all([
    request("/accounts/self"),
    request(`/lists/${config.listId}`, accountQuery),
    Promise.all(
      config.senders.map((sender) =>
        request(
          `/brands/default/senders/${encodeURIComponent(sender.id)}`,
          accountQuery,
        ),
      ),
    ),
    request("/brands/default/dkim", accountQuery),
    request("/brands/default/domains/default", accountQuery),
    request("/brands/default/domains/default/validate", accountQuery),
    fetchAllWebhooks(request, config.accountId),
    request(
      `/users/self/pats/${config.preflightPatPrefix}`,
      accountQuery,
    ),
    request(`/users/self/pats/${config.runtimePatPrefix}`, accountQuery),
  ]);

  const accountGate = accountActivationGate(accountResponse, config.accountId);
  const listGate = listActivationGate(listResponse, config.listId);
  const sendersGate = senderActivationGate(senderResponses, config.senders);
  const dkimGate = await dkimActivationGate({
    accountId: config.accountId,
    domainsResponse,
    dkimResponse,
    request,
  });
  const trackingGate = trackingActivationGate(
    domainsResponse,
    domainValidationResponse,
    config.bounceHostname,
    config.trackingHostname,
  );
  const webhooksGate = await webhookActivationGate({
    accountId: config.accountId,
    configuredSecrets: config.webhookSecrets,
    request,
    webhooks,
  });
  const preflightPatGate = patActivationGate({
    name: "preflight_pat",
    response: preflightPatResponse,
    expectedPrefix: config.preflightPatPrefix,
    expectedAccountId: config.accountId,
    requiredScopes: PREFLIGHT_REQUIRED_SCOPES,
    exactScopes: true,
    nowMs,
  });
  const runtimePatGate = patActivationGate({
    name: "runtime_pat",
    response: runtimePatResponse,
    expectedPrefix: config.runtimePatPrefix,
    expectedAccountId: config.accountId,
    requiredScopes: RUNTIME_REQUIRED_SCOPES,
    exactScopes: true,
    nowMs,
  });

  const gates = [
    contractGate,
    accountGate,
    listGate,
    sendersGate,
    dkimGate,
    trackingGate,
    webhooksGate,
    preflightPatGate,
    runtimePatGate,
  ];
  return {
    status: gates.every(({ status }) => status === "pass") ? "pass" : "fail",
    gates,
  };
}

export async function runPreflight({
  env = process.env,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  log = console.log,
} = {}) {
  const result = await preflightCakemailActivation({
    config: preflightConfigFromEnvironment(env),
    fetchImpl,
    nowMs,
  });
  log(JSON.stringify(result));
  return result;
}

function openapiContractGate(value) {
  const root = objectValue(value);
  const info = objectProperty(root, "info");
  const paths = objectProperty(root, "paths");
  const schemas = objectProperty(objectProperty(root, "components"), "schemas");
  const version = stringValue(propertyValue(info, "version"));
  const status = gateStatus([
    propertyValue(root, "openapi") === "3.1.0",
    propertyValue(info, "title") === "Cakemail API",
    nonemptyString(version),
    openapiOperationsValid(paths),
    openapiWebhookProvisioningValid(paths, schemas),
    openapiRequiredFieldsValid(schemas),
    schemaEnumIncludes(schemas, "SignatureHashFunction", ["sha256"]),
    schemaEnumIncludes(
      schemas,
      "WebhookEventType",
      CAKEMAIL_REQUIRED_WEBHOOK_EVENTS,
    ),
    schemaEnumIncludes(schemas, "EventType", CAKEMAIL_REQUIRED_WEBHOOK_EVENTS),
  ]);
  return {
    name: "openapi_contract",
    status,
    apiOrigin: CAKEMAIL_PREFLIGHT_API_ORIGIN,
    version,
  };
}

function openapiOperationsValid(paths) {
  for (const [path, operationId] of OPENAPI_OPERATIONS) {
    const operation = objectProperty(objectProperty(paths, path), "get");
    if (propertyValue(operation, "operationId") !== operationId) return false;
  }
  return true;
}

function openapiRequiredFieldsValid(schemas) {
  for (const [schemaName, field] of OPENAPI_REQUIRED_SCHEMA_FIELDS) {
    const schema = objectProperty(schemas, schemaName);
    const properties = objectProperty(schema, "properties");
    if (properties === null || !Object.hasOwn(properties, field)) return false;
  }
  return true;
}

function schemaEnumIncludes(schemas, schemaName, expectedValues) {
  const schema = objectProperty(schemas, schemaName);
  const values = arrayProperty(schema, "enum");
  return expectedValues.every((value) => values.includes(value));
}

function openapiWebhookProvisioningValid(paths, schemas) {
  const webhookCollection = objectProperty(paths, "/webhooks");
  const webhookItem = objectProperty(paths, "/webhooks/{webhook_id}");
  const webhookArchive = objectProperty(
    paths,
    "/webhooks/{webhook_id}/archive",
  );
  const createOperation = objectProperty(webhookCollection, "post");
  const archiveOperation = objectProperty(webhookArchive, "post");
  const requestBody = objectProperty(createOperation, "requestBody");
  const requestContent = objectProperty(requestBody, "content");
  const requestMedia = objectProperty(requestContent, "application/json");
  const createSchema = objectProperty(schemas, "CreateWebhook");
  const createProperties = objectProperty(createSchema, "properties");
  const eventProperty = objectProperty(createProperties, "event");
  const rateLimitProperty = objectProperty(createProperties, "rate_limit");
  const ratePeriodProperty = objectProperty(
    createProperties,
    "rate_limit_period",
  );
  const ratePeriodAllOf = arrayProperty(ratePeriodProperty, "allOf");
  const ratePeriodSchema = objectValue(ratePeriodAllOf[0]);
  const required = arrayProperty(createSchema, "required");
  const ratePeriods = arrayProperty(
    objectProperty(schemas, "RateLimitPeriod"),
    "enum",
  );
  return checksPass([
    propertyValue(createOperation, "operationId") === "createWebhook",
    propertyValue(requestBody, "required") === true,
    propertyValue(objectProperty(requestMedia, "schema"), "$ref") ===
      "#/components/schemas/CreateWebhook",
    required.includes("event"),
    required.includes("url"),
    propertyValue(eventProperty, "$ref") ===
      "#/components/schemas/WebhookEventType",
    propertyValue(rateLimitProperty, "default") ===
      CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT,
    propertyValue(ratePeriodSchema, "$ref") ===
      "#/components/schemas/RateLimitPeriod",
    propertyValue(ratePeriodProperty, "default") ===
      CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT_PERIOD,
    ratePeriods.length === 2,
    ratePeriods.includes("second"),
    ratePeriods.includes("minute"),
    propertyValue(archiveOperation, "operationId") === "archiveWebhook",
    propertyValue(webhookItem, "delete") === undefined,
  ]);
}

function accountActivationGate(value, expectedAccountId) {
  const data = dataObject(value);
  const usage = objectProperty(data, "usage_limits");
  const accountId = providerPositiveInteger(propertyValue(data, "id"));
  const providerStatus = stringValue(propertyValue(data, "status"));
  const remaining = nonnegativeInteger(propertyValue(usage, "remaining"));
  const perMonth = nonnegativeInteger(propertyValue(usage, "per_month"));
  const useEmailApi = propertyValue(usage, "use_email_api") === true;
  return {
    name: "account_email_api_quota",
    status: gateStatus([
      accountId === expectedAccountId,
      ["active", "trial"].includes(providerStatus),
      useEmailApi,
      remaining !== null,
      remaining > 0,
      perMonth !== null,
      perMonth > 0,
    ]),
    accountId,
    accountStatus: providerStatus,
    useEmailApi,
    remaining,
    perMonth,
  };
}

function listActivationGate(value, expectedListId) {
  const data = dataObject(value);
  const listId = providerPositiveInteger(propertyValue(data, "id"));
  const listStatus = stringValue(propertyValue(data, "status"));
  const policyAccepted = propertyValue(data, "policy_accepted") === true;
  return {
    name: "list_policy",
    status: gateStatus([
      listId === expectedListId,
      listStatus === "active",
      policyAccepted,
    ]),
    listId,
    listStatus,
    policyAccepted,
  };
}

function senderActivationGate(responses, configuredSenders) {
  const senders = configuredSenders.map((configured, index) =>
    senderDetail(responses[index], configured),
  );
  const returnedIds = senders.map(({ id }) => id);
  const unique = providerIdsUnique(returnedIds);
  return {
    name: "senders",
    status: gateStatus([senders.every(({ matches }) => matches), unique]),
    unique,
    senders: senders.map(({ id, email, confirmed }) => ({
      id,
      email,
      confirmed,
    })),
  };
}

function senderDetail(value, configured) {
  const data = dataObject(value);
  const id = stringValue(propertyValue(data, "id"));
  const email = stringValue(propertyValue(data, "email"));
  const confirmed = propertyValue(data, "confirmed") === true;
  return {
    id,
    email,
    confirmed,
    matches: checksPass([
      id === configured.id,
      email === configured.address,
      confirmed,
    ]),
  };
}

async function dkimActivationGate({
  accountId,
  domainsResponse,
  dkimResponse,
  request,
}) {
  const signingDomain = stringValue(
    propertyValue(dataObject(domainsResponse), "dkim"),
  );
  const listed = arrayProperty(objectValue(dkimResponse), "data");
  if (listed.length > MAX_DKIM_KEYS) {
    throw new CakemailPreflightError("Cakemail returned too many DKIM keys.");
  }
  const matching = listed.filter(
    (entry) => propertyValue(objectValue(entry), "domain") === ACCOUNT_DOMAIN,
  );
  if (matching.length > MAX_DOMAIN_DKIM_KEYS) {
    throw new CakemailPreflightError(
      "Cakemail returned too many domain DKIM keys.",
    );
  }
  const safeIds = matching
    .map((entry) => providerPositiveInteger(propertyValue(entry, "id")))
    .filter((id) => id !== null);
  const idsWellFormed = safeIds.length === matching.length;
  const uniqueIds = new Set(safeIds).size === safeIds.length;
  const details = await Promise.all(
    safeIds.map((id) =>
      request(`/brands/default/dkim/${id}`, { account_id: accountId }),
    ),
  );
  const keys = details.map((value, index) =>
    dkimKeyDetail(value, safeIds[index]),
  );
  const validKeys = keys.filter(dkimKeyValid);
  const selectedValidKeys = validKeys.filter(
    ({ domainDefault }) => domainDefault,
  );
  const selectorCollision = keys.some(
    ({ selector }) =>
      selector !== null &&
      OCCUPIED_MAILGUN_DKIM_SELECTORS.has(selector.toLowerCase()),
  );
  return {
    name: "dkim_alignment",
    status: gateStatus([
      signingDomain === ACCOUNT_DOMAIN,
      idsWellFormed,
      uniqueIds,
      !selectorCollision,
      selectedValidKeys.length > 0,
    ]),
    signingDomain,
    idsWellFormed,
    uniqueIds,
    selectorCollision,
    selectedValidKeyCount: selectedValidKeys.length,
    keys: keys.map(
      ({
        id,
        selector,
        domain,
        persistedStatus,
        liveDnsStatus,
        accountDefault,
        domainDefault,
      }) => ({
        id,
        selector,
        domain,
        persistedStatus,
        liveDnsStatus,
        accountDefault,
        domainDefault,
      }),
    ),
  };
}

function dkimKeyDetail(value, requestedId) {
  const data = dataObject(value);
  return {
    id: providerPositiveInteger(propertyValue(data, "id")),
    selector: safeProviderString(propertyValue(data, "selector")),
    domain: stringValue(propertyValue(data, "domain")),
    persistedStatus: stringValue(propertyValue(data, "status")),
    liveDnsStatus: stringValue(propertyValue(data, "live_dns_status")),
    accountDefault: propertyValue(data, "account_default") === true,
    domainDefault: propertyValue(data, "domain_default") === true,
    requestedId,
  };
}

function dkimKeyValid(key) {
  const selector = key.selector;
  const selectorAvailable =
    selector !== null &&
    !OCCUPIED_MAILGUN_DKIM_SELECTORS.has(selector.toLowerCase());
  return checksPass([
    key.id === key.requestedId,
    selectorAvailable,
    key.domain === ACCOUNT_DOMAIN,
    key.persistedStatus === "active",
    key.liveDnsStatus === "valid",
  ]);
}

function trackingActivationGate(
  domainsResponse,
  validationResponse,
  expectedBounceHostname,
  expectedHostname,
) {
  const domains = dataObject(domainsResponse);
  const providerValue = stringValue(propertyValue(domains, "tracking"));
  const configuredHostname = providerTrackingHostname(providerValue);
  const configuredBounceHostname = providerTrackingHostname(
    stringValue(propertyValue(domains, "bounce")),
  );
  const validation = objectValue(dataObject(validationResponse));
  const bounceInstructions = arrayProperty(validation, "bounce");
  const trackingInstructions = arrayProperty(validation, "tracking");
  const bounceDnsValid = domainInstructionsValid(bounceInstructions);
  const trackingDnsValid = domainInstructionsValid(trackingInstructions);
  return {
    name: "tracking_domain",
    status: gateStatus([
      configuredHostname === expectedHostname,
      configuredBounceHostname === expectedBounceHostname,
      bounceDnsValid,
      trackingDnsValid,
    ]),
    authDomain: safeProviderString(propertyValue(domains, "auth")),
    expectedBounceHostname,
    configuredBounceHostname,
    expectedHostname,
    configuredHostname,
    bounceDnsInstructionCount: bounceInstructions.length,
    trackingDnsInstructionCount: trackingInstructions.length,
    bounceDnsValid,
    trackingDnsValid,
  };
}

function domainInstructionsValid(instructions) {
  return (
    instructions.length > 0 &&
    instructions.every((entry) => {
      const instruction = objectValue(entry);
      return (
        typeof instruction?.entry === "string" &&
        instruction.entry.trim().length > 0 &&
        instruction.valid === true
      );
    })
  );
}

async function webhookActivationGate({
  accountId,
  configuredSecrets,
  request,
  webhooks,
}) {
  const summaries = webhooks.map(webhookSummary);
  const activeSummaries = summaries.filter(webhookActive);
  const activeRequiredSetExact = checksPass([
    activeSummaries.length === CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.length,
    activeSummaries.every(webhookEventRequired),
  ]);
  const activeIds = activeSummaries.map(({ id }) => id);
  const activeIdsUnique = providerIdsUnique(activeIds);
  const selected = selectRequiredWebhooks(summaries);
  const exactMultiplicity =
    selected.length === CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.length;

  const detailResponses = await Promise.all(
    selected.map((webhook) =>
      request(`/webhooks/${encodeURIComponent(webhook.id ?? "")}`, {
        account_id: accountId,
      }),
    ),
  );
  const resolvedDetails = detailResponses.map((value, index) =>
    webhookDetail(value, selected[index], configuredSecrets),
  );
  const signingKeys = resolvedDetails
    .map(({ signingKey }) => signingKey)
    .filter((signingKey) => signingKey !== null);
  const details = resolvedDetails.map(({ detail }) => detail);
  const uniqueSigningKeys =
    signingKeys.length === CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.length &&
    uniqueSecrets(signingKeys);
  return {
    name: "webhooks",
    status: gateStatus([
      exactMultiplicity,
      activeRequiredSetExact,
      activeIdsUnique,
      details.length === CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.length,
      details.every(({ matches }) => matches),
      uniqueSigningKeys,
    ]),
    expectedUrl: CAKEMAIL_PREFLIGHT_WEBHOOK_URL,
    expectedCount: CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.length,
    activeRequiredCount: selected.length,
    activeWebhookCount: activeSummaries.length,
    exactMultiplicity,
    activeRequiredSetExact,
    activeIdsUnique,
    uniqueSigningKeys,
    webhooks: details.map(
      ({
        id,
        dataId,
        event,
        status,
        url,
        rateLimit,
        rateLimitPeriod,
        hashFunction,
        signingKeyPresent,
        configuredSecretMatches,
      }) => ({
        id,
        dataId,
        event,
        status,
        url,
        rateLimit,
        rateLimitPeriod,
        hashFunction,
        signingKeyPresent,
        configuredSecretMatches,
      }),
    ),
  };
}

function webhookActive(webhook) {
  return webhook.status === "active";
}

function webhookEventRequired({ event }) {
  return CAKEMAIL_REQUIRED_WEBHOOK_EVENTS.includes(event);
}

function providerIdsUnique(ids) {
  if (ids.includes(null)) return false;
  return new Set(ids).size === ids.length;
}

function selectRequiredWebhooks(summaries) {
  const selected = [];
  for (const event of CAKEMAIL_REQUIRED_WEBHOOK_EVENTS) {
    const active = summaries.filter(
      (webhook) => webhook.event === event && webhookActive(webhook),
    );
    if (active.length === 1) selected.push(active[0]);
  }
  return selected;
}

function webhookDetail(value, summary, configuredSecrets) {
  const root = objectValue(value);
  const data = objectProperty(root, "data");
  const signature = objectProperty(root, "signature");
  const signingKey = safeSecret(propertyValue(signature, "key"));
  const secretKey = WEBHOOK_SECRET_KEYS.get(nullableString(summary.event));
  const detail = {
    id: stringValue(propertyValue(root, "id")),
    dataId: stringValue(propertyValue(data, "id")),
    event: stringValue(propertyValue(data, "event")),
    status: stringValue(propertyValue(data, "status")),
    url: stringValue(propertyValue(data, "url")),
    rateLimit: nonnegativeInteger(propertyValue(data, "rate_limit")),
    rateLimitPeriod: stringValue(propertyValue(data, "rate_limit_period")),
    hashFunction: stringValue(propertyValue(signature, "hash_function")),
    signingKeyPresent: signingKey !== null,
    configuredSecretMatches: configuredWebhookSecretMatches(
      configuredSecrets,
      secretKey,
      signingKey,
    ),
  };
  return {
    detail: {
      ...detail,
      matches: webhookDetailMatches(detail, summary),
    },
    signingKey,
  };
}

function configuredWebhookSecretMatches(configuredSecrets, secretKey, signingKey) {
  if (secretKey === undefined || signingKey === null) return false;
  const candidates = arrayValue(configuredSecrets[secretKey]);
  return candidates.some((candidate) => secretEqual(signingKey, candidate));
}

function webhookDetailMatches(detail, summary) {
  return checksPass([
    detail.id === summary.id,
    detail.dataId === summary.id,
    detail.event === summary.event,
    detail.status === "active",
    detail.url === CAKEMAIL_PREFLIGHT_WEBHOOK_URL,
    detail.rateLimit === CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT,
    detail.rateLimitPeriod === CAKEMAIL_PREFLIGHT_WEBHOOK_RATE_LIMIT_PERIOD,
    detail.hashFunction === "sha256",
    detail.signingKeyPresent,
    detail.configuredSecretMatches,
  ]);
}

function patActivationGate({
  name,
  response,
  expectedPrefix,
  expectedAccountId,
  requiredScopes,
  exactScopes = false,
  nowMs,
}) {
  const root = objectValue(response);
  const prefix = stringValue(propertyValue(root, "key_prefix"));
  const tokenStatus = stringValue(propertyValue(root, "status"));
  const scopeState = patScopeState(
    arrayProperty(root, "scopes"),
    requiredScopes,
    exactScopes,
  );
  const accountState = patAccountState(
    arrayProperty(root, "allowed_account_ids"),
    expectedAccountId,
  );
  const expiryState = patExpiryState(
    propertyValue(root, "expires_at"),
    nowMs,
  );
  return {
    name,
    status: gateStatus([
      prefix === expectedPrefix,
      tokenStatus === "active",
      expiryState.activeAtAuditTime,
      scopeState.scopesWellFormed,
      scopeState.requiredPresent,
      scopeState.scopesExact,
      accountState.accountRestricted,
    ]),
    keyPrefix: prefix,
    tokenStatus,
    scopes: scopeState.scopes,
    scopesWellFormed: scopeState.scopesWellFormed,
    allowedAccountIds: accountState.allowedAccountIds,
    expiresAt: expiryState.expiresAt,
    expiryMetadataValid: expiryState.expiryMetadataValid,
    activeAtAuditTime: expiryState.activeAtAuditTime,
    accountRestricted: accountState.accountRestricted,
  };
}

function patScopeState(rawScopes, requiredScopes, exactScopes) {
  const scopes = rawScopes.filter((scope) => typeof scope === "string");
  const scopeSet = new Set(scopes);
  const requiredPresent = requiredScopes.every((scope) => scopeSet.has(scope));
  const scopesWellFormed = checksPass([
    rawScopes.length === scopes.length,
    scopeSet.size === scopes.length,
  ]);
  const scopesExact = exactScopes
    ? checksPass([scopeSet.size === requiredScopes.length, requiredPresent])
    : true;
  return {
    requiredPresent,
    scopes: [...scopeSet].sort(),
    scopesExact,
    scopesWellFormed,
  };
}

function patAccountState(rawAccountIds, expectedAccountId) {
  const allowedAccountIds = rawAccountIds
    .map(providerPositiveInteger)
    .filter((accountId) => accountId !== null);
  return {
    allowedAccountIds,
    accountRestricted: checksPass([
      allowedAccountIds.length === 1,
      allowedAccountIds[0] === expectedAccountId,
      rawAccountIds.length === 1,
    ]),
  };
}

function patExpiryState(rawExpiresAt, nowMs) {
  const expiresAtValue = nonnegativeInteger(rawExpiresAt);
  const expiryAbsent = [null, undefined].includes(rawExpiresAt);
  const expiryMetadataValid = expiryAbsent ? true : expiresAtValue !== null;
  const expiresAt = expiryMetadataValid
    ? nullableNonnegativeInteger(rawExpiresAt)
    : null;
  const notExpired =
    expiresAt === null ? true : expiresAt * 1_000 > Math.floor(nowMs);
  const activeAtAuditTime = checksPass([expiryMetadataValid, notExpired]);
  return { activeAtAuditTime, expiresAt, expiryMetadataValid };
}

async function fetchAllWebhooks(request, accountId) {
  const webhooks = [];
  const seenIds = new Set();
  let expectedCount = null;
  for (let page = 1; page <= WEBHOOK_PAGE_CAP; page += 1) {
    const webhookPage = await fetchWebhookPage(request, accountId, page);
    expectedCount = stableWebhookCount(expectedCount, webhookPage.count);
    recordWebhookIds(webhookPage.data, seenIds);
    const data = webhookPage.data;
    webhooks.push(...data);
    if (webhookCollectionComplete(webhooks, data, expectedCount)) return webhooks;
  }
  throw new CakemailPreflightError(
    "Cakemail webhook pagination exceeded its page cap.",
  );
}

async function fetchWebhookPage(request, accountId, page) {
  const response = await request("/webhooks", {
    account_id: accountId,
    page,
    per_page: WEBHOOK_PAGE_SIZE,
    with_archived: true,
    with_count: true,
  });
  const root = objectValue(response);
  const pagination = objectProperty(root, "pagination");
  const data = arrayProperty(root, "data");
  const count = nonnegativeInteger(propertyValue(pagination, "count"));
  const valid = checksPass([
    count !== null,
    providerPositiveInteger(propertyValue(pagination, "page")) === page,
    providerPositiveInteger(propertyValue(pagination, "per_page")) ===
      WEBHOOK_PAGE_SIZE,
    count !== null && count <= WEBHOOK_PAGE_SIZE * WEBHOOK_PAGE_CAP,
    data.length <= WEBHOOK_PAGE_SIZE,
  ]);
  if (!valid || count === null) {
    throw new CakemailPreflightError(
      "Cakemail webhook pagination is invalid.",
    );
  }
  return { count, data };
}

function stableWebhookCount(expectedCount, count) {
  if (expectedCount === null) return count;
  if (count === expectedCount) return expectedCount;
  throw new CakemailPreflightError(
    "Cakemail webhook pagination changed during the preflight.",
  );
}

function recordWebhookIds(data, seenIds) {
  for (const entry of data) {
    const id = safeProviderString(propertyValue(objectValue(entry), "id"));
    if (id === null || seenIds.has(id)) {
      throw new CakemailPreflightError(
        "Cakemail webhook pagination contains an invalid duplicate.",
      );
    }
    seenIds.add(id);
  }
}

function webhookCollectionComplete(webhooks, data, expectedCount) {
  if (webhooks.length === expectedCount) return true;
  if (webhooks.length > expectedCount) {
    throw new CakemailPreflightError(
      "Cakemail webhook pagination exceeded its declared count.",
    );
  }
  if (data.length === 0) {
    throw new CakemailPreflightError(
      "Cakemail webhook pagination is incomplete.",
    );
  }
  return false;
}

async function fetchCakemailJson({
  fetchImpl,
  pathname,
  query,
  pat,
  maxBytes,
}) {
  const url = cakemailUrl(pathname, query);
  const headers = { accept: "application/json" };
  if (pat !== undefined) headers.authorization = `Bearer ${pat}`;
  const response = await fetchImpl(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(API_TIMEOUT_MS),
  });
  if (response.status !== 200) {
    throw new CakemailPreflightError(
      `Cakemail preflight received HTTP ${response.status}.`,
    );
  }
  return boundedJson(response, maxBytes);
}

function cakemailUrl(pathname, query) {
  const url = new URL(pathname, CAKEMAIL_PREFLIGHT_API_ORIGIN);
  const valid = checksPass([
    url.origin === CAKEMAIL_PREFLIGHT_API_ORIGIN,
    url.username === "",
    url.password === "",
    url.hash === "",
  ]);
  if (!valid) {
    throw new CakemailPreflightError("Cakemail preflight URL is invalid.");
  }
  if (query) {
    for (const [name, value] of Object.entries(query)) {
      url.searchParams.set(name, String(value));
    }
  }
  return url;
}

async function boundedJson(response, maxBytes) {
  assertResponseLength(response.headers.get("content-length"), maxBytes);
  if (!response.body) {
    throw new CakemailPreflightError("Cakemail preflight response is empty.");
  }
  let bytes;
  try {
    bytes = await readBoundedResponseBytes(response.body, maxBytes);
  } catch (error) {
    if (error instanceof ResponseByteLimitError) {
      throw new CakemailPreflightError(
        "Cakemail preflight response exceeded its byte limit.",
      );
    }
    throw error;
  }
  return decodeBytesAsJson(bytes);
}

function assertResponseLength(declaredLength, maxBytes) {
  if (declaredLength === null) return;
  const validLength = /^[0-9]+$/u.test(declaredLength);
  if (validLength && Number(declaredLength) <= maxBytes) return;
  throw new CakemailPreflightError(
    "Cakemail preflight response exceeded its byte limit.",
  );
}

function decodeBytesAsJson(bytes) {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    throw new CakemailPreflightError(
      "Cakemail preflight response was not valid JSON.",
    );
  }
}

function configuredSenders(env) {
  const senders = [];
  for (const sender of SENDER_ENVIRONMENT) {
    const configured = configuredSender(env, sender);
    if (configured !== null) senders.push(configured);
  }
  if (new Set(senders.map(({ id }) => id)).size !== senders.length) {
    throw new CakemailPreflightError("Cakemail sender IDs must be unique.");
  }
  return senders;
}

function configuredSender(env, sender) {
  const value = optionalValue(env, sender.name);
  if (value === null) {
    if (sender.required) {
      throw new CakemailPreflightError(`${sender.name} is invalid.`);
    }
    return null;
  }
  if (!PROVIDER_ID.test(value)) {
    throw new CakemailPreflightError(`${sender.name} is invalid.`);
  }
  return { address: sender.address, id: value };
}

function configuredWebhookSecrets(env) {
  let configured;
  try {
    configured = parseCakemailWebhookSecrets(
      requiredValue(env, "CAKEMAIL_WEBHOOK_SECRETS_JSON"),
    );
  } catch {
    throw new CakemailPreflightError(
      "CAKEMAIL_WEBHOOK_SECRETS_JSON is invalid.",
    );
  }
  if (
    [...WEBHOOK_SECRET_KEYS.values()].some(
      (event) => (configured[event]?.length ?? 0) === 0,
    )
  ) {
    throw new CakemailPreflightError(
      "CAKEMAIL_WEBHOOK_SECRETS_JSON is incomplete.",
    );
  }
  return configured;
}

function configuredRuntimePatPrefix(env) {
  const fullPat = optionalValue(env, "CAKEMAIL_PAT");
  const explicitPrefix = optionalValue(env, "CAKEMAIL_RUNTIME_PAT_PREFIX");
  assertOptionalPattern(fullPat, PAT, "CAKEMAIL_PAT is invalid.");
  assertOptionalPattern(
    explicitPrefix,
    PAT_PREFIX,
    "CAKEMAIL_RUNTIME_PAT_PREFIX is invalid.",
  );
  const derivedPrefix = fullPat === null ? null : fullPat.slice(0, 12);
  if (!optionalValuesMatch(derivedPrefix, explicitPrefix)) {
    throw new CakemailPreflightError(
      "CAKEMAIL runtime PAT prefixes do not match.",
    );
  }
  const prefix = firstPresent(explicitPrefix, derivedPrefix);
  if (prefix === null) {
    throw new CakemailPreflightError(
      "CAKEMAIL_RUNTIME_PAT_PREFIX or CAKEMAIL_PAT is required.",
    );
  }
  return prefix;
}

function assertOptionalPattern(value, pattern, message) {
  if (value === null || pattern.test(value)) return;
  throw new CakemailPreflightError(message);
}

function optionalValuesMatch(left, right) {
  if ([left, right].includes(null)) return true;
  return left === right;
}

function firstPresent(preferred, fallback) {
  return preferred === null ? fallback : preferred;
}

function brandedTrackingHostname(value) {
  const valid =
    typeof value === "string" &&
    checksPass([
      value === value.toLowerCase(),
      value.length <= 253,
      HOSTNAME.test(value),
      value.endsWith(`.${ACCOUNT_DOMAIN}`),
      !FORBIDDEN_TRACKING_HOSTNAMES.has(value),
    ]);
  if (!valid) {
    throw new CakemailPreflightError(
      "CAKEMAIL_TRACKING_HOSTNAME must be a new 27pm.org hostname.",
    );
  }
  return value;
}

function providerTrackingHostname(value) {
  if (value === null) return null;
  if (HOSTNAME.test(value)) return value;
  return providerHttpsTrackingHostname(value);
}

function providerHttpsTrackingHostname(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const valid = checksPass([
    url.protocol === "https:",
    url.username === "",
    url.password === "",
    url.port === "",
    ["/", ""].includes(url.pathname),
    url.search === "",
    url.hash === "",
    HOSTNAME.test(url.hostname),
  ]);
  if (!valid) return null;
  return url.hostname;
}

function webhookSummary(value) {
  const webhook = objectValue(value);
  return {
    id: safeProviderString(propertyValue(webhook, "id")),
    event: stringValue(propertyValue(webhook, "event")),
    status: stringValue(propertyValue(webhook, "status")),
    url: stringValue(propertyValue(webhook, "url")),
  };
}

function assertConfig(config) {
  const normalized = objectValue(config);
  if (normalized !== null && preflightConfigValid(normalized)) return;
  throw new CakemailPreflightError("Cakemail preflight config is invalid.");
}

function preflightConfigValid(config) {
  return checksPass([
    preflightPatConfigValid(config.preflightPat, config.preflightPatPrefix),
    runtimePatPrefixConfigValid(config.runtimePatPrefix),
    config.preflightPatPrefix !== config.runtimePatPrefix,
    positiveConfigInteger(config.accountId),
    positiveConfigInteger(config.listId),
    config.bounceHostname !== config.trackingHostname,
    senderConfigValid(config.senders),
    webhookSecretsConfigValid(config.webhookSecrets),
    trackingHostnamesConfigValid(
      config.bounceHostname,
      config.trackingHostname,
    ),
  ]);
}

function preflightPatConfigValid(preflightPat, preflightPatPrefix) {
  if (typeof preflightPat !== "string") return false;
  return checksPass([
    PAT.test(preflightPat),
    preflightPatPrefix === preflightPat.slice(0, 12),
  ]);
}

function runtimePatPrefixConfigValid(runtimePatPrefix) {
  return typeof runtimePatPrefix === "string" && PAT_PREFIX.test(runtimePatPrefix);
}

function positiveConfigInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function trackingHostnamesConfigValid(bounceHostname, trackingHostname) {
  try {
    return checksPass([
      brandedTrackingHostname(trackingHostname) === trackingHostname,
      brandedTrackingHostname(bounceHostname) === bounceHostname,
    ]);
  } catch {
    return false;
  }
}

function webhookSecretsConfigValid(webhookSecrets) {
  let parsedSecrets;
  try {
    parsedSecrets = parseCakemailWebhookSecrets(JSON.stringify(webhookSecrets));
  } catch {
    return false;
  }
  for (const event of WEBHOOK_SECRET_KEYS.values()) {
    if (arrayProperty(parsedSecrets, event).length === 0) return false;
  }
  return true;
}

function senderConfigValid(senders) {
  if (!Array.isArray(senders)) return false;
  const byAddress = new Map();
  for (const sender of senders) {
    if (!senderEntryValid(sender, byAddress)) return false;
    byAddress.set(sender.address, sender.id);
  }
  return checksPass([
    senderAddressesKnown(byAddress),
    requiredSenderAddressesPresent(byAddress),
    new Set(byAddress.values()).size === byAddress.size,
  ]);
}

function senderAddressesKnown(byAddress) {
  const knownAddresses = new Set(
    SENDER_ENVIRONMENT.map(({ address }) => address),
  );
  return [...byAddress.keys()].every((address) => knownAddresses.has(address));
}

function requiredSenderAddressesPresent(byAddress) {
  return SENDER_ENVIRONMENT.filter(({ required }) => required).every(
    ({ address }) => byAddress.has(address),
  );
}

function senderEntryValid(sender, byAddress) {
  const entry = objectValue(sender);
  if (entry === null) return false;
  return checksPass([
    typeof entry.address === "string",
    typeof entry.id === "string",
    PROVIDER_ID.test(entry.id),
    !byAddress.has(entry.address),
  ]);
}

function requiredValue(env, name) {
  const value = optionalValue(env, name);
  if (value === null) {
    throw new CakemailPreflightError(`${name} is required.`);
  }
  return value;
}

function optionalValue(env, name) {
  const value = env[name];
  if (value === undefined) return null;
  if (typeof value !== "string") {
    throw new CakemailPreflightError(`${name} is invalid.`);
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function positiveInteger(env, name) {
  const raw = requiredValue(env, name);
  if (!POSITIVE_INTEGER.test(raw)) {
    throw new CakemailPreflightError(`${name} must be a positive integer.`);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CakemailPreflightError(`${name} must be a positive integer.`);
  }
  return value;
}

function providerPositiveInteger(value) {
  if (positiveConfigInteger(value)) return value;
  const parsed = positiveIntegerStringValue(value);
  if (Number.isSafeInteger(parsed)) return parsed;
  return null;
}

function positiveIntegerStringValue(value) {
  if (typeof value !== "string") return null;
  if (!POSITIVE_INTEGER.test(value)) return null;
  return Number(value);
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function nullableNonnegativeInteger(value) {
  return value === null || value === undefined ? null : nonnegativeInteger(value);
}

function safeProviderString(value) {
  return typeof value === "string" && PROVIDER_ID.test(value) ? value : null;
}

function stringValue(value) {
  return typeof value === "string" ? value : null;
}

function safeSecret(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 1_024 ? trimmed : null;
}

function secretEqual(left, right) {
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return (
    leftBytes.byteLength === rightBytes.byteLength &&
    timingSafeEqual(leftBytes, rightBytes)
  );
}

function uniqueSecrets(values) {
  for (let index = 0; index < values.length; index += 1) {
    for (let candidate = index + 1; candidate < values.length; candidate += 1) {
      if (secretEqual(values[index], values[candidate])) return false;
    }
  }
  return true;
}

function checksPass(checks) {
  return checks.every((check) => check === true);
}

function gateStatus(checks) {
  return checksPass(checks) ? "pass" : "fail";
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

function nullableString(value) {
  return value === null ? "" : value;
}

function propertyValue(value, property) {
  const object = objectValue(value);
  return object === null ? undefined : object[property];
}

function objectProperty(value, property) {
  return objectValue(propertyValue(value, property));
}

function arrayProperty(value, property) {
  return arrayValue(propertyValue(value, property));
}

function dataObject(value) {
  return objectProperty(value, "data");
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value
    : null;
}

function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const result = await runPreflight();
    if (result.status !== "pass") process.exitCode = 2;
  } catch {
    process.stdout.write(
      `${JSON.stringify({
        status: "error",
        gates: [{ name: "preflight_execution", status: "error" }],
      })}\n`,
    );
    process.exitCode = 1;
  }
}
