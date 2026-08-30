import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const privateRoutes = [
  "../app/api/accounts/import/route.ts",
  "../app/api/contacts/route.ts",
  "../app/api/contacts/[id]/route.ts",
  "../app/api/compliance/route.ts",
  "../app/api/intake/[id]/route.ts",
  "../app/api/interactions/route.ts",
  "../app/api/organizations/route.ts",
  "../app/api/organizations/[id]/route.ts",
  "../app/api/prospects/route.ts",
  "../app/api/privacy-requests/route.ts",
  "../app/api/privacy-requests/[id]/route.ts",
];

test("every new administrative CRM route fails closed through operator auth", async () => {
  for (const route of privateRoutes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /requireOperatorRequest\(request\)/u, route);
    assert.match(source, /if \(auth\.response\) return auth\.response/u, route);
  }
});

test("suppressed contact identities return a stable conflict instead of a server error", async () => {
  for (const route of ["../app/api/contacts/route.ts", "../app/api/contacts/[id]/route.ts"]) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /isSuppressedChannelError/u, route);
    assert.match(source, /jsonError\(409, "suppressed_contact_identity_locked"\)/u, route);
  }
});

test("public intake is isolated, bounded, origin-pinned, human-verified and send-free", async () => {
  const source = await readFile(new URL("../app/api/public/intake/route.ts", import.meta.url), "utf8");
  assert.match(source, /PUBLIC_SITE_ORIGIN/u);
  assert.match(source, /boundedRequest/u);
  assert.match(source, /TURNSTILE_SECRET_KEY/u);
  assert.match(source, /PUBLIC_INTAKE_TURNSTILE_ACTION/u);
  assert.match(source, /intake_submissions/u);
  assert.match(source, /intake_rate_limits/u);
  assert.match(source, /ON CONFLICT\(bucket_key\)/u);
  assert.ok(source.indexOf("verifyTurnstile") < source.indexOf("INSERT INTO intake_rate_limits"));
  assert.doesNotMatch(source, /sendMailgunMessage|messages\/send|MAILGUN_SENDING_KEY/u);
});

test("public Mailgun webhooks reject oversized bodies before parsing", async () => {
  for (const route of ["../app/api/webhooks/mailgun/events/route.ts", "../app/api/webhooks/mailgun/inbound/route.ts"]) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /boundedRequest/u, route);
    assert.ok(source.lastIndexOf("markWebhookProcessed") > source.lastIndexOf(route.includes("events") ? "recordMailgunEvent" : "storeInboundAttachments"), route);
  }
  const inbound = await readFile(new URL("../app/api/webhooks/mailgun/inbound/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(inbound, /recorded\.created && inbound\.attachments/u);
  const storage = await readFile(new URL("../lib/mailgun-event-store.ts", import.meta.url), "utf8");
  assert.match(storage, /reconcileMailgunEventsForMessage/u);
  assert.doesNotMatch(storage, /reconcileMailgunEventsBestEffort/u);
  const inboundStorage = await readFile(new URL("../lib/webhook-store.ts", import.meta.url), "utf8");
  assert.match(inboundStorage, /contacts\.validated_at IS NULL/u);
  assert.match(inboundStorage, /ELSE contacts\.display_name/u);
});

test("outbound email and contact tasks enforce qualification guards", async () => {
  const send = await readFile(new URL("../app/api/messages/send/route.ts", import.meta.url), "utf8");
  const tasks = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  assert.match(send, /canEmail\(contact, configuration\)/u);
  assert.match(send, /advanceSendAuthorization/u);
  assert.match(send, /complianceEvidenceSnapshot/u);
  assert.match(send, /const suppressionCategory = "prospecting"/u);
  assert.match(send, /mailbox\.purpose !== "sales"/u);
  assert.match(send, /cancelSendCommand/u);
  assert.match(send, /operator_compliance_confirmation_required/u);
  assert.match(send, /appendComplianceFooter/u);
  assert.match(send, /recipient_not_qualified/u);
  assert.match(send, /to\.length !== 1/u);
  assert.match(tasks, /canEmail\(contact, configuration\)|canCall\(contact, configuration\)/u);
  assert.match(tasks, /contact_action_blocked/u);
  assert.match(tasks, /complianceEvidenceSnapshot/u);
  assert.match(tasks, /contact_required_for_action/u);
  const taskUpdate = await readFile(new URL("../app/api/tasks/[id]/route.ts", import.meta.url), "utf8");
  assert.match(taskUpdate, /cancelled_contact_task_locked/u);
  assert.match(taskUpdate, /Boolean\(current\.contactAction\) && current\.status !== "open"/u);
  assert.match(taskUpdate, /canCall\(contact, configuration\) : canEmail\(contact, configuration\)/u);
  assert.match(taskUpdate, /compliance_state_changed/u);
});

test("public unsubscribe is opaque, authenticated, bounded, idempotent and transport-free", async () => {
  const source = await readFile(new URL("../app/api/public/unsubscribe/route.ts", import.meta.url), "utf8");
  const implementation = await readFile(new URL("../lib/unsubscribe.ts", import.meta.url), "utf8");
  assert.match(source, /verifyUnsubscribeToken/u);
  assert.match(source, /boundedRequest/u);
  assert.match(source, /applyEmailUnsubscribe/u);
  assert.match(implementation, /AES-GCM/u);
  assert.match(implementation, /validUnsubscribeSecret/u);
  assert.match(implementation, /status IN \('pending','authorized'\)/u);
  assert.doesNotMatch(source, /sendMailgunMessage|MAILGUN_SENDING_KEY/u);
});

test("the dashboard exposes an explicit fallback when its initial API load fails", async () => {
  const source = await readFile(new URL("../app/components/crm-app.tsx", import.meta.url), "utf8");
  assert.match(source, /if \(!response\.ok\) throw new Error/u);
  assert.match(source, /Serveur indisponible — aperçu local conservé/u);
});

test("account imports bind idempotency keys to content and gate concurrent writes", async () => {
  const source = await readFile(new URL("../app/api/accounts/import/route.ts", import.meta.url), "utf8");
  assert.match(source, /request_hash AS requestHash/u);
  assert.match(source, /account_import_key_reused/u);
  assert.match(source, /account_import_key_unverifiable/u);
  assert.match(source, /WHERE EXISTS \(SELECT 1 FROM account_imports WHERE id=\? AND request_hash=\?\)/u);
  assert.match(source, /SELECT name FROM organizations/u);
});
