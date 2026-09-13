import assert from "node:assert/strict";
import test from "node:test";

import {
  createFrozenSendDraftRegistry,
  FrozenSendDraftError,
  replyFrozenDraftSlot,
} from "../lib/frozen-send-draft.ts";
import { executeFrozenSend } from "../app/components/frozen-send-ui.ts";

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

const payload = {
  from: "alexis@27pm.org",
  to: "client@example.com",
  subject: "Bonjour",
  body: "Une observation.",
  complianceConfirmed: true,
};

test("restores an unknown frozen draft after remount and blocks every retry", async () => {
  const storage = memoryStorage();
  const coordinator = serialCoordinator();
  const firstPage = createFrozenSendDraftRegistry(
    storage,
    coordinator,
    true,
  );
  const reservation = await firstPage.reserve("compose", payload);
  await firstPage.settle(reservation, "outcome_unknown");

  const reloadedPage = createFrozenSendDraftRegistry(
    storage,
    coordinator,
    true,
  );
  assert.deepEqual(await reloadedPage.restore("compose"), {
    outcome: "outcome_unknown",
    payload,
  });
  await assert.rejects(
    reloadedPage.reserve("compose", payload),
    (error) =>
      error instanceof FrozenSendDraftError && error.code === "blocked",
  );
  await assert.rejects(
    reloadedPage.reserve("compose", { ...payload, body: "Texte modifié" }),
    (error) =>
      error instanceof FrozenSendDraftError && error.code === "blocked",
  );
});

test("allows only the exact local-repair retry and preserves acceptance until repaired", async () => {
  const storage = memoryStorage();
  const coordinator = serialCoordinator();
  const registry = createFrozenSendDraftRegistry(storage, coordinator, true);
  const slot = replyFrozenDraftSlot("conversation-one");
  const reply = { ...payload, conversationId: "conversation-one" };
  const initial = await registry.reserve(slot, reply);
  await registry.settle(initial, "local_repair");

  await assert.rejects(
    registry.reserve(slot, { ...reply, subject: "Objet modifié" }),
    (error) =>
      error instanceof FrozenSendDraftError && error.code === "blocked",
  );
  const retry = await registry.reserve(slot, reply);
  assert.equal(retry.knownAccepted, true);

  assert.deepEqual(await registry.settle(retry, "definitive_failure"), {
    outcome: "local_repair",
    payload: reply,
  });
  const finalRetry = await registry.reserve(slot, reply);
  assert.equal(await registry.settle(finalRetry, "accepted"), null);
  assert.equal(await registry.restore(slot), null);
});

test("clears a fresh draft only after a definitive or accepted outcome", async () => {
  for (const outcome of ["definitive_failure", "accepted"]) {
    const storage = memoryStorage();
    const registry = createFrozenSendDraftRegistry(
      storage,
      serialCoordinator(),
      true,
    );
    const reservation = await registry.reserve("compose", payload);
    assert.equal(await registry.settle(reservation, outcome), null);
    assert.equal(await registry.restore("compose"), null);
  }
});

test("serializes competing reservations and never overwrites the first payload", async () => {
  const storage = memoryStorage();
  const coordinator = serialCoordinator();
  const first = createFrozenSendDraftRegistry(storage, coordinator, true);
  const second = createFrozenSendDraftRegistry(storage, coordinator, true);
  const results = await Promise.allSettled([
    first.reserve("compose", payload),
    second.reserve("compose", { ...payload, body: "Concurrent" }),
  ]);

  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
  const restored = await first.restore("compose");
  assert.equal(restored?.outcome, "outcome_unknown");
  assert.ok(
    restored?.payload.body === payload.body ||
      restored?.payload.body === "Concurrent",
  );
});

test("fails closed before dispatch when durable storage or coordination is absent", async () => {
  await assert.rejects(
    createFrozenSendDraftRegistry(null, serialCoordinator(), true).reserve(
      "compose",
      payload,
    ),
    (error) =>
      error instanceof FrozenSendDraftError && error.code === "unavailable",
  );
  await assert.rejects(
    createFrozenSendDraftRegistry(memoryStorage(), null, true).reserve(
      "compose",
      payload,
    ),
    (error) =>
      error instanceof FrozenSendDraftError && error.code === "unavailable",
  );
});

test("reserves and freezes the exact payload before dispatch, then clears only after settlement", async () => {
  const base = createFrozenSendDraftRegistry(
    memoryStorage(),
    serialCoordinator(),
    true,
  );
  const order = [];
  const registry = {
    restore: base.restore,
    async reserve(...args) {
      order.push("reserve");
      return base.reserve(...args);
    },
    async settle(...args) {
      order.push("settle");
      return base.settle(...args);
    },
  };

  const execution = await executeFrozenSend({
    slot: "compose",
    payload,
    registry,
    onReserved(draft) {
      order.push("freeze");
      assert.deepEqual(draft.payload, payload);
    },
    async send(sentPayload) {
      order.push("send");
      assert.deepEqual(sentPayload, payload);
      return { outcome: "accepted", message: "Courriel envoyé." };
    },
  });

  assert.deepEqual(order, ["reserve", "freeze", "send", "settle"]);
  assert.equal(execution.acceptedAndSettled, true);
  assert.equal(execution.draft, null);
  assert.equal(await registry.restore("compose"), null);
});

test("freezes an unknown dispatch outcome and leaves it blocked across reloads", async () => {
  const registry = createFrozenSendDraftRegistry(
    memoryStorage(),
    serialCoordinator(),
    true,
  );
  const execution = await executeFrozenSend({
    slot: "compose",
    payload,
    registry,
    onReserved() {},
    async send() {
      throw new Error("connection_lost");
    },
  });

  assert.equal(execution.acceptedAndSettled, false);
  assert.equal(execution.draft?.outcome, "outcome_unknown");
  assert.equal((await registry.restore("compose"))?.outcome, "outcome_unknown");
  await assert.rejects(
    registry.reserve("compose", payload),
    (error) => error instanceof FrozenSendDraftError && error.code === "blocked",
  );
});
