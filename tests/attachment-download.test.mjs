import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  ATTACHMENT_DOWNLOAD_MAX_TTL_SECONDS,
  attachmentObjectDigest,
  attachmentObjectMatches,
  createAttachmentDownloadTicket,
  safeAttachmentContentDisposition,
  safeAttachmentDisplayName,
  verifyAttachmentDownloadTicket,
} from "../lib/attachment-download.ts";
import { handleAttachmentDownloadRequest } from "../lib/attachment-download-worker.ts";

const SECRET = Buffer.alloc(32, 41).toString("base64url");
const OTHER_SECRET = Buffer.alloc(32, 42).toString("base64url");
const NOW = new Date("2026-10-02T16:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.valueOf() / 1000);
const ATTACHMENT_ID = "att_0123456789abcdef";
const ORIGIN = "https://files.crm.27pm.org";
const PATHNAME = `/downloads/attachments/${ATTACHMENT_ID}`;
const NONCE = Buffer.alloc(24, 7).toString("base64url");
const SHA256 = createHash("sha256").update("private attachment").digest("hex");
const SHA256_BYTES = Uint8Array.from(Buffer.from(SHA256, "hex")).buffer;
const ROW = {
  r2Key: `mail/message-1/${ATTACHMENT_ID}/devis.pdf`,
  fileName: "devis.pdf",
  sizeBytes: 18,
  sha256: SHA256,
  scanStatus: "clean",
};
const OBJECT = {
  key: ROW.r2Key,
  size: ROW.sizeBytes,
  etag: "0123456789abcdef",
  version: "v-123",
  httpEtag: '"0123456789abcdef"',
  customMetadata: { sha256: SHA256, scanStatus: "unscanned" },
  checksums: { sha256: SHA256_BYTES },
};

test("attachment tickets bind a one-time claim to the exact Worker object", async () => {
  const objectDigest = await attachmentObjectDigest({
    attachmentId: ATTACHMENT_ID,
    attachment: ROW,
    object: OBJECT,
  });
  const issued = await createAttachmentDownloadTicket(
    SECRET,
    {
      attachmentId: ATTACHMENT_ID,
      origin: ORIGIN,
      pathname: PATHNAME,
      objectDigest,
      nonce: NONCE,
    },
    NOW,
  );

  assert.match(issued.token, /^ad2\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(issued.claims, {
    version: 2,
    audience: "27pm-attachment-download",
    origin: ORIGIN,
    method: "POST",
    pathname: PATHNAME,
    attachmentId: ATTACHMENT_ID,
    objectDigest,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 45,
    nonce: NONCE,
  });
  assert.deepEqual(
    await verifyAttachmentDownloadTicket(
      SECRET,
      issued.token,
      { attachmentId: ATTACHMENT_ID, origin: ORIGIN, pathname: PATHNAME },
      NOW,
    ),
    issued.claims,
  );

  const [prefix, payload, signature] = issued.token.split(".");
  assert.equal(
    signature,
    createHmac("sha256", Buffer.from(SECRET, "base64url"))
      .update(`${prefix}.${payload}`)
      .digest("base64url"),
  );
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(decoded, {
    v: 2,
    aud: "27pm-attachment-download",
    ori: ORIGIN,
    mth: "POST",
    pth: PATHNAME,
    aid: ATTACHMENT_ID,
    obj: objectDigest,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 45,
    nonce: NONCE,
  });
  assert.equal(JSON.stringify(decoded).includes(ROW.r2Key), false);
  assert.equal(JSON.stringify(decoded).includes(ROW.fileName), false);
  assert.equal(JSON.stringify(decoded).includes("@"), false);
});

test("ticket verification rejects tampering, replay-boundary mismatches, and bad time", async () => {
  const ticket = await issueTicket();
  const last = ticket.token.at(-1);
  const tampered = `${ticket.token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  for (const [secret, token, expected, now] of [
    [OTHER_SECRET, ticket.token, expectedContext(), NOW],
    [SECRET, tampered, expectedContext(), NOW],
    [SECRET, ticket.token.replace(/^ad2/u, "ad1"), expectedContext(), NOW],
    [SECRET, `${ticket.token}.extra`, expectedContext(), NOW],
    [SECRET, ticket.token, { ...expectedContext(), attachmentId: "att_other" }, NOW],
    [SECRET, ticket.token, { ...expectedContext(), origin: "https://other.example" }, NOW],
    [SECRET, ticket.token, { ...expectedContext(), pathname: `${PATHNAME}/other` }, NOW],
    [SECRET, ticket.token, expectedContext(), new Date((ticket.claims.expiresAt) * 1000)],
    [SECRET, ticket.token, expectedContext(), new Date((ticket.claims.issuedAt - 6) * 1000)],
  ]) {
    assert.equal(
      await verifyAttachmentDownloadTicket(secret, token, expected, now),
      null,
    );
  }
});

test("ticket creation rejects weak keys and non-canonical inputs", async () => {
  const digest = await validObjectDigest();
  const input = {
    attachmentId: ATTACHMENT_ID,
    origin: ORIGIN,
    pathname: PATHNAME,
    objectDigest: digest,
    nonce: NONCE,
  };
  for (const [secret, candidate, ttl] of [
    ["weak", input],
    [SECRET, { ...input, attachmentId: "../secret" }],
    [SECRET, { ...input, origin: "http://files.crm.27pm.org" }],
    [SECRET, { ...input, origin: `${ORIGIN}/path` }],
    [SECRET, { ...input, pathname: "/downloads/attachments/other" }],
    [SECRET, { ...input, objectDigest: "not-a-digest" }],
    [SECRET, { ...input, nonce: "short" }],
    [SECRET, input, 0],
    [SECRET, input, ATTACHMENT_DOWNLOAD_MAX_TTL_SECONDS + 1],
  ]) {
    await assert.rejects(
      createAttachmentDownloadTicket(secret, candidate, NOW, ttl),
      /attachment_download_ticket_input_invalid/u,
    );
  }
});

test("object identity rejects missing integrity metadata and every changed field", async () => {
  assert.equal(attachmentObjectMatches(ROW, OBJECT), true);
  for (const [row, object] of [
    [{ ...ROW, sha256: null }, OBJECT],
    [{ ...ROW, sha256: SHA256.toUpperCase() }, OBJECT],
    [ROW, { ...OBJECT, key: "mail/other" }],
    [ROW, { ...OBJECT, size: ROW.sizeBytes + 1 }],
    [ROW, { ...OBJECT, etag: "" }],
    [ROW, { ...OBJECT, version: "" }],
    [ROW, { ...OBJECT, customMetadata: {} }],
    [ROW, { ...OBJECT, customMetadata: { sha256: "0".repeat(64) } }],
    [ROW, { ...OBJECT, checksums: undefined }],
    [ROW, {
      ...OBJECT,
      checksums: {
        sha256: Uint8Array.from(Buffer.from("0".repeat(64), "hex")).buffer,
      },
    }],
    [ROW, { ...OBJECT, checksums: { sha256: new Uint8Array(31).buffer } }],
  ]) {
    assert.equal(attachmentObjectMatches(row, object), false);
    await assert.rejects(
      attachmentObjectDigest({ attachmentId: ATTACHMENT_ID, attachment: row, object }),
      /attachment_object_metadata_invalid/u,
    );
  }
});

test("content disposition is safe for control characters, bidi, quotes, and Unicode", () => {
  const header = safeAttachmentContentDisposition(
    'résumé\r\n";evil=.html/\\\u202e.pdf',
  );
  assert.match(header, /^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/u);
  assert.doesNotMatch(header, /[\r\n\u202e]/u);
  assert.doesNotMatch(header, /filename="[^"]*[/\\%;][^"]*"/u);
  assert.match(header, /r%C3%A9sum%C3%A9/u);
  assert.equal(
    safeAttachmentDisplayName("invoice\u061c\u200e\u200f\u202egnp.exe"),
    "invoice____gnp.exe",
  );
});

test("direct Worker download is streamed once with a conditional R2 read", async () => {
  const ticket = await issueTicket();
  const state = downloadState();
  const environment = fakeEnvironment(state);
  const request = downloadRequest(ticket.token);

  assert.equal(request.method, "POST");
  assert.equal(new URL(request.url).search, "");
  assert.equal(
    request.headers.get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    await request.clone().text(),
    `ticket=${encodeURIComponent(ticket.token)}`,
  );

  const response = await handleAttachmentDownloadRequest(request, environment, NOW);
  assert.ok(response);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.equal(response.headers.get("content-length"), String(ROW.sizeBytes));
  assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("cross-origin-resource-policy"), "same-site");
  assert.match(response.headers.get("content-security-policy"), /default-src 'none'/u);
  assert.equal(await response.text(), "private attachment");
  assert.deepEqual(state.getOptions, { onlyIf: { etagMatches: OBJECT.etag } });
  assert.equal(state.nonces.size, 1);

  const replay = await handleAttachmentDownloadRequest(downloadRequest(ticket.token), environment, NOW);
  assert.equal(replay.status, 401);
  assert.deepEqual(await replay.json(), { error: "attachment_download_used_or_changed" });
  assert.equal(state.getCalls, 1);
});

test("two concurrent uses have exactly one winner", async () => {
  const ticket = await issueTicket();
  const state = downloadState();
  const environment = fakeEnvironment(state);
  const [first, second] = await Promise.all([
    handleAttachmentDownloadRequest(downloadRequest(ticket.token), environment, NOW),
    handleAttachmentDownloadRequest(downloadRequest(ticket.token), environment, NOW),
  ]);
  assert.deepEqual([first.status, second.status].sort(), [200, 401]);
  assert.equal(state.getCalls, 1);
  assert.equal(state.nonces.size, 1);
});

test("invalid transport or form input fails before D1 or R2", async () => {
  const ticket = await issueTicket();
  const cases = [
    {
      name: "invalid ticket",
      request: downloadRequest(`${ticket.token}x`),
      status: 401,
      error: "attachment_download_invalid",
    },
    {
      name: "GET",
      request: new Request(`${ORIGIN}${PATHNAME}`),
      status: 405,
      error: "attachment_download_method_not_allowed",
      allow: "POST",
    },
    {
      name: "HEAD",
      request: new Request(`${ORIGIN}${PATHNAME}`, { method: "HEAD" }),
      status: 405,
      error: "attachment_download_method_not_allowed",
      allow: "POST",
    },
    {
      name: "Range",
      request: downloadRequest(ticket.token, {
        headers: { range: "bytes=0-1" },
      }),
      status: 400,
      error: "attachment_range_not_supported",
    },
    {
      name: "query string",
      request: downloadRequest(ticket.token, { search: "?debug=1" }),
      status: 400,
      error: "attachment_download_query_forbidden",
    },
    {
      name: "legacy URL bearer",
      request: new Request(
        `${ORIGIN}${PATHNAME}?ticket=${encodeURIComponent(ticket.token)}`,
      ),
      status: 400,
      error: "attachment_download_query_forbidden",
    },
    {
      name: "missing MIME",
      request: downloadRequest(ticket.token, {
        headers: { "content-type": "" },
      }),
      status: 415,
      error: "attachment_download_content_type_invalid",
    },
    {
      name: "wrong MIME",
      request: downloadRequest(ticket.token, {
        headers: { "content-type": "application/json" },
      }),
      status: 415,
      error: "attachment_download_content_type_invalid",
    },
    {
      name: "encoded body",
      request: downloadRequest(ticket.token, {
        headers: { "content-encoding": "gzip" },
      }),
      status: 415,
      error: "attachment_download_content_encoding_invalid",
    },
    {
      name: "invalid Content-Length",
      request: downloadRequest(ticket.token, {
        headers: { "content-length": "8.5" },
      }),
      status: 400,
      error: "attachment_download_content_length_invalid",
    },
    {
      name: "oversized declared Content-Length",
      request: downloadRequest(ticket.token, {
        headers: { "content-length": "8193" },
      }),
      status: 413,
      error: "attachment_download_request_too_large",
    },
    {
      name: "oversized body",
      request: downloadRequest(ticket.token, { body: "x".repeat(8193) }),
      status: 413,
      error: "attachment_download_request_too_large",
    },
    {
      name: "duplicate ticket field",
      request: downloadRequest(ticket.token, {
        body: `ticket=${encodeURIComponent(ticket.token)}&ticket=again`,
      }),
      status: 401,
      error: "attachment_download_invalid",
    },
    {
      name: "extra form field",
      request: downloadRequest(ticket.token, {
        body: `ticket=${encodeURIComponent(ticket.token)}&debug=1`,
      }),
      status: 401,
      error: "attachment_download_invalid",
    },
    {
      name: "empty ticket field",
      request: downloadRequest(ticket.token, { body: "ticket=" }),
      status: 401,
      error: "attachment_download_invalid",
    },
    {
      name: "empty form body",
      request: downloadRequest(ticket.token, { body: "" }),
      status: 401,
      error: "attachment_download_invalid",
    },
  ];

  for (const { name, request, status, error, allow } of cases) {
    const state = downloadState({ rejectAccess: true });
    const response = await handleAttachmentDownloadRequest(request, fakeEnvironment(state), NOW);
    assert.equal(response.status, status, name);
    assert.deepEqual(await response.json(), { error }, name);
    assert.equal(response.headers.get("allow"), allow ?? null, name);
    assert.equal(state.databaseCalls, 0);
    assert.equal(state.headCalls, 0);
    assert.equal(state.getCalls, 0);
    assert.equal(response.headers.get("cache-control"), "private, no-store, max-age=0");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  }
});

test("download rechecks antivirus state and burns the ticket before R2 GET", async () => {
  for (const scanStatus of ["unscanned", "infected", "rejected"]) {
    const ticket = await issueTicket();
    const state = downloadState({ row: { ...ROW, scanStatus } });
    const response = await handleAttachmentDownloadRequest(
      downloadRequest(ticket.token),
      fakeEnvironment(state),
      NOW,
    );
    assert.equal(response.status, scanStatus === "unscanned" ? 423 : 403);
    assert.equal(state.getCalls, 0);
    assert.equal(state.nonces.size, 0);
  }

  const ticket = await issueTicket();
  const changed = downloadState({ object: { ...OBJECT, version: "v-replaced" } });
  const response = await handleAttachmentDownloadRequest(
    downloadRequest(ticket.token),
    fakeEnvironment(changed),
    NOW,
  );
  assert.equal(response.status, 409);
  assert.equal(changed.getCalls, 0);
  assert.equal(changed.nonces.size, 0);

  const raceTicket = await issueTicket();
  const race = downloadState();
  race.afterHead = () => {
    race.row = { ...ROW, scanStatus: "infected" };
  };
  const raceResponse = await handleAttachmentDownloadRequest(
    downloadRequest(raceTicket.token),
    fakeEnvironment(race),
    NOW,
  );
  assert.equal(raceResponse.status, 401);
  assert.equal(race.getCalls, 0);
  assert.equal(race.nonces.size, 0);

  const replacedTicket = await issueTicket();
  const replaced = downloadState();
  replaced.afterHead = () => {
    replaced.object = {
      ...OBJECT,
      etag: "fedcba9876543210",
      version: "v-replaced-after-head",
    };
  };
  const replacedResponse = await handleAttachmentDownloadRequest(
    downloadRequest(replacedTicket.token),
    fakeEnvironment(replaced),
    NOW,
  );
  assert.equal(replacedResponse.status, 409);
  assert.equal(replaced.getCalls, 1);
  assert.equal(replaced.nonces.size, 1);
});

async function issueTicket() {
  return createAttachmentDownloadTicket(
    SECRET,
    {
      ...expectedContext(),
      objectDigest: await validObjectDigest(),
      nonce: NONCE,
    },
    NOW,
  );
}

function expectedContext() {
  return { attachmentId: ATTACHMENT_ID, origin: ORIGIN, pathname: PATHNAME };
}

function validObjectDigest() {
  return attachmentObjectDigest({
    attachmentId: ATTACHMENT_ID,
    attachment: ROW,
    object: OBJECT,
  });
}

function downloadRequest(token, options = {}) {
  const headers = new Headers(options.headers);
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/x-www-form-urlencoded");
  }
  return new Request(`${ORIGIN}${PATHNAME}${options.search ?? ""}`, {
    method: "POST",
    headers,
    body: options.body ?? `ticket=${encodeURIComponent(token)}`,
  });
}

function downloadState(overrides = {}) {
  return {
    row: overrides.row ?? ROW,
    object: overrides.object ?? OBJECT,
    body: overrides.body ?? "private attachment",
    rejectAccess: overrides.rejectAccess ?? false,
    nonces: new Set(),
    databaseCalls: 0,
    headCalls: 0,
    getCalls: 0,
    getOptions: null,
    afterHead: null,
  };
}

function fakeEnvironment(state) {
  return {
    CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY: SECRET,
    CRM_ATTACHMENT_DOWNLOAD_ORIGIN: ORIGIN,
    DB: {
      prepare(query) {
        state.databaseCalls += 1;
        if (state.rejectAccess) throw new Error("unexpected database access");
        let values = [];
        return {
          bind(...nextValues) {
            values = nextValues;
            return this;
          },
          async first() {
            assert.match(query, /FROM attachments/u);
            return state.row;
          },
          async run() {
            assert.match(query, /INSERT INTO internal_api_nonces/u);
            const [nonceKey, , id, r2Key, sizeBytes, sha256] = values;
            const rowStillMatches = state.row?.scanStatus === "clean" &&
              id === ATTACHMENT_ID &&
              r2Key === state.row.r2Key &&
              sizeBytes === state.row.sizeBytes &&
              sha256 === state.row.sha256;
            if (!rowStillMatches || state.nonces.has(nonceKey)) {
              return { success: true, meta: { changes: 0 } };
            }
            state.nonces.add(nonceKey);
            return { success: true, meta: { changes: 1 } };
          },
        };
      },
    },
    BUCKET: {
      async head() {
        state.headCalls += 1;
        if (state.rejectAccess) throw new Error("unexpected R2 access");
        const object = state.object;
        state.afterHead?.();
        return object;
      },
      async get(_key, options) {
        state.getCalls += 1;
        state.getOptions = options;
        if (state.object.etag !== options.onlyIf.etagMatches) {
          return state.object;
        }
        return {
          ...state.object,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(state.body));
              controller.close();
            },
          }),
        };
      },
    },
  };
}
