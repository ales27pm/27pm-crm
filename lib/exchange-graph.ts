/** Server-only Graph boundary. No retries, mail-provider fallback, logging or token persistence. */
export type ExchangeGraphAccess = {
  accessToken: string;
  mailboxId: string;
  assertCurrent: () => Promise<void>;
  fetcher?: typeof fetch;
};
export type ExchangeGraphFolder = "inbox" | "junkemail" | "sentitems";
export type ExchangeGraphRecipient = { address: string; name?: string };
export type ExchangeGraphMessage = {
  id: string;
  parentFolderId?: string;
  changeKey?: string;
  internetMessageId?: string;
  conversationId?: string;
  subject?: string;
  text?: string;
  from?: ExchangeGraphRecipient;
  sender?: ExchangeGraphRecipient;
  toRecipients?: ExchangeGraphRecipient[];
  ccRecipients?: ExchangeGraphRecipient[];
  replyTo?: ExchangeGraphRecipient[];
  receivedDateTime?: string;
  sentDateTime?: string;
  lastModifiedDateTime?: string;
  isDraft?: boolean;
  isRead?: boolean;
  hasAttachments?: boolean;
  inferenceClassification?: "focused" | "other";
  headers?: { name: string; value: string }[];
  commandId?: string;
};
export type ExchangeGraphDeltaPage = {
  messages: ExchangeGraphMessage[];
  removedIds: string[];
  nextLink: string | null;
  deltaLink: string | null;
};
export type ExchangeGraphCommandMatches = { messages: ExchangeGraphMessage[]; complete: boolean };
export type ExchangeGraphDraftMatches = ExchangeGraphCommandMatches;
export type ExchangeGraphDraftInput = {
  commandId: string;
  fromAddress: string;
  fromName: string;
  to: string[];
  subject: string;
  text: string;
  replyTo: string;
  inReplyTo?: string;
  references?: string | string[];
};
export type ExchangeGraphPhase = "read" | "draft_create" | "draft_submit";
export type ExchangeGraphErrorCode =
  | "exchange_graph_configuration_invalid" | "exchange_graph_request_invalid"
  | "exchange_graph_connection_changed" | "exchange_graph_response_invalid"
  | "exchange_graph_unavailable" | "exchange_graph_timeout"
  | "exchange_graph_reauthentication_required" | "exchange_graph_forbidden"
  | "exchange_graph_not_found" | "exchange_graph_delta_reset"
  | "exchange_graph_throttled" | "exchange_graph_request_rejected"
  | "exchange_graph_draft_outcome_unknown" | "exchange_graph_send_outcome_unknown";

/** Contains closed categories only: never include a provider body, URL, exception or access token. */
export class ExchangeGraphError extends Error {
  readonly name = "ExchangeGraphError";
  constructor(
    readonly code: ExchangeGraphErrorCode,
    readonly phase: ExchangeGraphPhase,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
    readonly outcomeUnknown = false,
  ) { super(code); }
}

// One fixed named property, not a new MAPI property name/namespace for every message.
export const EXCHANGE_GRAPH_COMMAND_PROPERTY = "String {b570e7d4-3b31-4bbc-999e-a13d8a1ca203} Name 27PMCommandId";
const ORIGIN = "https://graph.microsoft.com";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_TEXT_LENGTH = 256 * 1024;
const MAX_CURSOR_LENGTH = 16 * 1024;
// One sync request has a 55-second browser budget and a freshly-renewed
// 60-second connection lease. OAuth is bounded at 10 seconds; folder, delta
// and detail reads are each bounded at 8 seconds. Keeping a delta page to four
// messages means details fit in one parallel batch and the provider portion is
// bounded to 24 seconds rather than seven sequential detail batches.
const MAX_DELTA_PAGE = 4;
const MAX_RECIPIENTS = 25;
const TIMEOUT_MS = 8_000;
const FOLDERS = new Set<ExchangeGraphFolder>(["inbox", "junkemail", "sentitems"]);
const SAFE_HEADERS = new Set([
  "message-id", "in-reply-to", "references", "from", "sender", "to", "cc", "reply-to", "date",
  "authentication-results", "arc-authentication-results", "received-spf", "dkim-signature", "received",
  "return-path", "x-ms-exchange-organization-scl", "x-microsoft-antispam", "x-27pm-command-id",
]);
const SELECT = [
  "id", "parentFolderId", "changeKey", "internetMessageId", "conversationId", "subject", "body",
  "from", "sender", "toRecipients", "ccRecipients", "replyTo", "receivedDateTime", "sentDateTime",
  "lastModifiedDateTime", "isDraft", "isRead", "hasAttachments", "inferenceClassification", "internetMessageHeaders",
].join(",");

