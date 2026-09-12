#!/usr/bin/env node

import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

export const MAILGUN_AUDIT_DOMAIN = "27pm.org";
export const MAILGUN_AUDIT_MAX_RESPONSE_BYTES = 8 * 1_024 * 1_024;

const ALLOWED_API_ORIGINS = new Set([
  "https://api.mailgun.net",
  "https://api.eu.mailgun.net",
]);
const DEFAULT_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_WINDOW_MS = 31 * 24 * 60 * 60 * 1_000;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1_000;
const DEFAULT_PAGE_SIZE = 300;
const DEFAULT_PAGE_CAP = 20;
const MAX_PAGE_CAP = 100;
const MAX_DIMENSION_VALUES = 500;
const MAX_TAGS_PER_EVENT = 100;
const INVALID_API_BASE_MESSAGE =
  "MAILGUN_API_BASE must be an HTTPS API origin.";

const EVENT_NAMES = new Set([
  "accepted",
  "clicked",
  "complained",
  "delivered",
  "failed",
  "opened",
  "rejected",
  "stored",
  "unsubscribed",
]);
const SEVERITIES = new Set(["permanent", "temporary"]);
const REASONS = new Set([
  "bounce",
  "espblock",
  "generic",
  "old",
  "spam",
  "suppress-bounce",
  "suppress-complaint",
  "suppress-unsubscribe",
  "virus",
]);
const SUPPRESSION_ENDPOINTS = ["bounces", "complaints", "unsubscribes"];
const HELP_ARGUMENTS = new Set(["--help", "-h"]);
const MAILBOX_PROVIDERS = new Map([
  ["aol.com", "yahoo"],
  ["gmail.com", "google"],
  ["googlemail.com", "google"],
  ["hotmail.com", "microsoft"],
  ["icloud.com", "apple"],
  ["live.com", "microsoft"],
  ["mac.com", "apple"],
  ["me.com", "apple"],
  ["msn.com", "microsoft"],
  ["outlook.com", "microsoft"],
  ["proton.me", "proton"],
  ["protonmail.com", "proton"],
  ["rocketmail.com", "yahoo"],
  ["unknown", "unknown"],
  ["ymail.com", "yahoo"],
  ["yahoo.com", "yahoo"],
]);

const ARGUMENT_SETTERS = new Map([
  [
    "--begin",
    (state, value) => {
      state.beginRaw = singleArgumentValue(state.beginRaw, value, "--begin");
    },
  ],
  [
    "--end",
    (state, value) => {
      state.endRaw = singleArgumentValue(state.endRaw, value, "--end");
    },
  ],
  [
    "--limit",
    (state, value) => {
      state.pageSize = boundedInteger(value, "--limit", 1, 300);
    },
  ],
  [
    "--max-pages",
    (state, value) => {
      state.pageCap = boundedInteger(value, "--max-pages", 1, MAX_PAGE_CAP);
    },
  ],
]);

export class MailgunAuditError extends Error {
  constructor(message) {
    super(message);
    this.name = "MailgunAuditError";
  }
}

export function configFromEnvironment(env = process.env) {
  if (env.MAILGUN_DOMAIN !== MAILGUN_AUDIT_DOMAIN) {
    throw new MailgunAuditError(
      `MAILGUN_DOMAIN must be configured exactly as ${MAILGUN_AUDIT_DOMAIN}.`,
    );
  }

  const apiKey = requiredEnvironmentValue(env, "MAILGUN_API_KEY");
  const apiBase = parseApiBase(configuredApiBase(env.MAILGUN_API_BASE));
  return { apiBase, apiKey, domain: MAILGUN_AUDIT_DOMAIN };
}

function configuredApiBase(value) {
  if (value === undefined) return "https://api.mailgun.net";
  if (typeof value !== "string") {
    throw new MailgunAuditError(INVALID_API_BASE_MESSAGE);
  }
  const trimmed = value.trim();
  return trimmed === "" ? "https://api.mailgun.net" : trimmed;
}

