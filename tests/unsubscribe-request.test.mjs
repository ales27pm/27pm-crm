import assert from "node:assert/strict";
import test from "node:test";

import { parseUnsubscribeRequest } from "../lib/unsubscribe-request.ts";

const token = "a".repeat(64);

test("accepts only the exact RFC 8058 one-click POST and uses the URL token", async () => {
  const request = new Request(
    `https://crm.27pm.org/api/public/unsubscribe?token=${token}`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    },
  );

  assert.deepEqual(await parseUnsubscribeRequest(request), {
    token,
    scope: "global",
    category: "all",
    oneClick: true,
  });
});

test("rejects malformed one-click requests instead of guessing intent", async () => {
  const cases = [
    new Request("https://crm.27pm.org/api/public/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "List-Unsubscribe=One-Click",
    }),
    new Request(
      `https://crm.27pm.org/api/public/unsubscribe?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "List-Unsubscribe=One-Click&scope=global",
      },
    ),
    new Request(
      `https://crm.27pm.org/api/public/unsubscribe?token=${token}`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "List-Unsubscribe=One-Click",
      },
    ),
  ];

  for (const request of cases) {
    assert.equal(await parseUnsubscribeRequest(request), null);
  }
});

test("preserves the explicit browser confirmation form contract", async () => {
  const request = new Request(
    "https://crm.27pm.org/api/public/unsubscribe",
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token,
        scope: "category",
        category: "prospecting",
      }),
    },
  );

  assert.deepEqual(await parseUnsubscribeRequest(request), {
    token,
    scope: "category",
    category: "prospecting",
    oneClick: false,
  });
});