export async function getExchangeFolder(access: ExchangeGraphAccess, folder: ExchangeGraphFolder): Promise<{ id: string }> {
  const base = mailboxBase(access, "read");
  if (!FOLDERS.has(folder)) throw failure("exchange_graph_request_invalid", "read");
  const raw = await request(access, `${base}/mailFolders/${folder}?$select=id`, "read", 200);
  if (!record(raw) || !opaqueId(raw.id)) throw failure("exchange_graph_response_invalid", "read");
  return { id: raw.id };
}

export async function readExchangeDelta(access: ExchangeGraphAccess, folderId: string, cursor?: string): Promise<ExchangeGraphDeltaPage> {
  const base = mailboxBase(access, "read");
  if (!opaqueId(folderId)) throw failure("exchange_graph_request_invalid", "read");
  const path = `${base}/mailFolders/${encodeURIComponent(folderId)}/messages/delta`;
  const url = cursor === undefined ? `${path}?$select=${SELECT}` : validateCursor(cursor, access.mailboxId, folderId, "exchange_graph_request_invalid");
  const raw = await request(access, url, "read", 200, undefined, true);
  if (!record(raw) || !Array.isArray(raw.value) || raw.value.length > MAX_DELTA_PAGE) throw failure("exchange_graph_response_invalid", "read");
  const next = raw["@odata.nextLink"];
  const delta = raw["@odata.deltaLink"];
  if ((next !== undefined) === (delta !== undefined)) throw failure("exchange_graph_response_invalid", "read");
  const nextLink = next === undefined ? null : validateCursor(next, access.mailboxId, folderId, "exchange_graph_response_invalid");
  const deltaLink = delta === undefined ? null : validateCursor(delta, access.mailboxId, folderId, "exchange_graph_response_invalid");
  const messages: ExchangeGraphMessage[] = [];
  const removedIds: string[] = [];
  for (const entry of raw.value) {
    if (!record(entry) || !opaqueId(entry.id)) throw failure("exchange_graph_response_invalid", "read");
    if (Object.hasOwn(entry, "@removed")) {
      if (!record(entry["@removed"]) || typeof entry["@removed"].reason !== "string" || !["deleted", "changed"].includes(entry["@removed"].reason)) throw failure("exchange_graph_response_invalid", "read");
      removedIds.push(entry.id);
    } else messages.push(normalizeMessage(entry, "read"));
  }
  return { messages, removedIds, nextLink, deltaLink };
}

export async function getExchangeMessage(access: ExchangeGraphAccess, id: string): Promise<ExchangeGraphMessage> {
  const base = mailboxBase(access, "read");
  if (!opaqueId(id)) throw failure("exchange_graph_request_invalid", "read");
  const expand = encodeURIComponent(`singleValueExtendedProperties($filter=id eq '${EXCHANGE_GRAPH_COMMAND_PROPERTY}')`);
  const raw = await request(access, `${base}/messages/${encodeURIComponent(id)}?$select=${SELECT}&$expand=${expand}`, "read", 200);
  const result = normalizeMessage(raw, "read");
  if (result.id !== id) throw failure("exchange_graph_response_invalid", "read");
  return result;
}

/** A bounded reconciliation read. A partial page never proves a unique draft. */
export async function findExchangeDraftsByCommand(access: ExchangeGraphAccess, commandId: string): Promise<ExchangeGraphDraftMatches> {
  return findExchangeMessagesByCommand(access, "drafts", commandId, true);
}