export function parseArguments(args, nowMs = Date.now()) {
  assertAuditClock(nowMs);
  const state = {
    beginRaw: undefined,
    endRaw: undefined,
    help: false,
    pageCap: DEFAULT_PAGE_CAP,
    pageSize: DEFAULT_PAGE_SIZE,
  };
  for (const argument of args) applyArgument(state, argument);

  const { beginMs, endMs } = parsedAuditWindow(state, nowMs);
  assertAuditWindow(beginMs, endMs, nowMs);

  return {
    begin: new Date(beginMs).toISOString(),
    beginMs,
    end: new Date(endMs).toISOString(),
    endMs,
    help: state.help,
    pageCap: state.pageCap,
    pageSize: state.pageSize,
  };
}

function assertAuditClock(nowMs) {
  if (!Number.isFinite(nowMs)) {
    throw new MailgunAuditError("The audit clock is invalid.");
  }
}

function applyArgument(state, argument) {
  if (HELP_ARGUMENTS.has(argument)) {
    state.help = true;
    return;
  }

  const separator = argument.indexOf("=");
  if (separator < 0) throw unknownArgumentError();
  const setter = ARGUMENT_SETTERS.get(argument.slice(0, separator));
  if (!setter) throw unknownArgumentError();
  setter(state, argument.slice(separator + 1));
}

function unknownArgumentError() {
  return new MailgunAuditError(
    "Unknown argument. Use --help to see the accepted flags.",
  );
}

function parsedAuditWindow(state, nowMs) {
  const endMs =
    state.endRaw === undefined ? nowMs : parseDate(state.endRaw, "--end");
  const beginMs =
    state.beginRaw === undefined
      ? endMs - DEFAULT_WINDOW_MS
      : parseDate(state.beginRaw, "--begin");
  return { beginMs, endMs };
}

function assertAuditWindow(beginMs, endMs, nowMs) {
  if (beginMs >= endMs) {
    throw new MailgunAuditError("--begin must be earlier than --end.");
  }
  if (endMs - beginMs > MAX_WINDOW_MS) {
    throw new MailgunAuditError("The audit window cannot exceed 31 days.");
  }
  if (endMs > nowMs + FUTURE_TOLERANCE_MS) {
    throw new MailgunAuditError(
      "--end cannot be more than five minutes in the future.",
    );
  }
}

export function usage() {
  return [
    "Usage: node scripts/audit-mailgun-deliverability.mjs [options]",
    "",
    "Read-only options:",
    "  --begin=<ISO timestamp>  Start of the Events window (default: seven days ago)",
    "  --end=<ISO timestamp>    End of the Events window (default: now)",
    "  --limit=<1..300>         Maximum items requested per page (default: 300)",
    "  --max-pages=<1..100>     Safety cap for each endpoint (default: 20)",
    "  --help                   Show this help",
    "",
    `MAILGUN_DOMAIN must be exactly ${MAILGUN_AUDIT_DOMAIN}; MAILGUN_API_KEY is required.`,
  ].join("\n");
}

export async function auditMailgunDeliverability({
  config,
  options,
  fetchImpl = globalThis.fetch,
  generatedAt = new Date().toISOString(),
}) {
  if (typeof fetchImpl !== "function") {
    throw new MailgunAuditError(
      "A Fetch-compatible implementation is required.",
    );
  }
  assertAuditConfig(config);
  const normalizedGeneratedAt = normalizedDate(generatedAt, "generatedAt");
  assertAuditOptions(options, Date.parse(normalizedGeneratedAt));

  const aggregate = emptyEventAggregate();
  const eventPages = await collectEvents(
    fetchImpl,
    config,
    options,
    aggregate,
  );

  const suppressionResults = {};
  let totalSuppressions = 0;
  for (const endpoint of SUPPRESSION_ENDPOINTS) {
    const result = await countSuppressions(
      fetchImpl,
      config,
      options,
      endpoint,
    );
    suppressionResults[endpoint] = result;
    totalSuppressions += result.count;
  }

  return {
    generatedAt: normalizedGeneratedAt,
    window: { begin: options.begin, end: options.end },
    mailgun: {
      domain: config.domain,
      region: config.apiBase === "https://api.eu.mailgun.net" ? "eu" : "us",
    },
    events: {
      total: aggregate.total,
      pages: eventPages,
      byEvent: sortedCounts(aggregate.byEvent),
      bySeverity: sortedCounts(aggregate.bySeverity),
      byReason: sortedCounts(aggregate.byReason),
      byProvider: sortedCounts(aggregate.byProvider),
      byIp: sortedCounts(aggregate.byIp),
      byDomain: sortedCounts(aggregate.byDomain),
      byTag: sortedCounts(aggregate.byTag),
    },
    suppressions: {
      ...suppressionResults,
      total: totalSuppressions,
    },
  };
}

