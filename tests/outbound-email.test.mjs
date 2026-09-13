import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(
  `data:text/javascript,${encodeURIComponent(`
    export async function resolve(specifier, context, nextResolve) {
      if (specifier === "server-only") {
        return { shortCircuit: true, url: "data:text/javascript,export {};" };
      }
      return nextResolve(specifier, context);
    }
  `)}`,
  import.meta.url,
);

const {
  createOutboundExternalMessageId,
  outboundTransmittedContent,
  sendOutboundMessage,
} = await import("../lib/outbound-email.ts");

const message = {
  fromAddress: "alexis@27pm.org",
  fromName: "Alexis Boulet — 27PM",
  to: ["client@example.com"],
  subject: "Bonjour",
  text: "Une observation.",
  html: "<p>Une observation.</p>",
  replyTo: "alexis@27pm.org",
  unsubscribeUrl:
    "https://crm.27pm.org/api/public/unsubscribe?token=opaque-token",
  tags: ["source-crm", "traffic-prospecting"],
};

test("keeps the existing Mailgun response identifier as both correlation IDs", async () => {
  const transport = {
    provider: "mailgun",
    config: {
      apiBase: "https://api.mailgun.net",
      domain: "27pm.org",
      sendingKey: "domain-key",
    },
  };
  assert.equal(
    createOutboundExternalMessageId(transport, message.fromAddress),
    null,
  );
  assert.deepEqual(outboundTransmittedContent(message, transport), {
    contentMode: "multipart",
    text: message.text,
    html: message.html,
  });

  const result = await sendOutboundMessage(message, transport, {
    fetcher: async () =>
      Response.json({ id: "<mailgun-id@27pm.org>", message: "Queued" }),
  });
  assert.deepEqual(result, {
    provider: "mailgun",
    providerMessageId: "mailgun-id@27pm.org",
    externalMessageId: "mailgun-id@27pm.org",
    message: "Queued",
    responseStatus: 200,
  });
});

test("keeps Cakemail's provider UUID separate from the branded RFC Message-ID", async () => {
  const providerMessageId = "3fbfa67e-c4c4-4e03-8dfd-556037960374";
  const transport = {
    provider: "cakemail",
    config: {
      apiBase: "https://api.cakemail.dev",
      pat: `ck_pat_${"a".repeat(40)}`,
      accountId: 27,
      listId: 42,
      contentMode: "html",
      senderIds: { "alexis@27pm.org": "sender_27pm_alexis" },
    },
  };
  const externalMessageId = createOutboundExternalMessageId(
    transport,
    message.fromAddress,
  );
  assert.match(
    externalMessageId,
    /^cakemail\.[0-9a-f-]{36}@27pm\.org$/u,
  );
  assert.deepEqual(outboundTransmittedContent(message, transport), {
    contentMode: "html",
    text: null,
    html: message.html,
  });

  const result = await sendOutboundMessage(message, transport, {
    externalMessageId,
    fetcher: async () =>
      Response.json(
        {
          email: "client@example.com",
          submitted: true,
          data: { id: providerMessageId, status: "queued" },
        },
        { status: 201 },
      ),
  });
  assert.deepEqual(result, {
    provider: "cakemail",
    providerMessageId,
    externalMessageId,
    message: "Queued",
    responseStatus: 201,
  });
});

test("refuses to cross the Cakemail boundary without a pre-persisted RFC ID", async () => {
  let dispatched = false;
  await assert.rejects(
    sendOutboundMessage(
      message,
      {
        provider: "cakemail",
        config: {
          apiBase: "https://api.cakemail.dev",
          pat: `ck_pat_${"a".repeat(40)}`,
          accountId: 27,
          listId: 42,
          contentMode: "html",
          senderIds: { "alexis@27pm.org": "sender_27pm_alexis" },
        },
      },
      {
        fetcher: async () => {
          dispatched = true;
          throw new Error("must not dispatch");
        },
      },
    ),
    /external Message-ID is unavailable/u,
  );
  assert.equal(dispatched, false);
});