/** A bounded, read-only Sent Items lookup used only to adjudicate an uncertain send. */
export async function findExchangeSentItemsByCommand(access: ExchangeGraphAccess, commandId: string): Promise<ExchangeGraphCommandMatches> {
  return findExchangeMessagesByCommand(access, "sentitems", commandId, false);
}

async function findExchangeMessagesByCommand(
  access: ExchangeGraphAccess,
  folder: "drafts" | "sentitems",
  commandId: string,
  expectedDraft: boolean,
): Promise<ExchangeGraphCommandMatches> {
  const base = mailboxBase(access, "read");
  if (typeof commandId !== "string" || !UUID.test(commandId)) throw failure("exchange_graph_request_invalid", "read");
  const url = new URL(`${base}/mailFolders/${folder}/messages`);
  url.searchParams.set("$select", "id,isDraft,parentFolderId,conversationId,sentDateTime");
  url.searchParams.set("$top", "2");
  url.searchParams.set("$filter", `singleValueExtendedProperties/Any(ep: ep/id eq '${EXCHANGE_GRAPH_COMMAND_PROPERTY}' and ep/value eq '${commandId}')`);
  url.searchParams.set("$expand", `singleValueExtendedProperties($filter=id eq '${EXCHANGE_GRAPH_COMMAND_PROPERTY}')`);
  const raw = await request(access, url.href, "read", 200);
  if (!record(raw) || !Array.isArray(raw.value) || raw.value.length > 2 || raw["@odata.deltaLink"] !== undefined) throw failure("exchange_graph_response_invalid", "read");
  if (raw["@odata.nextLink"] !== undefined) {
    // Do not follow this link: the bounded caller must treat incomplete results as ambiguous.
    const link = cursorUrl(raw["@odata.nextLink"], "exchange_graph_response_invalid");
    if (link.pathname !== url.pathname) throw failure("exchange_graph_response_invalid", "read");
  }
  const messages = raw.value.map(entry => normalizeMessage(entry, "read"));
  if (messages.some(entry => entry.isDraft !== expectedDraft || entry.commandId?.toLowerCase() !== commandId.toLowerCase()) ||
      new Set(messages.map(entry => entry.id)).size !== messages.length) throw failure("exchange_graph_response_invalid", "read");
  return { messages, complete: raw["@odata.nextLink"] === undefined };
}

/** Create only. The caller must durably store the immutable ID before authorizing submission. */
export async function createExchangeDraft(access: ExchangeGraphAccess, input: ExchangeGraphDraftInput): Promise<ExchangeGraphMessage> {
  const base = mailboxBase(access, "draft_create");
  if (!record(input) || typeof input.commandId !== "string" || !UUID.test(input.commandId) ||
      !email(input.fromAddress) || !email(input.replyTo) || !line(input.fromName, 200, true) ||
      !line(input.subject, 998, true) || typeof input.text !== "string" || input.text.length > MAX_TEXT_LENGTH || TEXT_CONTROL.test(input.text) ||
      !Array.isArray(input.to) || input.to.length < 1 || input.to.length > MAX_RECIPIENTS || !input.to.every(email)) {
    throw failure("exchange_graph_request_invalid", "draft_create");
  }
  const properties = [{ id: EXCHANGE_GRAPH_COMMAND_PROPERTY, value: input.commandId }];
  // Graph JSON custom Internet headers must start x-. Documented MAPI properties
  // preserve threading inputs without losing atomic command correlation in this POST.
  // Live recipient-side threading still requires a controlled integration test.
  if (input.inReplyTo !== undefined) {
    if (!messageId(input.inReplyTo)) throw failure("exchange_graph_request_invalid", "draft_create");
    properties.push({ id: "String 0x1042", value: input.inReplyTo });
  }
  if (input.references !== undefined) {
    const references = typeof input.references === "string" ? input.references.split(" ") : input.references;
    if (!Array.isArray(references) || !references.length || references.length > 50 ||
        !references.every(messageId) || references.join(" ").length > 8192) throw failure("exchange_graph_request_invalid", "draft_create");
    properties.push({ id: "String 0x1039", value: references.join(" ") });
  }
  const raw = await request(access, `${base}/messages`, "draft_create", 201, JSON.stringify({
    subject: input.subject, body: { contentType: "Text", content: input.text },
    from: { emailAddress: { address: input.fromAddress, name: input.fromName } },
    toRecipients: input.to.map(address => ({ emailAddress: { address } })),
    replyTo: [{ emailAddress: { address: input.replyTo } }],
    singleValueExtendedProperties: properties,
    internetMessageHeaders: [{ name: "x-27pm-command-id", value: input.commandId }],
  }));
  const result = normalizeMessage(raw, "draft_create");
  if (result.isDraft !== true || !result.conversationId ||
      (result.commandId !== undefined && result.commandId.toLowerCase() !== input.commandId.toLowerCase())) {
    throw uncertain("draft_create");
  }
  return result;
}

