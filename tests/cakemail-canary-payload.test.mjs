import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CakemailCanaryError,
  canaryPayloadFromEnvironment,
  previewCanaryFromEnvironment,
  recordCanaryAttemptResult,
  reserveCanaryAttempt,
  sendCanaryFromEnvironment,
} from "../scripts/build-cakemail-canary-payload.mjs";

const recipient = "controlled@example.com";
const validEnvironment = {
  CAKEMAIL_CANARY_FROM: "alexis@27pm.org",
  CAKEMAIL_CANARY_RECIPIENT: recipient,
  CAKEMAIL_LIST_ID: "42",
  CAKEMAIL_CONTENT_MODE: "html",
  CAKEMAIL_CANARY_SENDER_ID: "sender-alexis",
  CAKEMAIL_CANARY_PARENT_MESSAGE_ID: "controlled-parent@27pm.org",
  CAKEMAIL_CANARY_UNSUBSCRIBE_URL:
    "https://crm.27pm.org/api/public/unsubscribe?token=controlled-canary",
};
const frozenExternalMessageId =
  "cakemail.550e8400-e29b-41d4-a716-446655440000@27pm.org";
const frozenEnvironment = {
  ...validEnvironment,
  CAKEMAIL_CANARY_EXTERNAL_MESSAGE_ID: frozenExternalMessageId,
};
const reviewedCanary = previewCanaryFromEnvironment(frozenEnvironment);
const approvedEnvironment = {
  ...frozenEnvironment,
  CAKEMAIL_CANARY_PAYLOAD_SHA256: reviewedCanary.payloadSha256,
  CAKEMAIL_CANARY_APPROVAL: reviewedCanary.approval,
};

test("builds one reviewed canary with the production Cakemail payload builder", () => {
  const payload = canaryPayloadFromEnvironment(
    validEnvironment,
    () => "550e8400-e29b-41d4-a716-446655440000",
  );

  assert.equal(payload.email, recipient);
  assert.equal(payload.sender.id, "sender-alexis");
  assert.equal(payload.content.type, "marketing");
  assert.match(payload.content.html, /Canari technique unique/u);
  assert.equal("text" in payload.content, false);
  assert.deepEqual(payload.tags, ["source-crm", "traffic-canary"]);
  assert.deepEqual(
    payload.additional_headers.find(({ name }) => name === "Message-ID"),
    {
      name: "Message-ID",
      value:
        "<cakemail.550e8400-e29b-41d4-a716-446655440000@27pm.org>",
    },
  );
  assert.deepEqual(
    payload.additional_headers.find(({ name }) => name === "In-Reply-To"),
    { name: "In-Reply-To", value: "<controlled-parent@27pm.org>" },
  );
  assert.deepEqual(
    payload.additional_headers.find(({ name }) => name === "References"),
    { name: "References", value: "<controlled-parent@27pm.org>" },
  );
});

test("previews an exact payload digest and requires a 27PM sender", () => {
  assert.equal(reviewedCanary.action, "review-only");
  assert.equal(reviewedCanary.externalMessageId, frozenExternalMessageId);
  assert.match(reviewedCanary.payloadSha256, /^[0-9a-f]{64}$/u);
  assert.equal(
    reviewedCanary.approval,
    `send-one-canary-to:${recipient}:sha256:${reviewedCanary.payloadSha256}`,
  );
  assert.throws(
    () =>
      canaryPayloadFromEnvironment({
        ...validEnvironment,
        CAKEMAIL_CANARY_FROM: "attacker@example.com",
      }),
    CakemailCanaryError,
  );
  assert.throws(
    () =>
      canaryPayloadFromEnvironment({
        ...validEnvironment,
        CAKEMAIL_CANARY_FROM_NAME: "27PM — Canari",
      }),
    /must match the production mailbox identity/u,
  );
  assert.equal(
    canaryPayloadFromEnvironment({
      ...validEnvironment,
      CAKEMAIL_CANARY_FROM_NAME: "Alexis Boulet — 27PM",
    }).sender.name,
    "Alexis Boulet — 27PM",
  );
});

