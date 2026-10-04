import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeInternalApiNonce,
  pruneExpiredInternalApiNonces,
} from "../lib/internal-api-nonce-store.ts";

test("consumes an assertion nonce exactly once with an atomic insert", async () => {
  const seen = new Set();
  const calls = [];
  const database = fakeDatabase(async (query, values) => {
    calls.push({ query, values });
    const [nonce] = values;
    if (seen.has(nonce)) return { success: true, meta: { changes: 0 } };
    seen.add(nonce);
    return { success: true, meta: { changes: 1 } };
  });
  const claims = {
    nonce: Buffer.alloc(16, 7).toString("base64url"),
    expiresAt: 1_798_806_430,
  };

  assert.equal(await consumeInternalApiNonce(database, claims), true);
  assert.equal(await consumeInternalApiNonce(database, claims), false);
  assert.equal(calls.length, 2);
  assert.match(calls[0].query, /ON CONFLICT\(nonce\) DO NOTHING/u);
  assert.deepEqual(calls[0].values, [
    claims.nonce,
    new Date(claims.expiresAt * 1000).toISOString(),
  ]);
});

test("fails closed when D1 cannot confirm a nonce insert", async () => {
  for (const result of [
    { success: false, meta: { changes: 1 } },
    { success: true, meta: { changes: 0 } },
    { success: true },
  ]) {
    const database = fakeDatabase(async () => result);
    assert.equal(
      await consumeInternalApiNonce(database, {
        nonce: Buffer.alloc(16, 8).toString("base64url"),
        expiresAt: 1_798_806_430,
      }),
      false,
    );
  }
});

test("prunes only rows whose expiry is no later than now", async () => {
  const calls = [];
  const database = fakeDatabase(async (query, values) => {
    calls.push({ query, values });
    return { success: true, meta: { changes: 3 } };
  });
  const now = new Date("2026-10-02T12:00:00.000Z");

  await pruneExpiredInternalApiNonces(database, now);

  assert.equal(calls.length, 1);
  assert.match(calls[0].query, /^DELETE FROM internal_api_nonces/u);
  assert.deepEqual(calls[0].values, [now.toISOString()]);
});

function fakeDatabase(run) {
  return {
    prepare(query) {
      let values = [];
      return {
        bind(...nextValues) {
          values = nextValues;
          return this;
        },
        run() {
          return run(query, values);
        },
      };
    },
  };
}