/** 202 is submission acceptance only, never delivery or Inbox placement. Never retry this POST. */
export async function submitExchangeDraft(access: ExchangeGraphAccess, id: string): Promise<void> {
  const base = mailboxBase(access, "draft_submit");
  if (!opaqueId(id)) throw failure("exchange_graph_request_invalid", "draft_submit");
  await request(access, `${base}/messages/${encodeURIComponent(id)}/send`, "draft_submit", 202);
}

async function request(
  access: ExchangeGraphAccess, url: string, phase: ExchangeGraphPhase, expectedStatus: number,
  body?: string, delta = false,
): Promise<unknown> {
  // Validate the generation/lease immediately before every provider request. The
  // service owns that check; a stale caller must never perform a Graph mutation.
  try { await access.assertCurrent(); } catch { throw failure("exchange_graph_connection_changed", phase); }
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  let response: Response;
  try {
    response = await (access.fetcher ?? fetch)(url, {
      method: phase === "read" ? "GET" : "POST", body,
      headers: {
        Authorization: `Bearer ${access.accessToken}`, Accept: "application/json",
        "Content-Type": "application/json",
        Prefer: `IdType="ImmutableId", outlook.body-content-type="text"${delta ? `, odata.maxpagesize=${MAX_DELTA_PAGE}` : ""}`,
      },
      redirect: "manual", cache: "no-store", referrerPolicy: "no-referrer", signal,
    });
  } catch (error) {
    if (phase !== "read") throw uncertain(phase);
    throw failure(error instanceof DOMException && ["TimeoutError", "AbortError"].includes(error.name) ? "exchange_graph_timeout" : "exchange_graph_unavailable", phase);
  }
  const status = Number.isInteger(response.status) && response.status >= 100 && response.status <= 599 ? response.status : undefined;
  if (response.redirected || status === undefined || (status >= 300 && status <= 399)) {
    if (phase !== "read") throw uncertain(phase, status);
    throw failure("exchange_graph_response_invalid", phase, status);
  }
  if (status !== expectedStatus) {
    if (phase !== "read" && (status >= 500 || status === 408 || status < 400)) throw uncertain(phase, status);
    let code: ExchangeGraphErrorCode;
    switch (status) {
      case 401: code = "exchange_graph_reauthentication_required"; break;
      case 403: code = "exchange_graph_forbidden"; break;
      case 404: code = "exchange_graph_not_found"; break;
      case 429: code = "exchange_graph_throttled"; break;
      case 410: code = delta ? "exchange_graph_delta_reset" : "exchange_graph_not_found"; break;
      default: code = status >= 500 ? "exchange_graph_unavailable" : "exchange_graph_request_rejected";
    }
    // Only this closed provider code affects behavior; never surface its body.
    if (delta && status === 400) {
      try {
        const detail = await boundedJson(response, signal);
        if (record(detail) && record(detail.error) && detail.error.code === "syncStateNotFound") code = "exchange_graph_delta_reset";
      } catch { /* Retain the fixed HTTP category. */ }
    }
    throw new ExchangeGraphError(code, phase, status, status === 429 ? retryAfter(response.headers.get("Retry-After")) : undefined);
  }
  if (expectedStatus === 202) return undefined;
  try { return await boundedJson(response, signal); } catch {
    if (phase !== "read") throw uncertain(phase, status);
    throw failure(signal.aborted ? "exchange_graph_timeout" : "exchange_graph_response_invalid", phase, status);
  }
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const length = response.headers.get("Content-Length");
  if (length !== null && /^\d+$/u.test(length) && Number(length) > MAX_RESPONSE_BYTES) throw new Error("bounded_response");
  if (!response.body) throw new Error("invalid_response");
  const reader = response.body.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("response_timeout"));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("bounded_response");
      chunks.push(value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    // Do not await untrusted stream cancellation after a deadline or size failure.
    void reader.cancel().catch(() => {});
  }
}