export async function runAudit({
  args = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
  log = console.log,
} = {}) {
  const options = parseArguments(args, nowMs);
  if (options.help) {
    log(usage());
    return { status: "help" };
  }

  const result = await auditMailgunDeliverability({
    config: configFromEnvironment(env),
    options,
    fetchImpl,
    generatedAt: new Date(nowMs).toISOString(),
  });
  log(JSON.stringify(result, null, 2));
  return result;
}

async function collectEvents(fetchImpl, config, options, aggregate) {
  const path = `/v3/${encodeURIComponent(config.domain)}/events`;
  const beginSeconds = String(Math.floor(options.beginMs / 1_000));
  const endSeconds = String(Math.floor(options.endMs / 1_000));
  let nextUrl = endpointUrl(config, path, {
    ascending: "yes",
    begin: beginSeconds,
    end: endSeconds,
    limit: String(options.pageSize),
  });
  const seen = new Set();

  for (let page = 1; page <= options.pageCap; page += 1) {
    rememberPage(seen, nextUrl, "Mailgun Events");

    const payload = await mailgunGetJson(fetchImpl, config, nextUrl, path);
    const items = pageItems(payload, "Mailgun Events", options.pageSize);
    for (const item of items) aggregateEvent(item, aggregate);

    const following = pagingNext(payload, nextUrl, config, path, {
      begin: beginSeconds,
      end: endSeconds,
      limit: options.pageSize,
    });
    if (paginationFinished(items, following)) return page;
    assertWithinPageCap(page, options.pageCap, "Mailgun Events");
    nextUrl = following;
  }

  throw pageCapError("Mailgun Events");
}

async function countSuppressions(
  fetchImpl,
  config,
  options,
  endpoint,
) {
  const path = `/v3/${encodeURIComponent(config.domain)}/${endpoint}`;
  let nextUrl = endpointUrl(config, path, {
    limit: String(options.pageSize),
  });
  const seen = new Set();
  let count = 0;
  const label = `Mailgun ${endpoint}`;

  for (let page = 1; page <= options.pageCap; page += 1) {
    rememberPage(seen, nextUrl, label);

    const payload = await mailgunGetJson(fetchImpl, config, nextUrl, path);
    const items = pageItems(payload, label, options.pageSize);
    assertSuppressionItems(items, label);
    count += items.length;

    const following = pagingNext(payload, nextUrl, config, path, {
      limit: options.pageSize,
    });
    if (paginationFinished(items, following)) return { count, pages: page };
    assertWithinPageCap(page, options.pageCap, label);
    nextUrl = following;
  }

  throw pageCapError(label);
}

function rememberPage(seen, url, label) {
  if (seen.has(url.href)) {
    throw new MailgunAuditError(`${label} pagination repeated a page.`);
  }
  seen.add(url.href);
}

function assertSuppressionItems(items, label) {
  for (const item of items) {
    if (!isRecord(item)) {
      throw new MailgunAuditError(
        `${label} returned an invalid suppression item.`,
      );
    }
  }
}

function paginationFinished(items, following) {
  return items.length === 0 || following === null;
}

