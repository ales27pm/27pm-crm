import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isConversationId } from "../lib/conversation-id.ts";

test("accepts only existing and deterministic accepted conversation formats", () => {
  for (const id of ["conversation-cohort-test", "01234567-abcd-4321-9876-0123456789ab", "a".repeat(128), `accepted-conversation:${"0123456789abcdef".repeat(4)}`]) {
    assert.equal(isConversationId(id), true, id);
  }
  for (const id of [null, undefined, {}, 123, "", "a".repeat(129), "../test", "a%3Ab", "a/b", "a?b", "a\nb", "a\n", `accepted-message:${"a".repeat(64)}`, `accepted-conversation:${"a".repeat(63)}`, `accepted-conversation:${"g".repeat(64)}`, `accepted-conversation:${"a".repeat(65)}`]) {
    assert.equal(isConversationId(id), false);
  }
});

test("conversation consumers share validation without broadening other entity IDs", async () => {
  for (const path of ["app/api/conversations/[id]/route.ts", "app/api/attachments/route.ts", "app/api/messages/send/route.ts", "app/api/tasks/route.ts", "lib/outbound-message-snapshot.ts", "scripts/build-operational-reply-approval.mjs"]) {
    const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
    assert.match(source, /import \{ isConversationId \} from/u, path);
    assert.match(source, /isConversationId\((?:id|conversationId|value|value\.conversationId|payload\.conversationId)\)/u, path);
  }
});