function normalizeMessage(raw: unknown, phase: ExchangeGraphPhase): ExchangeGraphMessage {
  const bad = (): never => { throw phase === "read" ? failure("exchange_graph_response_invalid", phase) : uncertain(phase); };
  if (!record(raw) || !opaqueId(raw.id)) return bad();
  const result: ExchangeGraphMessage = { id: raw.id };
  for (const key of ["parentFolderId", "changeKey", "conversationId"] as const) {
    if (raw[key] !== undefined && raw[key] !== null) { if (!opaqueId(raw[key])) return bad(); result[key] = raw[key]; }
  }
  for (const key of ["subject", "internetMessageId"] as const) {
    if (raw[key] !== undefined && raw[key] !== null) { if (!line(raw[key], key === "subject" ? 998 : 1024, true)) return bad(); result[key] = raw[key]; }
  }
  for (const key of ["isDraft", "isRead", "hasAttachments"] as const) {
    if (raw[key] !== undefined) { if (typeof raw[key] !== "boolean") return bad(); result[key] = raw[key]; }
  }
  for (const key of ["receivedDateTime", "sentDateTime", "lastModifiedDateTime"] as const) {
    if (raw[key] !== undefined && raw[key] !== null) {
      if (typeof raw[key] !== "string" || raw[key].length > 40 || !/^\d{4}-\d{2}-\d{2}T.+Z$/u.test(raw[key]) || !Number.isFinite(Date.parse(raw[key]))) return bad();
      result[key] = raw[key];
    }
  }
  for (const key of ["from", "sender"] as const) {
    if (raw[key] !== undefined && raw[key] !== null) { const value = recipient(raw[key]); if (!value) return bad(); result[key] = value; }
  }
  for (const key of ["toRecipients", "ccRecipients", "replyTo"] as const) {
    if (raw[key] !== undefined) {
      const list = raw[key];
      if (!Array.isArray(list) || list.length > 500) return bad();
      const parsed = list.map(recipient);
      if (parsed.some(value => value === null)) return bad();
      result[key] = parsed as ExchangeGraphRecipient[];
    }
  }
  if (raw.body !== undefined && raw.body !== null) {
    if (!record(raw.body) || typeof raw.body.contentType !== "string" || raw.body.contentType.toLowerCase() !== "text" ||
        typeof raw.body.content !== "string" || raw.body.content.length > MAX_TEXT_LENGTH || TEXT_CONTROL.test(raw.body.content)) return bad();
    result.text = raw.body.content;
  }
  if (raw.inferenceClassification !== undefined) {
    if (raw.inferenceClassification !== "focused" && raw.inferenceClassification !== "other") return bad();
    result.inferenceClassification = raw.inferenceClassification;
  }
  if (raw.internetMessageHeaders !== undefined) {
    if (!Array.isArray(raw.internetMessageHeaders) || raw.internetMessageHeaders.length > 200) return bad();
    result.headers = [];
    let bytes = 0;
    for (const header of raw.internetMessageHeaders) {
      if (!record(header) || typeof header.name !== "string" || !SAFE_HEADERS.has(header.name.toLowerCase()) || typeof header.value !== "string") continue;
      // Unfold RFC continuation whitespace, but reject any remaining newline/control.
      const value = header.value.replace(/\r\n[\t ]+/gu, " ");
      if (!line(value, 8192, true)) continue;
      bytes += value.length;
      if (bytes > 64 * 1024) return bad();
      result.headers.push({ name: header.name.toLowerCase(), value });
    }
  }
  if (raw.singleValueExtendedProperties !== undefined) {
    if (!Array.isArray(raw.singleValueExtendedProperties) || raw.singleValueExtendedProperties.length > 10) return bad();
    for (const property of raw.singleValueExtendedProperties) {
      if (record(property) && property.id === EXCHANGE_GRAPH_COMMAND_PROPERTY) {
        if (result.commandId !== undefined || typeof property.value !== "string" || !UUID.test(property.value)) return bad();
        result.commandId = property.value;
      }
    }
  }
  return result;
}

