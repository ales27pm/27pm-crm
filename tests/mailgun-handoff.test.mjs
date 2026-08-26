import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  MAILGUN_HANDOFF_EXPIRES_AT,
  MAILGUN_HANDOFF_KEY_FINGERPRINT,
  validateMailgunHandoffPayload,
  verifyMailgunHandoffConsumerToken,
} from "../lib/mailgun-handoff.ts";

const beforeExpiry = Date.parse(MAILGUN_HANDOFF_EXPIRES_AT) - 1;
const ciphertext = Buffer.alloc(256, 27).toString("base64");

test("accepts only a correctly sized RSA ciphertext for the pinned public key", () => {
  assert.deepEqual(
    validateMailgunHandoffPayload(
      { ciphertext, keyFingerprint: MAILGUN_HANDOFF_KEY_FINGERPRINT },
      beforeExpiry,
    ),
    { ok: true, ciphertext },
  );

  assert.deepEqual(
    validateMailgunHandoffPayload(
      { ciphertext, keyFingerprint: "wrong" },
      beforeExpiry,
    ),
    { ok: false, reason: "fingerprint_invalid" },
  );

  assert.deepEqual(
    validateMailgunHandoffPayload(
      {
        ciphertext: Buffer.alloc(128, 27).toString("base64"),
        keyFingerprint: MAILGUN_HANDOFF_KEY_FINGERPRINT,
      },
      beforeExpiry,
    ),
    { ok: false, reason: "payload_invalid" },
  );
});

test("fails closed after the one-time handoff expires", () => {
  assert.deepEqual(
    validateMailgunHandoffPayload(
      { ciphertext, keyFingerprint: MAILGUN_HANDOFF_KEY_FINGERPRINT },
      Date.parse(MAILGUN_HANDOFF_EXPIRES_AT),
    ),
    { ok: false, reason: "expired" },
  );
});

test("accepts only the independently pinned one-time consumer token", async () => {
  const token = "test-consumer-token-with-more-than-32-characters";
  const expectedHash = createHash("sha256").update(token).digest("hex");
  assert.equal(
    await verifyMailgunHandoffConsumerToken(token, expectedHash),
    true,
  );
  assert.equal(
    await verifyMailgunHandoffConsumerToken(`${token}-wrong`, expectedHash),
    false,
  );
  assert.equal(await verifyMailgunHandoffConsumerToken(null, expectedHash), false);
});

test("handoff submission is operator-gated, encrypted, and purgeable", async () => {
  const [route, consumeRoute, form] = await Promise.all([
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../app/api/admin/mailgun-handoff/route.ts", import.meta.url), "utf8"),
    ),
    import("node:fs/promises").then(({ readFile }) =>
      readFile(
        new URL(
          "../app/api/admin/mailgun-handoff/consume/route.ts",
          import.meta.url,
        ),
        "utf8",
      ),
    ),
    import("node:fs/promises").then(({ readFile }) =>
      readFile(new URL("../app/components/mailgun-handoff-form.tsx", import.meta.url), "utf8"),
    ),
  ]);

  assert.match(route, /requireOperatorRequest\(request\)/u);
  assert.match(route, /isSameOriginBrowserRequest\(request\)/u);
  assert.match(consumeRoute, /verifyMailgunHandoffConsumerToken\(token\)/u);
  assert.match(
    consumeRoute,
    /SET ciphertext = '', consumed_at = CURRENT_TIMESTAMP/u,
  );
  assert.match(form, /crypto\.subtle\.encrypt/u);
  assert.match(form, /fetch\("\/api\/admin\/mailgun-handoff"/u);
  assert.ok(
    form.indexOf("await encryptForHandoff(normalized)") <
      form.indexOf("fetch(\"/api/admin/mailgun-handoff\""),
  );
});