function assertWithinPageCap(page, pageCap, label) {
  if (page === pageCap) throw pageCapError(label);
}

function pageCapError(label) {
  return new MailgunAuditError(
    `${label} pagination exceeded the configured page cap.`,
  );
}

async function mailgunGetJson(fetchImpl, config, url, expectedPath) {
  validatePageUrl(url, config, expectedPath);
  const response = await fetchMailgunResponse(
    fetchImpl,
    url,
    expectedPath,
    config.apiKey,
  );
  assertSuccessfulResponse(response, expectedPath);
  const responseText = await boundedResponseText(response, expectedPath);
  return parsedResponseObject(responseText, expectedPath);
}

async function fetchMailgunResponse(fetchImpl, url, expectedPath, apiKey) {
  try {
    return await fetchImpl(url, mailgunRequestInit(apiKey));
  } catch {
    throw new MailgunAuditError(
      `Mailgun GET ${expectedPath} failed before a response was received.`,
    );
  }
}

function mailgunRequestInit(apiKey) {
  const headers = new Headers();
  headers.set("Accept", "application/json");
  headers.set("Authorization", basicAuthorization(apiKey));
  return {
    method: "GET",
    headers,
    cache: "no-store",
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  };
}

function assertSuccessfulResponse(response, expectedPath) {
  if (successfulResponse(response)) return;
  throw new MailgunAuditError(
    `Mailgun GET ${expectedPath} failed.${responseStatusSuffix(response)}`,
  );
}

function successfulResponse(response) {
  return Boolean(response) && response.ok === true;
}

function responseStatusSuffix(response) {
  if (!response) return "";
  if (!Number.isInteger(response.status)) return "";
  return ` HTTP ${response.status}`;
}

async function boundedResponseText(response, expectedPath) {
  assertAdvertisedResponseSize(response, expectedPath);
  if (!hasReadableBody(response)) throw invalidJsonError(expectedPath);

  try {
    const bytes = await boundedResponseBytes(response.body, expectedPath);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    rethrowResponseReadError(error, expectedPath);
  }
}

function hasReadableBody(response) {
  return Boolean(response.body) && typeof response.body.getReader === "function";
}

function rethrowResponseReadError(error, expectedPath) {
  if (error instanceof MailgunAuditError) throw error;
  throw invalidJsonError(expectedPath);
}

function assertAdvertisedResponseSize(response, expectedPath) {
  const rawLength = responseHeader(response, "content-length");
  if (missingOptionalValue(rawLength)) return;
  if (!/^\d+$/u.test(rawLength)) {
    throw new MailgunAuditError(
      `Mailgun GET ${expectedPath} returned an invalid Content-Length.`,
    );
  }
  if (Number(rawLength) > MAILGUN_AUDIT_MAX_RESPONSE_BYTES) {
    throw responseSizeError(expectedPath);
  }
}

function responseHeader(response, name) {
  const getter = response?.headers?.get;
  return typeof getter === "function"
    ? getter.call(response.headers, name)
    : null;
}

