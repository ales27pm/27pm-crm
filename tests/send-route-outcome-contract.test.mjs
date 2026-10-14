import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeUrl = new URL("../app/api/messages/send/route.ts", import.meta.url);

test("persists provider acceptance before secondary CRM records", async () => {
  const source = await readFile(routeUrl, "utf8");
  const providerCall = source.indexOf("await sendOutboundMessage(");
  const acceptedMarker = source.indexOf("providerAccepted = true", providerCall);
  const durableAcceptance = source.indexOf("status = 'sent'", acceptedMarker);
  const conversationWrite = source.indexOf(
    "await recordAcceptedOutboundMessage",
    acceptedMarker,
  );

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
  assert.match(source, /classifyOutboundFailure\(providerDispatchStarted, cause\)/u);
  assert.match(source, /failure_code = 'transport_outcome_unknown'/u);
  assert.match(source, /return jsonError\(503, "outbound_send_unconfirmed"\)/u);
  assert.match(source, /failure_code = 'transport_failure'/u);
});

test("reports CRM recording from the outbound message row rather than a conversation", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(
    source,
    /EXISTS\s*\([\s\S]*FROM messages[\s\S]*provider_message_id[\s\S]*AS crmRecorded/u,
  );
  assert.match(source, /let crmRecorded = Boolean\(existing\.crmRecorded\)/u);
  assert.doesNotMatch(source, /crmRecorded: Boolean\(existing\.conversationId\)/u);
});

test("repairs a sent command locally before returning an idempotent retry", async () => {
  const source = await readFile(routeUrl, "utf8");
  const existingLookup = source.indexOf("await loadSendCommand(db, idempotencyKey)");
  const transportConfig = source.indexOf(
    "requireOutboundMessageOperationalConfig()",
  );
  const complianceLookup = source.indexOf("loadContactCompliance(");
  const sentBranch = source.indexOf('existing.status === "sent"');
  const repair = source.indexOf("await recordAcceptedOutboundMessage", sentBranch);
  const idempotentResponse = source.indexOf("idempotent: true", sentBranch);
  const providerDispatch = source.indexOf("await sendOutboundMessage(");

  assert.ok(existingLookup >= 0);
  assert.ok(transportConfig > existingLookup);
  assert.ok(complianceLookup > transportConfig);
  assert.ok(sentBranch >= 0);
  assert.ok(repair > sentBranch);
  assert.ok(idempotentResponse > repair);
  assert.ok(providerDispatch > 0);
  assert.match(source, /parseOutboundMessageSnapshot\(existing\.messageSnapshotJson\)/u);
  assert.match(source, /contact_id AS contactId/u);
  assert.match(source, /contactId: snapshot\.contactId/u);
  assert.match(source, /snapshot\.contactId === existing\.contactId/u);
  assert.doesNotMatch(
    source.slice(sentBranch, idempotentResponse),
    /compliantOutboundContent/u,
  );
});

test("persists a Cakemail RFC Message-ID before the non-idempotent provider request", async () => {
  const source = await readFile(routeUrl, "utf8");
  const createExternalId = source.indexOf("createOutboundExternalMessageId(");
  const persistSnapshot = source.indexOf(
    "message_snapshot_json = ?",
    createExternalId,
  );
  const providerCall = source.indexOf("await sendOutboundMessage(", persistSnapshot);

  assert.ok(createExternalId >= 0);
  assert.ok(persistSnapshot > createExternalId);
  assert.ok(providerCall > persistSnapshot);
  assert.match(source, /provider_message_id AS providerMessageId/u);
  assert.match(source, /external_message_id AS externalMessageId/u);
  assert.match(source, /provider: transportProvider/u);
});

test("snapshots the exact compliant message and original actor before dispatch", async () => {
  const source = await readFile(routeUrl, "utf8");
  const snapshot = source.indexOf("const messageSnapshot: OutboundMessageSnapshot = {");
  const persistSnapshot = source.indexOf("message_snapshot_json = ?", snapshot);
  const providerCall = source.indexOf("await sendOutboundMessage(", persistSnapshot);

  assert.ok(snapshot >= 0);
  assert.ok(persistSnapshot > snapshot);
  assert.ok(providerCall > persistSnapshot);
  assert.match(
    source.slice(snapshot, persistSnapshot),
    /contentMode: transmittedContent\.contentMode,[\s\S]*text: transmittedContent\.text,[\s\S]*html: transmittedContent\.html,[\s\S]*actorEmail: auth\.operator\.email/u,
  );
  assert.match(
    source,
    /text: snapshot\.text,[\s\S]*html: snapshot\.html,[\s\S]*actorEmail: snapshot\.actorEmail/u,
  );
});

