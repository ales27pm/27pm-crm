import assert from "node:assert/strict";
import test from "node:test";

import {
  sendContentFromPayload,
  sendMailboxFromPayload,
} from "../lib/send-payload.ts";

test("normalizes the shared send payload without changing route semantics", () => {
  assert.deepEqual(
    sendContentFromPayload({
      subject: " Hello\r\nworld ",
      body: " fallback body ",
      html: " <p>Hello</p> ",
      conversationId: "conversation-1",
    }),
    {
      subject: "Hello world",
      text: "fallback body",
      html: "<p>Hello</p>",
      conversationId: "conversation-1",
    },
  );
  assert.deepEqual(sendContentFromPayload({ subject: 7 }), {
    subject: "",
    text: null,
    html: null,
    conversationId: null,
  });
});

test("resolves a mailbox by id or normalized sender address", () => {
  assert.equal(
    sendMailboxFromPayload({ mailbox: " mailbox_alexis " }).mailbox?.address,
    "alexis@27pm.org",
  );
  assert.equal(
    sendMailboxFromPayload({ from: " Alexis <alexis@27pm.org> " }).mailbox?.id,
    "mailbox_alexis",
  );
  assert.equal(sendMailboxFromPayload({ mailbox: "unknown" }).mailbox, null);
});