test("requires a canonical parent Message-ID for threading evidence", () => {
  assert.throws(
    () =>
      canaryPayloadFromEnvironment({
        ...validEnvironment,
        CAKEMAIL_CANARY_PARENT_MESSAGE_ID: "<Parent@27pm.org>",
      }),
    CakemailCanaryError,
  );
});

test("sends exactly one approved canary to the pinned endpoint without retry", async () => {
  let calls = 0;
  const reservations = [];
  const terminalResults = [];
  const providerMessageId = "3FBFA67E-C4C4-4E03-8DFD-556037960374";
  const environment = {
    ...approvedEnvironment,
    CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
    CAKEMAIL_ACCOUNT_ID: "27",
  };
  const result = await sendCanaryFromEnvironment(
    environment,
    async (url, init) => {
      calls += 1;
      assert.equal(
        url.toString(),
        "https://api.cakemail.dev/v2/emails?account_id=27",
      );
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      assert.equal(JSON.parse(init.body).email, recipient);
      return Response.json(
        {
          email: recipient,
          submitted: true,
          data: { id: providerMessageId, status: "queued" },
        },
        { status: 201 },
      );
    },
    undefined,
    async (digest) => reservations.push(digest),
    async (digest, evidence) => terminalResults.push({ digest, evidence }),
  );

  assert.equal(calls, 1);
  assert.deepEqual(reservations, [reviewedCanary.payloadSha256]);
  assert.deepEqual(terminalResults, [
    {
      digest: reviewedCanary.payloadSha256,
      evidence: {
        status: "accepted",
        accountId: 27,
        recipient,
        externalMessageId: frozenExternalMessageId,
        providerMessageId: providerMessageId.toLowerCase(),
        responseStatus: 201,
      },
    },
  ]);
  assert.deepEqual(result, {
    accepted: true,
    providerMessageId: providerMessageId.toLowerCase(),
    externalMessageId:
      "cakemail.550e8400-e29b-41d4-a716-446655440000@27pm.org",
  });
});

test("refuses a changed or unfrozen payload before the provider boundary", async () => {
  let calls = 0;
  let reservations = 0;
  for (const environment of [
    {
      ...approvedEnvironment,
      CAKEMAIL_CANARY_APPROVAL: "yes",
      CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
      CAKEMAIL_ACCOUNT_ID: "27",
    },
    {
      ...approvedEnvironment,
      CAKEMAIL_CANARY_EXTERNAL_MESSAGE_ID: undefined,
      CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
      CAKEMAIL_ACCOUNT_ID: "27",
    },
  ]) {
    await assert.rejects(
      sendCanaryFromEnvironment(environment, async () => {
        calls += 1;
        throw new Error("unexpected provider request");
      }, undefined, async () => {
        reservations += 1;
      }),
      CakemailCanaryError,
    );
  }
  assert.equal(calls, 0);
  assert.equal(reservations, 0);
});

test("rejects a malformed submitted flag as an unknown canary outcome", async () => {
  const environment = {
    ...approvedEnvironment,
    CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
    CAKEMAIL_ACCOUNT_ID: "27",
  };

  await assert.rejects(
    sendCanaryFromEnvironment(environment, async () =>
      Response.json(
        {
          email: recipient,
          submitted: "yes",
          data: {
            id: "3fbfa67e-c4c4-4e03-8dfd-556037960374",
            status: "queued",
          },
        },
        { status: 201 },
      ),
    undefined,
    async () => {},
    async () => {},
    ),
    /outcome is unknown; do not retry automatically/u,
  );
});

test("treats transport errors, ambiguous status codes, and malformed roots as unknown", async () => {
  const environment = {
    ...approvedEnvironment,
    CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
    CAKEMAIL_ACCOUNT_ID: "27",
  };
  const cases = [
    async () => {
      throw new Error("network reset");
    },
    async () => new Response("temporary", { status: 503 }),
    async () => new Response("rate limited", { status: 429 }),
    async () => Response.json(null, { status: 201 }),
    async () => Response.json([], { status: 201 }),
  ];

  for (const fetcher of cases) {
    await assert.rejects(
      sendCanaryFromEnvironment(
        environment,
        fetcher,
        undefined,
        async () => {},
        async () => {},
      ),
      /outcome is unknown; do not retry automatically/u,
    );
  }
});