async function boundedResponseBytes(body, expectedPath) {
  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return joinedBytes(chunks, totalBytes);
      assertByteChunk(value, expectedPath);
      totalBytes += value.byteLength;
      if (totalBytes > MAILGUN_AUDIT_MAX_RESPONSE_BYTES) {
        await cancelReader(reader);
        throw responseSizeError(expectedPath);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function assertByteChunk(value, expectedPath) {
  if (!(value instanceof Uint8Array)) throw invalidJsonError(expectedPath);
}

async function cancelReader(reader) {
  try {
    await reader.cancel();
  } catch {
    // Preserve the bounded-response error even if cancellation also fails.
  }
}

function joinedBytes(chunks, totalBytes) {
  const joined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parsedResponseObject(responseText, expectedPath) {
  let payload;
  try {
    payload = JSON.parse(responseText);
  } catch {
    throw invalidJsonError(expectedPath);
  }
  if (!isRecord(payload)) {
    throw new MailgunAuditError(
      `Mailgun GET ${expectedPath} returned an invalid object schema.`,
    );
  }
  return payload;
}

function invalidJsonError(expectedPath) {
  return new MailgunAuditError(
    `Mailgun GET ${expectedPath} returned invalid JSON.`,
  );
}

function responseSizeError(expectedPath) {
  return new MailgunAuditError(
    `Mailgun GET ${expectedPath} exceeded the response size limit.`,
  );
}

function pageItems(payload, label, pageSize) {
  if (!Array.isArray(payload.items)) {
    throw new MailgunAuditError(`${label} returned an invalid items schema.`);
  }
  if (payload.items.length > pageSize) {
    throw new MailgunAuditError(
      `${label} returned more items than the requested page limit.`,
    );
  }
  return payload.items;
}

function pagingNext(payload, currentUrl, config, expectedPath, constraints) {
  const rawNext = pagingNextValue(payload, expectedPath);
  if (rawNext === null) return null;
  const nextUrl = parsedPagingUrl(rawNext, currentUrl, expectedPath);
  validatePageUrl(nextUrl, config, expectedPath);
  applyPagingConstraints(nextUrl, constraints, expectedPath);
  return nextUrl;
}

function pagingNextValue(payload, expectedPath) {
  if (!isRecord(payload.paging)) {
    throw new MailgunAuditError(
      `Mailgun GET ${expectedPath} returned an invalid paging schema.`,
    );
  }
  return validatedPagingNext(payload.paging.next, expectedPath);
}

function validatedPagingNext(rawNext, expectedPath) {
  if (missingOptionalValue(rawNext)) return null;
  if (typeof rawNext !== "string") throw invalidPagingUrlError(expectedPath);
  if (rawNext.length > 4_096) throw invalidPagingUrlError(expectedPath);
  return rawNext;
}

function parsedPagingUrl(rawNext, currentUrl, expectedPath) {
  try {
    return new URL(rawNext, currentUrl);
  } catch {
    throw invalidPagingUrlError(expectedPath);
  }
}

function applyPagingConstraints(nextUrl, constraints, expectedPath) {
  for (const [name, expectedValue] of Object.entries(constraints)) {
    const currentValue = nextUrl.searchParams.get(name);
    const normalizedExpected = String(expectedValue);
    if (currentValue !== null && currentValue !== normalizedExpected) {
      throw new MailgunAuditError(
        `Mailgun GET ${expectedPath} changed the bounded ${name} parameter.`,
      );
    }
    nextUrl.searchParams.set(name, normalizedExpected);
  }
}

function invalidPagingUrlError(expectedPath) {
  return new MailgunAuditError(
    `Mailgun GET ${expectedPath} returned an invalid paging next URL.`,
  );
}

function aggregateEvent(value, aggregate) {
  assertEventRecord(value);

  const event = categoricalValue(value.event, EVENT_NAMES, "event");
  const severity = optionalCategoricalValue(
    value.severity,
    SEVERITIES,
    "severity",
  );
  const reason = optionalCategoricalValue(value.reason, REASONS, "reason");
  const domain = recipientDomain(value.recipient);
  const provider = mailboxProvider(domain);
  const envelope = optionalRecord(value.envelope, "envelope");
  const ip = normalizedIp(eventSendingIp(value, envelope));
  const tags = normalizedTags(value.tags);

  aggregate.total += 1;
  increment(aggregate.byEvent, event);
  increment(aggregate.bySeverity, severity);
  increment(aggregate.byReason, reason);
  increment(aggregate.byProvider, provider);
  incrementBounded(aggregate.byIp, ip);
  incrementBounded(aggregate.byDomain, domain);
  aggregateTags(aggregate.byTag, tags);
}

function assertEventRecord(value) {
  if (!isRecord(value)) {
    throw new MailgunAuditError("Mailgun Events returned an invalid event item.");
  }
}

function eventSendingIp(value, envelope) {
  if (value.ip !== undefined && value.ip !== null) return value.ip;
  return envelope?.["sending-ip"];
}

function aggregateTags(counts, tags) {
  if (tags.length === 0) {
    increment(counts, "untagged");
    return;
  }
  for (const tag of new Set(tags)) incrementBounded(counts, tag);
}

function emptyEventAggregate() {
  return {
    total: 0,
    byEvent: new Map(),
    bySeverity: new Map(),
    byReason: new Map(),
    byProvider: new Map(),
    byIp: new Map(),
    byDomain: new Map(),
    byTag: new Map(),
  };
}

function categoricalValue(value, allowlist, field) {
  assertCategoricalValue(value, field);
  const normalized = normalizeToken(value);
  return allowlist.has(normalized) ? normalized : "other";
}

function assertCategoricalValue(value, field) {
  if (typeof value !== "string") throw invalidCategoricalValueError(field);
  if (value.length === 0) throw invalidCategoricalValueError(field);
  if (value.length > 80) throw invalidCategoricalValueError(field);
}

function invalidCategoricalValueError(field) {
  return new MailgunAuditError(
    `Mailgun Events returned an invalid ${field} field.`,
  );
}

function optionalCategoricalValue(value, allowlist, field) {
  if (value === undefined || value === null || value === "") return "none";
  return categoricalValue(value, allowlist, field);
}

function recipientDomain(value) {
  if (missingOptionalValue(value)) return "unknown";
  assertRecipientValue(value);
  return parsedRecipientDomain(value);
}

function parsedRecipientDomain(value) {
  const separator = value.lastIndexOf("@");
  if (separator <= 0) return "unknown";
  if (separator === value.length - 1) return "unknown";
  const domain = value.slice(separator + 1).trim().toLowerCase();
  return validDomain(domain) ? domain : "unknown";
}

function missingOptionalValue(value) {
  return value === undefined || value === null || value === "";
}

function assertRecipientValue(value) {
  if (typeof value !== "string") throw invalidRecipientError();
  if (value.length > 320) throw invalidRecipientError();
}

function invalidRecipientError() {
  return new MailgunAuditError(
    "Mailgun Events returned an invalid recipient field.",
  );
}

function mailboxProvider(domain) {
  const exactProvider = MAILBOX_PROVIDERS.get(domain);
  if (exactProvider) return exactProvider;
  return domain.endsWith(".yahoo.com") ? "yahoo" : "other";
}

function normalizedIp(value) {
  if (missingOptionalValue(value)) return "unknown";
  assertIpValue(value);
  const normalized = value.trim().toLowerCase();
  return isIP(normalized) ? normalized : "unknown";
}

function assertIpValue(value) {
  if (typeof value !== "string") throw invalidIpError();
  if (value.length > 64) throw invalidIpError();
}

function invalidIpError() {
  return new MailgunAuditError(
    "Mailgun Events returned an invalid IP field.",
  );
}

function normalizedTags(value) {
  if (nullishValue(value)) return [];
  assertTagList(value);
  return value.map(normalizedTag);
}

function nullishValue(value) {
  return value === undefined || value === null;
}

function assertTagList(value) {
  if (!Array.isArray(value)) throw invalidTagsError();
  if (value.length > MAX_TAGS_PER_EVENT) throw invalidTagsError();
}

function normalizedTag(tag) {
  assertTagValue(tag);
  const normalized = normalizeToken(tag);
  return safeTag(normalized) ? normalized : "redacted";
}

function assertTagValue(tag) {
  if (typeof tag !== "string") throw invalidTagError();
  if (tag.length === 0) throw invalidTagError();
  if (tag.length > 256) throw invalidTagError();
}

function safeTag(value) {
  return /^(?:campaign|crm|flow|mailbox|traffic|type)[-:][a-z0-9._:-]{1,63}$/u.test(
    value,
  );
}

function invalidTagsError() {
  return new MailgunAuditError(
    "Mailgun Events returned an invalid tags field.",
  );
}

function invalidTagError() {
  return new MailgunAuditError(
    "Mailgun Events returned an invalid tag value.",
  );
}

function optionalRecord(value, field) {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new MailgunAuditError(
      `Mailgun Events returned an invalid ${field} field.`,
    );
  }
  return value;
}

function endpointUrl(config, path, parameters) {
  const url = new URL(path, `${config.apiBase}/`);
  for (const [name, value] of Object.entries(parameters)) {
    url.searchParams.set(name, value);
  }
  validatePageUrl(url, config, path);
  return url;
}

function validatePageUrl(url, config, expectedPath) {
  assertExpectedAuditEndpoint(url instanceof URL);
  assertExpectedAuditEndpoint(url.protocol === "https:");
  assertExpectedAuditEndpoint(url.username === "");
  assertExpectedAuditEndpoint(url.password === "");
  assertExpectedAuditEndpoint(url.hash === "");
  assertExpectedAuditEndpoint(url.origin === config.apiBase);
  assertExpectedAuditEndpoint(ALLOWED_API_ORIGINS.has(url.origin));
  assertExpectedAuditEndpoint(isAllowedPagePath(url.pathname, expectedPath));
}

function assertExpectedAuditEndpoint(condition) {
  if (!condition) {
    throw new MailgunAuditError(
      "Refusing an unexpected Mailgun audit endpoint.",
    );
  }
}

function isAllowedPagePath(pathname, expectedPath) {
  if (pathname === expectedPath) return true;
  if (!expectedPath.endsWith("/events")) return false;

  const prefix = `${expectedPath}/`;
  if (!pathname.startsWith(prefix)) return false;
  return validEventCursor(pathname.slice(prefix.length));
}

function validEventCursor(cursor) {
  return (
    cursor.length >= 1 &&
    cursor.length <= 4_096 &&
    /^(?:[a-zA-Z0-9._~+=-]|%[a-fA-F0-9]{2})+$/u.test(cursor)
  );
}

function assertAuditConfig(config) {
  assertValidAuditConfig(isRecord(config));
  assertValidAuditConfig(config.domain === MAILGUN_AUDIT_DOMAIN);
  assertValidAuditConfig(typeof config.apiKey === "string");
  assertValidAuditConfig(config.apiKey.trim() !== "");
  assertValidAuditConfig(typeof config.apiBase === "string");
  assertValidAuditConfig(parseApiBase(config.apiBase) === config.apiBase);
}

function assertValidAuditConfig(condition) {
  if (!condition) {
    throw new MailgunAuditError("The Mailgun audit configuration is invalid.");
  }
}

function assertAuditOptions(options, generatedAtMs) {
  assertValidAuditOption(isRecord(options));
  assertValidAuditOption(typeof options.begin === "string");
  assertValidAuditOption(typeof options.end === "string");
  assertValidAuditOption(Number.isFinite(options.beginMs));
  assertValidAuditOption(Number.isFinite(options.endMs));
  assertValidAuditOption(options.beginMs < options.endMs);
  assertValidAuditOption(options.endMs - options.beginMs <= MAX_WINDOW_MS);
  assertIntegerOption(options.pageSize, 300);
  assertIntegerOption(options.pageCap, MAX_PAGE_CAP);
  assertValidAuditOption(
    options.endMs <= generatedAtMs + FUTURE_TOLERANCE_MS,
  );

  const expectedBegin = canonicalOptionDate(options.beginMs);
  const expectedEnd = canonicalOptionDate(options.endMs);
  if (options.begin !== expectedBegin || options.end !== expectedEnd) {
    throw new MailgunAuditError("The Mailgun audit options are inconsistent.");
  }
}

function assertValidAuditOption(condition) {
  if (!condition) {
    throw new MailgunAuditError("The Mailgun audit options are invalid.");
  }
}

function assertIntegerOption(value, maximum) {
  assertValidAuditOption(Number.isSafeInteger(value));
  assertValidAuditOption(value >= 1);
  assertValidAuditOption(value <= maximum);
}

function canonicalOptionDate(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    throw new MailgunAuditError("The Mailgun audit options are invalid.");
  }
}

function parseApiBase(rawValue) {
  if (typeof rawValue !== "string") {
    throw new MailgunAuditError(INVALID_API_BASE_MESSAGE);
  }
  const url = parsedApiBaseUrl(rawValue);
  assertOfficialApiBase(url);
  return url.origin;
}

function parsedApiBaseUrl(rawValue) {
  try {
    return new URL(rawValue);
  } catch {
    throw new MailgunAuditError(INVALID_API_BASE_MESSAGE);
  }
}

function assertOfficialApiBase(url) {
  assertOfficialApiBasePart(url.protocol === "https:");
  assertOfficialApiBasePart(url.username === "");
  assertOfficialApiBasePart(url.password === "");
  assertOfficialApiBasePart(url.port === "");
  assertOfficialApiBasePart(url.pathname === "/");
  assertOfficialApiBasePart(url.search === "");
  assertOfficialApiBasePart(url.hash === "");
  assertOfficialApiBasePart(ALLOWED_API_ORIGINS.has(url.origin));
}

function assertOfficialApiBasePart(condition) {
  if (!condition) {
    throw new MailgunAuditError(
      "MAILGUN_API_BASE must be the official US or EU Mailgun HTTPS API origin.",
    );
  }
}

function requiredEnvironmentValue(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim() === "") {
    throw new MailgunAuditError(`${name} is required in the environment.`);
  }
  return value.trim();
}

