import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../app/api/messages/send/route.ts", import.meta.url);

test("persists provider acceptance before secondary CRM records", async () => {
  const source = await readFile(routeUrl, "utf8");
  const providerCall = source.indexOf("await sendMailgunMessage(");
  const acceptedMarker = source.indexOf("providerAccepted = true", providerCall);
  const durableAcceptance = source.indexOf("status = 'sent'", acceptedMarker);
  const conversationWrite = source.indexOf("await createOutboundConversation", acceptedMarker);

  assert.ok(providerCall >= 0);
  assert.ok(acceptedMarker > providerCall);
  assert.ok(durableAcceptance > acceptedMarker);
  assert.ok(conversationWrite > durableAcceptance);
});

test("separates post-acceptance and unknown outcomes from definitive transport failure", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /if \(providerAccepted\) \{/u);
  assert.match(source, /failure_code = 'post_acceptance_persistence_failure'/u);
  assert.match(source, /accepted: true,[\s\S]*crmRecorded: false/u);
  assert.match(source, /classifyMailgunFailure\(providerDispatchStarted, cause\)/u);
  assert.match(source, /failure_code = 'transport_outcome_unknown'/u);
  assert.match(source, /return jsonError\(503, "mailgun_send_unconfirmed"\)/u);
  assert.match(source, /failure_code = 'transport_failure'/u);
});

test("reports CRM recording from the outbound message row rather than a conversation", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(
    source,
    /EXISTS\s*\([\s\S]*FROM messages[\s\S]*external_message_id[\s\S]*AS crmRecorded/u,
  );
  assert.match(source, /crmRecorded: Boolean\(existing\.crmRecorded\)/u);
  assert.doesNotMatch(source, /crmRecorded: Boolean\(existing\.conversationId\)/u);
});

test("binds idempotency to stable transport fields rather than mailbox presentation", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(
    source,
    /requestFingerprint\(\{[\s\S]*mailboxId: command\.mailbox\.id,[\s\S]*to: command\.to,[\s\S]*conversationId: command\.conversationId,[\s\S]*\}\)/u,
  );
  assert.doesNotMatch(source, /requestFingerprint\(command\)/u);
});
