import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import test from "node:test";

import {
  createInternalApiAssertion,
  internalApiBodyDigest,
  internalApiCriticalHeadersDigest,
  INTERNAL_API_ASSERTION_MAX_TTL_SECONDS,
  verifyInternalApiAssertion,
} from "../lib/internal-api-auth.ts";

const SECRET = Buffer.alloc(32, 27).toString("base64url");
const OTHER_SECRET = Buffer.alloc(32, 9).toString("base64url");
const NOW = new Date("2026-10-02T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.valueOf() / 1000);
const NONCE = Buffer.alloc(16, 5).toString("base64url");
const BODY = JSON.stringify({ action: "sync", id: "deal_123" });
const BODY_DIGEST = createHash("sha256").update(BODY).digest("base64url");
const QUERY_DIGEST = createHash("sha256")
  .update("?window=24h&mailbox=bonjour")
  .digest("base64url");
const HEADER_DIGEST = createHash("sha256")
  .update(JSON.stringify([
    ["content-type", "application/json"],
    ["idempotency-key", "request-1234"],
  ]))
  .digest("base64url");
const CONTEXT = {
  audience: "27pm-sites-worker",
  method: "POST",
  pathname: "/api/internal/sync",
  bodyDigest: BODY_DIGEST,
  queryDigest: QUERY_DIGEST,
  headerDigest: HEADER_DIGEST,
};

test("internal API assertions bind a normalized operator to the exact request", async () => {
  const issued = await createInternalApiAssertion(
    SECRET,
    {
      subject: "  Alexis@27PM.org ",
      ...CONTEXT,
      nonce: NONCE,
    },
    NOW,
  );

  assert.match(issued.token, /^ia1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u);
  assert.deepEqual(issued.claims, {
    version: 1,
    subject: "alexis@27pm.org",
    audience: CONTEXT.audience,
    method: CONTEXT.method,
    pathname: CONTEXT.pathname,
    issuedAt: NOW_SECONDS,
    expiresAt: NOW_SECONDS + 30,
    nonce: NONCE,
    bodyDigest: BODY_DIGEST,
    queryDigest: QUERY_DIGEST,
    headerDigest: HEADER_DIGEST,
  });

  const verified = await verifyInternalApiAssertion(
    SECRET,
    issued.token,
    CONTEXT,
    NOW,
  );
  assert.deepEqual(verified, issued.claims);

  const [prefix, payload, signature] = issued.token.split(".");
  assert.equal(prefix, "ia1");
  assert.equal(
    signature,
    createHmac("sha256", Buffer.from(SECRET, "base64url"))
      .update(`${prefix}.${payload}`)
      .digest("base64url"),
  );
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    aud: CONTEXT.audience,
    bd: BODY_DIGEST,
    exp: NOW_SECONDS + 30,
    hd: HEADER_DIGEST,
    iat: NOW_SECONDS,
    mth: CONTEXT.method,
    nonce: NONCE,
    pth: CONTEXT.pathname,
    qd: QUERY_DIGEST,
    sub: "alexis@27pm.org",
    v: 1,
  });
});

test("verification rejects tampering and every mismatched request boundary", async () => {
  const { token } = await createInternalApiAssertion(
    SECRET,
    {
      subject: "alexis@27pm.org",
      ...CONTEXT,
      nonce: NONCE,
    },
    NOW,
  );

  const last = token.at(-1);
  const tampered = `${token.slice(0, -1)}${last === "A" ? "B" : "A"}`;
  assert.equal(await verifyInternalApiAssertion(SECRET, tampered, CONTEXT, NOW), null);
  assert.equal(await verifyInternalApiAssertion(OTHER_SECRET, token, CONTEXT, NOW), null);

  for (const mismatch of [
    { ...CONTEXT, audience: "other-worker" },
    { ...CONTEXT, method: "GET" },
    { ...CONTEXT, pathname: "/api/internal/other" },
    { ...CONTEXT, bodyDigest: createHash("sha256").update("other").digest("base64url") },
    { ...CONTEXT, bodyDigest: undefined },
    { ...CONTEXT, queryDigest: createHash("sha256").update("?window=7d").digest("base64url") },
    { ...CONTEXT, queryDigest: undefined },
    { ...CONTEXT, headerDigest: createHash("sha256").update("other").digest("base64url") },
    { ...CONTEXT, headerDigest: undefined },
    { ...CONTEXT, subject: "other@27pm.org" },
    { ...CONTEXT, nonce: Buffer.alloc(16, 6).toString("base64url") },
  ]) {
    assert.equal(
      await verifyInternalApiAssertion(SECRET, token, mismatch, NOW),
      null,
    );
  }

  assert.equal(
    await verifyInternalApiAssertion(
      SECRET,
      token,
      CONTEXT,
      new Date("2026-10-02T12:00:30.000Z"),
    ),
    null,
  );
});