test("reports a definitive provider rejection without reclassifying it as unknown", async () => {
  const environment = {
    ...approvedEnvironment,
    CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
    CAKEMAIL_ACCOUNT_ID: "27",
  };

  await assert.rejects(
    sendCanaryFromEnvironment(
      environment,
      async () => new Response("invalid", { status: 422 }),
      undefined,
      async () => {},
      async () => {},
    ),
    /rejected with HTTP 422/u,
  );
});

test("treats explicit 201 rejected and error states as definitive", async () => {
  const environment = {
    ...approvedEnvironment,
    CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
    CAKEMAIL_ACCOUNT_ID: "27",
  };

  for (const status of ["rejected", "error"]) {
    const terminalResults = [];
    await assert.rejects(
      sendCanaryFromEnvironment(
        environment,
        async () =>
          Response.json(
            {
              email: recipient,
              submitted: false,
              data: {
                id: "3fbfa67e-c4c4-4e03-8dfd-556037960374",
                status,
              },
            },
            { status: 201 },
          ),
        undefined,
        async () => {},
        async (digest, evidence) => terminalResults.push({ digest, evidence }),
      ),
      new RegExp(`definitive ${status} outcome`, "u"),
    );
    assert.equal(terminalResults.length, 1);
    assert.equal(terminalResults[0].evidence.status, "rejected");
    assert.equal(terminalResults[0].evidence.responseStatus, 201);
  }
});

test("classifies a provider body stream error as unknown and records it", async () => {
  const environment = {
    ...approvedEnvironment,
    CAKEMAIL_PAT: `ck_pat_${"a".repeat(40)}`,
    CAKEMAIL_ACCOUNT_ID: "27",
  };
  const terminalResults = [];
  const body = new ReadableStream({
    pull(controller) {
      controller.error(new Error("truncated provider stream"));
    },
  });

  await assert.rejects(
    sendCanaryFromEnvironment(
      environment,
      async () => new Response(body, { status: 201 }),
      undefined,
      async () => {},
      async (digest, evidence) => terminalResults.push({ digest, evidence }),
    ),
    /outcome is unknown; do not retry automatically/u,
  );
  assert.equal(terminalResults.length, 1);
  assert.equal(terminalResults[0].evidence.status, "outcome_unknown");
  assert.equal(terminalResults[0].evidence.responseStatus, 201);
});

test("reserves each exact canary digest durably and atomically before dispatch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "27pm-cakemail-canary-"));
  const digest = "d".repeat(64);
  try {
    await reserveCanaryAttempt(digest, directory);
    const receiptPath = join(directory, `${digest}.json`);
    const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    const receiptStat = await stat(receiptPath);
    const directoryStat = await stat(directory);

    assert.equal(receipt.version, 1);
    assert.equal(receipt.payloadSha256, digest);
    assert.equal(receipt.status, "dispatching");
    assert.equal(receiptStat.mode & 0o777, 0o600);
    assert.equal(directoryStat.mode & 0o777, 0o700);
    await assert.rejects(
      reserveCanaryAttempt(digest, directory),
      /already attempted; do not send it again/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishes one immutable terminal canary result with correlation evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "27pm-cakemail-result-"));
  const digest = "e".repeat(64);
  const evidence = {
    status: "accepted",
    accountId: 27,
    recipient,
    externalMessageId: frozenExternalMessageId,
    providerMessageId: "3fbfa67e-c4c4-4e03-8dfd-556037960374",
    responseStatus: 201,
  };
  try {
    await recordCanaryAttemptResult(digest, evidence, directory);
    const resultPath = join(directory, `${digest}.result.json`);
    const result = JSON.parse(await readFile(resultPath, "utf8"));
    const resultStat = await stat(resultPath);

    assert.equal(result.version, 1);
    assert.equal(result.payloadSha256, digest);
    assert.match(result.recordedAt, /^\d{4}-\d{2}-\d{2}T/u);
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(evidence).map((key) => [key, result[key]]),
      ),
      evidence,
    );
    assert.equal(resultStat.mode & 0o777, 0o600);
    await assert.rejects(
      recordCanaryAttemptResult(
        digest,
        { ...evidence, status: "outcome_unknown" },
        directory,
      ),
      /terminal result could not be persisted; do not retry/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