function singleArgumentValue(previous, value, name) {
  if (previous !== undefined || value === "") {
    throw new MailgunAuditError(`${name} must be supplied exactly once.`);
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^\d+$/u.test(value)) {
    throw new MailgunAuditError(`${name} must be an integer.`);
  }
  const number = Number(value);
  assertBoundedInteger(number, name, minimum, maximum);
  return number;
}

function assertBoundedInteger(value, name, minimum, maximum) {
  if (!Number.isSafeInteger(value)) throw boundedIntegerError(name, minimum, maximum);
  if (value < minimum) throw boundedIntegerError(name, minimum, maximum);
  if (value > maximum) throw boundedIntegerError(name, minimum, maximum);
}

function boundedIntegerError(name, minimum, maximum) {
  return new MailgunAuditError(
    `${name} must be between ${minimum} and ${maximum}.`,
  );
}

function parseDate(value, name) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  ) {
    throw new MailgunAuditError(`${name} must be an ISO timestamp with a zone.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new MailgunAuditError(`${name} must be a valid timestamp.`);
  }
  return timestamp;
}

function normalizedDate(value, field) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new MailgunAuditError(`${field} must be a valid timestamp.`);
  }
  return new Date(timestamp).toISOString();
}

function basicAuthorization(apiKey) {
  return `Basic ${Buffer.from(`api:${apiKey}`, "utf8").toString("base64")}`;
}

function increment(counts, key) {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function incrementBounded(counts, key) {
  if (counts.has(key) || counts.size < MAX_DIMENSION_VALUES) {
    increment(counts, key);
  } else {
    increment(counts, "other");
  }
}

function sortedCounts(counts) {
  return Object.fromEntries(
    [...counts.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

function normalizeToken(value) {
  return value.trim().toLowerCase().replace(/[_\s]+/gu, "-");
}

function validDomain(value) {
  return (
    value.length <= 253 &&
    value.includes(".") &&
    value
      .split(".")
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
      )
  );
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function publicErrorMessage(error) {
  return error instanceof MailgunAuditError
    ? error.message
    : "Unexpected Mailgun audit failure.";
}

const entryPoint = process.argv[1]
  ? pathToFileURL(process.argv[1]).href
  : undefined;

if (entryPoint === import.meta.url) {
  runAudit({ args: process.argv.slice(2) }).catch((error) => {
    console.error(publicErrorMessage(error));
    process.exitCode = 1;
  });
}
