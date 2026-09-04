import assert from "node:assert/strict";
import test from "node:test";

import { dispatchMailgunRequest } from "../lib/mailgun-request.ts";

const message = {
  fromAddress: "alexis@27pm.org",
  fromName: "Alexis Boulet — 27PM",
  to: ["client@example.com"],
  subject: "Bonjour",
  text: "Une observation.",
  replyTo: "alexis@27pm.org",
  unsubscribeUrl:
    "https://crm.27pm.org/api/public/unsubscribe?token=abcdefghijklmnopqrstuvwxyz012345",
};

test("starts the provider boundary only after local message validation", async () => {
  const order = [];
  const fetcher = async () => {
    order.push("fetch");
    return new Response('{"id":"<queued@27pm.org>"}', { status: 200 });
  };

  await assert.rejects(
    dispatchMailgunRequest(
      { ...message, unsubscribeUrl: "https://user:secret@crm.27pm.org/unsubscribe" },
      {
        url: "https://api.mailgun.net/v3/27pm.org/messages",
        authorization: "Basic test-only",
      },
      {
        fetcher,
        onDispatchStart: () => order.push("start"),
      },
    ),
    /unsubscribe URL is invalid/u,
  );
  assert.deepEqual(order, []);

  const response = await dispatchMailgunRequest(
    message,
    {
      url: "https://api.mailgun.net/v3/27pm.org/messages",
      authorization: "Basic test-only",
    },
    {
      fetcher,
      onDispatchStart: () => order.push("start"),
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(order, ["start", "fetch"]);
});