test("binds idempotency to stable transport fields rather than mailbox presentation", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(
    source,
    /requestFingerprint\(\{[\s\S]*mailboxId: command\.mailbox\.id,[\s\S]*to: command\.to,[\s\S]*conversationId: command\.conversationId,[\s\S]*\}\)/u,
  );
  assert.doesNotMatch(source, /requestFingerprint\(command\)/u);
});

test("requires the shared outbound and inbound operational boundary", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /requireOutboundMessageOperationalConfig\(\)/u);
  assert.doesNotMatch(source, /requireOutboundOperationalConfig\(\)/u);
  assert.doesNotMatch(source, /requireMailgunOperationalConfig/u);
  assert.match(source, /transport\.provider !== "mailgun"[\s\S]*transport\.provider !== "exchange"/u);
  assert.doesNotMatch(source, /transport = outboundTransportConfig\(\)/u);
});

test("keeps the dedicated Exchange canary outside the ordinary-message gate", async () => {
  const source = await readFile(
    new URL("../app/api/admin/exchange-canary/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(source, /requireOutboundOperationalConfig\(\)/u);
  assert.doesNotMatch(source, /requireOutboundMessageOperationalConfig\(\)/u);
});

test("reports the ordinary-message gate to CRM send controls without changing the canary route", async () => {
  const runtime = await readFile(
    new URL("../lib/outbound-runtime.ts", import.meta.url),
    "utf8",
  );
  const capabilities = await readFile(
    new URL("../lib/exchange-runtime.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    runtime,
    /export function outboundTransportOperational\(\)[\s\S]*requireOutboundMessageOperationalConfig\(\)/u,
  );
  assert.match(
    capabilities,
    /mailFlowEnabled:[\s\S]*CRM_EXCHANGE_MAIL_ENABLED[\s\S]*CRM_EXCHANGE_MESSAGE_SEND_ENABLED[\s\S]*CRM_OUTBOUND_PROVIDER/u,
  );
});

test("formats a mirrored RFC Message-ID for Graph without changing approval evidence", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /LEFT JOIN exchange_message_links exchange_link/u);
  assert.match(source, /exchange_link\.logical_mailbox_id = c\.mailbox_id/u);
  assert.match(source, /exchange_link\.classification = 'mapped'/u);
  assert.match(source, /trim\(exchange_link\.internet_message_id, '<> '\)/u);
  assert.match(
    source,
    /transport\.provider === "exchange"[\s\S]*`<\$\{conversation\.externalMessageId\}>`/u,
  );
  assert.match(source, /inReplyTo: outboundMessage\.inReplyTo/u);
  assert.match(source, /references: outboundMessage\.references/u);
});

test("persists the provider's actual acceptance status", async () => {
  const source = await readFile(routeUrl, "utf8");

  assert.match(source, /providerResponseStatus = result\.responseStatus/u);
  assert.match(source, /response_status = \?/u);
  assert.doesNotMatch(source, /response_status = 200/u);
});

test("enforces the Cakemail audience guard immediately before dispatch", async () => {
  const source = await readFile(routeUrl, "utf8");
  const dispatching = source.indexOf("const dispatching = operationalReply");
  const dispatchAuthorization = source.indexOf(
    "await advanceSendAuthorization(",
    dispatching,
  );
  const audienceGuard = source.indexOf(
    "cakemailAudiencePolicyViolation(",
    dispatchAuthorization,
  );
  const providerCall = source.indexOf("await sendOutboundMessage(", audienceGuard);

  assert.ok(dispatching >= 0);
  assert.ok(dispatchAuthorization >= 0);
  assert.ok(audienceGuard > dispatchAuthorization);
  assert.ok(providerCall > audienceGuard);
  assert.match(
    source.slice(audienceGuard, providerCall),
    /cancelSendCommand[\s\S]*jsonError\(409, audienceViolation\)/u,
  );
});
