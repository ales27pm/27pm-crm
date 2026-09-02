import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalSendAttemptFingerprint,
  createSendAttemptRegistry,
  shouldRetainSendAttempt,
} from "../lib/send-attempt-registry.ts";

function memoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

function serialCoordinator() {
  const tails = new Map();
  return {
    async run(name, work) {
      const previous = tails.get(name) ?? Promise.resolve();
      let release;
      const turn = new Promise((resolve) => {
        release = resolve;
      });
      tails.set(name, previous.then(() => turn));
      await previous;
      try {
        return await work();
      } finally {
        release();
      }
    },
  };
}

test("reuses one idempotency key for an unchanged retry", async () => {
  const generated = ["attempt-key-0001", "attempt-key-0002"];
  const registry = createSendAttemptRegistry(() => generated.shift());
  const payload = {
    from: "alexis@27pm.org",
    to: "client@example.com",
    subject: "Bonjour",
    body: "Une observation.",
    complianceConfirmed: true,
  };

  const first = await registry.keyFor(payload);
  const retry = await registry.keyFor({
    body: "Une observation.",
    subject: "Bonjour",
    to: "client@example.com",
    from: "alexis@27pm.org",
    complianceConfirmed: true,
  });

  assert.equal(first, "attempt-key-0001");
  assert.equal(retry, first);
  assert.equal(registry.pendingCount(), 1);
});

test("keeps interleaved failures separate", async () => {
  let sequence = 0;
  const registry = createSendAttemptRegistry(
    () => `attempt-key-${String(++sequence).padStart(4, "0")}`,
  );
  const compose = { to: "one@example.com", body: "Premier" };
  const reply = { to: "two@example.com", body: "Deuxieme" };

  const composeKey = await registry.keyFor(compose);
  const replyKey = await registry.keyFor(reply);
  assert.equal(await registry.keyFor(compose), composeKey);
  assert.equal(await registry.keyFor(reply), replyKey);
});

test("a material draft change receives a new idempotency key", async () => {
  let sequence = 0;
  const registry = createSendAttemptRegistry(() => `attempt-key-${++sequence}000000`);

  const before = await registry.keyFor({ to: "client@example.com", body: "Version A" });
  const after = await registry.keyFor({ to: "client@example.com", body: "Version B" });

  assert.notEqual(after, before);
});

test("persists an unresolved intention across reloads and releases it after confirmation", async () => {
  const storage = memoryStorage();
  let sequence = 0;
  const factory = () => `attempt-key-${String(++sequence).padStart(4, "0")}`;
  const payload = { to: "client@example.com", body: "Message stable" };
  const firstPage = createSendAttemptRegistry(factory, storage);

  const first = await firstPage.keyFor(payload);
  const reloadedPage = createSendAttemptRegistry(factory, storage);
  assert.equal(await reloadedPage.keyFor(payload), first);

  await firstPage.confirm(payload, first);
  const nextIntention = createSendAttemptRegistry(factory, storage);
  assert.notEqual(await nextIntention.keyFor(payload), first);
});

test("canonicalizes the same command exactly as the send route", () => {
  const raw = {
    from: " Alexis Boulet <ALEXIS@27PM.ORG> ",
    to: " Client <CLIENT@example.com> ",
    subject: " Bonjour\r\n",
    body: "  Une observation.  ",
    complianceConfirmed: true,
  };
  const normalized = {
    from: "alexis@27pm.org",
    to: "client@example.com",
    subject: "Bonjour",
    text: "Une observation.",
    complianceConfirmed: true,
  };

  assert.equal(
    canonicalSendAttemptFingerprint(raw),
    canonicalSendAttemptFingerprint(normalized),
  );
});

test("retains only ambiguous attempts and releases definitive responses", () => {
  assert.equal(
    shouldRetainSendAttempt(503, "mailgun_send_unconfirmed"),
    true,
  );
  assert.equal(
    shouldRetainSendAttempt(409, "send_command_in_progress"),
    true,
  );
  assert.equal(
    shouldRetainSendAttempt(409, "idempotency_key_reused"),
    true,
  );
  assert.equal(shouldRetainSendAttempt(500, null), true);
  assert.equal(shouldRetainSendAttempt(500, "internal_server_error"), true);
  assert.equal(shouldRetainSendAttempt(409, null), true);
  assert.equal(shouldRetainSendAttempt(502, "mailgun_send_failed"), false);
  assert.equal(shouldRetainSendAttempt(409, "recipient_not_qualified"), false);
});

test("serializes key creation across tabs", async () => {
  const storage = memoryStorage();
  const coordinator = serialCoordinator();
  const first = createSendAttemptRegistry(
    () => "attempt-key-first",
    storage,
    coordinator,
    true,
  );
  const second = createSendAttemptRegistry(
    () => "attempt-key-second",
    storage,
    coordinator,
    true,
  );
  const payload = { to: "client@example.com", body: "Même intention" };

  const [firstKey, secondKey] = await Promise.all([
    first.keyFor(payload),
    second.keyFor(payload),
  ]);
  assert.equal(firstKey, secondKey);
});

test("a stale confirmation cannot delete a newer identical intention", async () => {
  const storage = memoryStorage();
  const coordinator = serialCoordinator();
  let sequence = 0;
  const factory = () => `attempt-key-${String(++sequence).padStart(4, "0")}`;
  const payload = { to: "client@example.com", body: "Même contenu" };
  const firstTab = createSendAttemptRegistry(factory, storage, coordinator, true);
  const staleTab = createSendAttemptRegistry(factory, storage, coordinator, true);
  const firstKey = await firstTab.keyFor(payload);
  assert.equal(await staleTab.keyFor(payload), firstKey);

  await firstTab.confirm(payload, firstKey);
  const freshTab = createSendAttemptRegistry(factory, storage, coordinator, true);
  const freshKey = await freshTab.keyFor(payload);
  assert.notEqual(freshKey, firstKey);

  await staleTab.confirm(payload, firstKey);
  const reloadedFreshTab = createSendAttemptRegistry(
    factory,
    storage,
    coordinator,
    true,
  );
  assert.equal(await reloadedFreshTab.keyFor(payload), freshKey);
});

test("fails closed when durable browser coordination or storage fails", async () => {
  const payload = { to: "client@example.com", body: "Ne pas doubler" };
  await assert.rejects(
    createSendAttemptRegistry(
      () => "attempt-key-no-lock",
      memoryStorage(),
      null,
      true,
    ).keyFor(payload),
    /coordination/u,
  );

  const brokenStorage = {
    getItem() {
      return null;
    },
    setItem() {
      throw new Error("quota denied");
    },
    removeItem() {},
  };
  await assert.rejects(
    createSendAttemptRegistry(
      () => "attempt-key-no-storage",
      brokenStorage,
      serialCoordinator(),
      true,
    ).keyFor(payload),
    /persist/u,
  );
});
