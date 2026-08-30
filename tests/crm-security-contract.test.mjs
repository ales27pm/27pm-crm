import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const privateRoutes = [
  "../app/api/accounts/import/route.ts",
  "../app/api/contacts/route.ts",
  "../app/api/contacts/[id]/route.ts",
  "../app/api/intake/[id]/route.ts",
  "../app/api/interactions/route.ts",
  "../app/api/organizations/route.ts",
  "../app/api/organizations/[id]/route.ts",
  "../app/api/prospects/route.ts",
];

test("every new administrative CRM route fails closed through operator auth", async () => {
  for (const route of privateRoutes) {
    const source = await readFile(new URL(route, import.meta.url), "utf8");
    assert.match(source, /requireOperatorRequest\(request\)/u, route);
    assert.match(source, /if \(auth\.response\) return auth\.response/u, route);
  }
});

test("public intake is isolated, bounded, origin-pinned, human-verified and send-free", async () => {
  const source = await readFile(new URL("../app/api/public/intake/route.ts", import.meta.url), "utf8");
  assert.match(source, /PUBLIC_SITE_ORIGIN/u);
  assert.match(source, /readBoundedJson/u);
  assert.match(source, /TURNSTILE_SECRET_KEY/u);
  assert.match(source, /PUBLIC_INTAKE_TURNSTILE_ACTION/u);
  assert.match(source, /intake_submissions/u);
  assert.match(source, /intake_rate_limits/u);
  assert.match(source, /ON CONFLICT\(bucket_key\)/u);
  assert.doesNotMatch(source, /sendMailgunMessage|messages\/send|MAILGUN_SENDING_KEY/u);
});

test("outbound email and contact tasks enforce qualification guards", async () => {
  const send = await readFile(new URL("../app/api/messages/send/route.ts", import.meta.url), "utf8");
  const tasks = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  assert.match(send, /emailContactability\(contact\)/u);
  assert.match(send, /recipient_not_qualified/u);
  assert.match(send, /to\.length !== 1/u);
  assert.match(tasks, /phoneContactability\(contact\)/u);
  assert.match(tasks, /contactChannel/u);
  assert.match(tasks, /contact_required_for_action/u);
  const taskUpdate = await readFile(new URL("../app/api/tasks/[id]/route.ts", import.meta.url), "utf8");
  assert.match(taskUpdate, /cancelled_contact_task_locked/u);
  assert.match(taskUpdate, /current\.status === "cancelled"/u);
});