function validateCursor(value: unknown, mailboxId: string, folderId: string, code: ExchangeGraphErrorCode): string {
  const bad = (): never => { throw failure(code, "read"); };
  const parsed = cursorUrl(value, code);
  let segments: string[];
  try { segments = parsed.pathname.split("/").map(decodeURIComponent); } catch { return bad(); }
  if (segments.length !== 8 || segments[0] !== "" || segments[1] !== "v1.0" || segments[2] !== "users" ||
      segments[3].toLowerCase() !== mailboxId.toLowerCase() || segments[4].toLowerCase() !== "mailfolders" ||
      segments[5] !== folderId || segments[6] !== "messages" || segments[7] !== "delta") return bad();
  const allowed = new Set(["$select", "$top", "$skiptoken", "$deltatoken"]);
  const seen = new Set<string>();
  for (const [key, token] of parsed.searchParams) {
    if (!allowed.has(key) || seen.has(key) || !token || CONTROL.test(token)) return bad();
    seen.add(key);
  }
  if (seen.has("$skiptoken") === seen.has("$deltatoken")) return bad();
  return value as string;
}

function cursorUrl(value: unknown, code: ExchangeGraphErrorCode): URL {
  const bad = (): never => { throw failure(code, "read"); };
  if (typeof value !== "string" || value.length > MAX_CURSOR_LENGTH || CONTROL.test(value) || value.includes("\\") || value.trim() !== value) return bad();
  let parsed: URL;
  try { parsed = new URL(value); } catch { return bad(); }
  if (parsed.origin !== ORIGIN || parsed.username || parsed.password || parsed.hash || parsed.port || parsed.protocol !== "https:") return bad();
  return parsed;
}

function mailboxBase(access: ExchangeGraphAccess, phase: ExchangeGraphPhase): string {
  if (!access || typeof access.mailboxId !== "string" || !UUID.test(access.mailboxId) ||
      !line(access.accessToken, 32 * 1024) || typeof access.assertCurrent !== "function") throw failure("exchange_graph_configuration_invalid", phase);
  return `${ORIGIN}/v1.0/users/${access.mailboxId.toLowerCase()}`;
}
function recipient(value: unknown): ExchangeGraphRecipient | null {
  if (!record(value) || !record(value.emailAddress) || !email(value.emailAddress.address)) return null;
  const result: ExchangeGraphRecipient = { address: value.emailAddress.address };
  if (value.emailAddress.name !== undefined && value.emailAddress.name !== null) {
    if (!line(value.emailAddress.name, 512, true)) return null;
    result.name = value.emailAddress.name;
  }
  return result;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function line(value: unknown, max: number, empty = false): value is string { return typeof value === "string" && (empty || value.length > 0) && value.length <= max && !CONTROL.test(value); }
function opaqueId(value: unknown): value is string { return line(value, 2048) && !/[\s?#%\\]/u.test(value) && value !== "." && value !== ".."; }
function email(value: unknown): value is string { return line(value, 254) && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value); }
function messageId(value: unknown): value is string { return typeof value === "string" && value.length <= 998 && /^<[^\s<>\u0000-\u001f\u007f]+@[^\s<>\u0000-\u001f\u007f]+>$/u.test(value); }
function retryAfter(value: string | null): number | undefined {
  if (value === null || !/^\d{1,12}$/u.test(value)) return undefined;
  return Math.min(3600, Math.max(1, Number(value)));
}
function failure(code: ExchangeGraphErrorCode, phase: ExchangeGraphPhase, status?: number): ExchangeGraphError { return new ExchangeGraphError(code, phase, status); }
function uncertain(phase: ExchangeGraphPhase, status?: number): ExchangeGraphError {
  return new ExchangeGraphError(phase === "draft_create" ? "exchange_graph_draft_outcome_unknown" : "exchange_graph_send_outcome_unknown", phase, status, undefined, true);
}