test("assertions without a body digest remain bound to its absence", async () => {
  const request = {
    audience: "27pm-sites-worker",
    method: "GET",
    pathname: "/api/internal/health",
    queryDigest: createHash("sha256").update("").digest("base64url"),
    headerDigest: await internalApiCriticalHeadersDigest(new Headers()),
  };
  const first = await createInternalApiAssertion(
    SECRET,
    { subject: "alexis@27pm.org", ...request },
    NOW,
  );
  const second = await createInternalApiAssertion(
    SECRET,
    { subject: "alexis@27pm.org", ...request },
    NOW,
  );

  assert.equal(first.claims.bodyDigest, undefined);
  assert.match(first.claims.nonce, /^[A-Za-z0-9_-]{22}$/u);
  assert.notEqual(first.claims.nonce, second.claims.nonce);
  assert.ok(await verifyInternalApiAssertion(SECRET, first.token, request, NOW));
  assert.equal(
    await verifyInternalApiAssertion(
      SECRET,
      first.token,
      { ...request, bodyDigest: BODY_DIGEST },
      NOW,
    ),
    null,
  );
});

test("body digests use SHA-256 over the exact bytes", async () => {
  assert.equal(await internalApiBodyDigest(BODY), BODY_DIGEST);
  assert.equal(
    await internalApiBodyDigest(new TextEncoder().encode(BODY)),
    BODY_DIGEST,
  );
  assert.notEqual(await internalApiBodyDigest(`${BODY}\n`), BODY_DIGEST);
});

test("critical request headers have a deterministic, bounded digest", async () => {
  const headers = new Headers({
    authorization: "Bearer ignored",
    "content-type": "application/json",
    "idempotency-key": "request-1234",
  });
  assert.equal(await internalApiCriticalHeadersDigest(headers), HEADER_DIGEST);

  headers.set("authorization", "Bearer still-ignored");
  assert.equal(await internalApiCriticalHeadersDigest(headers), HEADER_DIGEST);

  headers.set("idempotency-key", "request-5678");
  assert.notEqual(await internalApiCriticalHeadersDigest(headers), HEADER_DIGEST);
  headers.delete("idempotency-key");
  assert.notEqual(await internalApiCriticalHeadersDigest(headers), HEADER_DIGEST);
});

test("signing rejects weak secrets and non-canonical request inputs", async () => {
  const valid = {
    subject: "alexis@27pm.org",
    audience: "27pm-sites-worker",
    method: "POST",
    pathname: "/api/internal/sync",
    nonce: NONCE,
    headerDigest: HEADER_DIGEST,
  };
  for (const [secret, input, ttl] of [
    ["too-short", valid],
    [SECRET, { ...valid, subject: "not-an-email" }],
    [SECRET, { ...valid, audience: " worker " }],
    [SECRET, { ...valid, method: "post" }],
    [SECRET, { ...valid, pathname: "api/internal/sync" }],
    [SECRET, { ...valid, pathname: "/api/../admin" }],
    [SECRET, { ...valid, pathname: "/api/%2f/admin" }],
    [SECRET, { ...valid, nonce: "short" }],
    [SECRET, { ...valid, bodyDigest: "not-a-sha256-digest" }],
    [SECRET, { ...valid, headerDigest: "not-a-sha256-digest" }],
    [SECRET, valid, 0],
    [SECRET, valid, INTERNAL_API_ASSERTION_MAX_TTL_SECONDS + 1],
  ]) {
    await assert.rejects(
      createInternalApiAssertion(secret, input, NOW, ttl),
      /internal_api_assertion_input_invalid/u,
    );
  }
});

test("verification enforces canonical encoding and an exact, short-lived claim set", async () => {
  const validClaims = {
    v: 1,
    sub: "alexis@27pm.org",
    aud: CONTEXT.audience,
    mth: CONTEXT.method,
    pth: CONTEXT.pathname,
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 30,
    nonce: NONCE,
    bd: BODY_DIGEST,
    hd: HEADER_DIGEST,
    qd: QUERY_DIGEST,
  };

  for (const claims of [
    { ...validClaims, v: 2 },
    { ...validClaims, sub: "Alexis@27pm.org" },
    { ...validClaims, exp: validClaims.iat },
    { ...validClaims, exp: validClaims.iat + INTERNAL_API_ASSERTION_MAX_TTL_SECONDS + 1 },
    { ...validClaims, iat: validClaims.iat + 6, exp: validClaims.iat + 36 },
    { ...validClaims, extra: true },
  ]) {
    const token = signedToken(claims);
    assert.equal(await verifyInternalApiAssertion(SECRET, token, CONTEXT, NOW), null);
  }

  const validToken = signedToken(validClaims);
  assert.equal(
    await verifyInternalApiAssertion(SECRET, `${validToken}.junk`, CONTEXT, NOW),
    null,
  );
  assert.equal(
    await verifyInternalApiAssertion(SECRET, validToken.replace("ia1.", "ia2."), CONTEXT, NOW),
    null,
  );
  assert.equal(
    await verifyInternalApiAssertion("too-short", validToken, CONTEXT, NOW),
    null,
  );
  assert.equal(
    await verifyInternalApiAssertion(SECRET, `ia1.bad.${"a".repeat(43)}`, CONTEXT, NOW),
    null,
  );
});

function signedToken(claims) {
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signingInput = `ia1.${payload}`;
  const signature = createHmac("sha256", Buffer.from(SECRET, "base64url"))
    .update(signingInput)
    .digest("base64url");
  return `${signingInput}.${signature}`;
}
