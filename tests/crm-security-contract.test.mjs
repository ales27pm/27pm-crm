import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

import { isSameOriginBrowserRequest } from "../lib/http.ts";

const unsafeRouteInventory = [
  { route: "accounts/import/route.ts", method: "POST", boundary: "operator" },
  { route: "admin/cakemail-send-resolution/route.ts", method: "POST", boundary: "operator" },
  { route: "admin/mailgun-canary/route.ts", method: "POST", boundary: "operator" },
  { route: "admin/mailgun-handoff/route.ts", method: "POST", boundary: "operator" },
  { route: "compliance/route.ts", method: "PATCH", boundary: "operator" },
  { route: "contacts/[id]/route.ts", method: "DELETE", boundary: "operator" },
  { route: "contacts/[id]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "contacts/route.ts", method: "POST", boundary: "operator" },
  { route: "conversations/[id]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "deals/[id]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "intake/[id]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "interactions/route.ts", method: "POST", boundary: "operator" },
  { route: "messages/send/route.ts", method: "POST", boundary: "operator" },
  { route: "organizations/[id]/route.ts", method: "DELETE", boundary: "operator" },
  { route: "organizations/[id]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "organizations/route.ts", method: "POST", boundary: "operator" },
  { route: "privacy-requests/[id]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "privacy-requests/route.ts", method: "POST", boundary: "operator" },
  { route: "strategies/[strategyId]/route.ts", method: "PUT", boundary: "operator" },
  { route: "strategies/[strategyId]/steps/[stepId]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "tasks/[id]/route.ts", method: "PATCH", boundary: "operator" },
  { route: "tasks/route.ts", method: "POST", boundary: "operator" },
  {
    route: "admin/mailgun-handoff/consume/route.ts",
    method: "POST",
    boundary: "consumer",
    guard: /verifyMailgunHandoffConsumerToken\(token\)/u,
  },
  {
    route: "public/intake/route.ts",
    method: "POST",
    boundary: "public",
    guard: /allowedOrigin\(request\)[\s\S]*verifyTurnstile/u,
  },
  {
    route: "public/unsubscribe/route.ts",
    method: "POST",
    boundary: "public",
    guard: /verifyUnsubscribeToken/u,
  },
  {
    route: "webhooks/cakemail/events/route.ts",
    method: "POST",
    boundary: "webhook",
    guard: /verifyCakemailWebhookSignature/u,
  },
  {
    route: "webhooks/mailgun/events/route.ts",
    method: "POST",
    boundary: "webhook",
    guard: /verifyMailgunSignature/u,
  },
  {
    route: "webhooks/mailgun/inbound/route.ts",
    method: "POST",
    boundary: "webhook",
    guard: /verifyMailgunSignature/u,
  },
  {
    route: "prospects/route.ts",
    method: "POST",
    boundary: "retired-operator",
    guard: /requireOperatorRequest\(request\)[\s\S]*return jsonError\(\s*410,/u,
  },
];

test("classifies every unsafe API method at its actual trust boundary", async () => {
  const actual = [];
  const routeNames = (await readdir(new URL("../app/api/", import.meta.url), {
    recursive: true,
  })).filter((name) => name.endsWith("route.ts"));
  for (const route of routeNames) {
    const source = await readFile(new URL(`../app/api/${route}`, import.meta.url), "utf8");
    for (const { method } of exportedApiMethods(source, route)) {
      actual.push(`${route}:${method}`);
    }
  }

  assert.deepEqual(
    actual.sort(),
    unsafeRouteInventory.map(({ route, method }) => `${route}:${method}`).sort(),
  );
});

test("every operator mutation enforces same-origin auth inside its method", async () => {
  for (const { route, method, boundary } of unsafeRouteInventory) {
    if (boundary !== "operator") continue;
    const source = await readFile(new URL(`../app/api/${route}`, import.meta.url), "utf8");
    const exported = exportedApiMethod(source, method, route);
    const methodSource = exported.source;
    assert.match(
      methodSource,
      /requireSameOriginOperator(?:Json)?Request\(\s*request/u,
      `${method} app/api/${route}`,
    );
    assert.match(
      methodSource,
      /if \(auth\.response\) return auth\.response/u,
      `${method} app/api/${route}`,
    );
    assert.doesNotMatch(
      methodSource,
      /requireOperatorRequest\(\s*request/u,
      `${method} app/api/${route}`,
    );
    assert.match(
      exported.statements[0] ?? "",
      /^const auth = (?:await )?requireSameOriginOperator(?:Json)?Request\(\s*request/u,
      `${method} app/api/${route} must authenticate before side effects`,
    );
    assert.match(
      exported.statements[1] ?? "",
      /^if \(auth\.response\) return auth\.response/u,
      `${method} app/api/${route} must return before side effects`,
    );
  }
});

test("non-operator unsafe methods retain their dedicated boundary", async () => {
  for (const { route, method, boundary, guard } of unsafeRouteInventory) {
    if (boundary === "operator") continue;
    const source = await readFile(new URL(`../app/api/${route}`, import.meta.url), "utf8");
    const methodSource = exportedApiMethod(source, method, route).source;
    assert.match(methodSource, guard, `${method} app/api/${route} (${boundary})`);
    if (boundary !== "retired-operator") {
      assert.doesNotMatch(
        methodSource,
        /require(?:SameOriginOperatorJson|SameOriginOperator|Operator)Request\(/u,
        `${method} app/api/${route} (${boundary})`,
      );
    }
  }
});

test("same-origin browser checks require positive same-origin evidence", () => {
  const request = (headers = {}) => new Request("https://crm.27pm.org/api/tasks", {
    method: "POST",
    headers,
  });

  assert.equal(isSameOriginBrowserRequest(request()), false);
  assert.equal(isSameOriginBrowserRequest(request({ origin: "https://crm.27pm.org" })), true);
  assert.equal(isSameOriginBrowserRequest(request({ "sec-fetch-site": "same-origin" })), true);
  assert.equal(isSameOriginBrowserRequest(request({
    origin: "https://crm.27pm.org",
    "sec-fetch-site": "same-origin",
  })), true);
  for (const fetchSite of ["cross-site", "same-site", "none"]) {
    assert.equal(
      isSameOriginBrowserRequest(request({ "sec-fetch-site": fetchSite })),
      false,
      fetchSite,
    );
  }
  for (const origin of ["https://27pm.org", "https://crm.27pm.org:444", "null", "not a url"]) {
    assert.equal(isSameOriginBrowserRequest(request({ origin })), false, origin);
  }
});

function exportedApiMethod(source, method, route) {
  const matches = exportedApiMethods(source, route).filter(
    (candidate) => candidate.method === method,
  );
  assert.equal(matches.length, 1, `${route}:${method}`);
  return matches[0];
}

function exportedApiMethods(source, route) {
  const sourceFile = ts.createSourceFile(
    route,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const methods = [];
  const record = (method, node, body) => {
    if (!/^(?:POST|PUT|PATCH|DELETE)$/u.test(method)) return;
    methods.push({
      method,
      source: node.getText(sourceFile),
      statements: body
        ? [...body.statements].map((statement) => statement.getText(sourceFile))
        : [],
    });
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      exported(statement) &&
      statement.name
    ) {
      record(statement.name.text, statement, statement.body);
      continue;
    }
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initializer = declaration.initializer;
        const body =
          (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) &&
          ts.isBlock(initializer.body)
            ? initializer.body
            : undefined;
        record(declaration.name.text, statement, body);
      }
      continue;
    }
    if (ts.isExportDeclaration(statement)) {
      if (!statement.exportClause) {
        methods.push({ method: "*", source: statement.getText(sourceFile), statements: [] });
        continue;
      }
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          record(element.name.text, statement, undefined);
        }
      }
    }
  }
  return methods;
}

function exported(node) {
  return Boolean(
    ts.getModifiers(node)?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    ),
  );
}

test("Cakemail unknown outcomes require bounded same-origin evidence and never redispatch", async () => {
  const source = await readFile(
    new URL("../app/api/admin/cakemail-send-resolution/route.ts", import.meta.url),
    "utf8",
  );
  const implementation = await readFile(
    new URL("../lib/cakemail-unknown-send-resolution.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /boundedRequest/u);
  const auth = await readFile(
    new URL("../lib/api-auth.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /requireSameOriginOperatorRequest\(request\)/u);
  assert.match(auth, /cross_origin_request_forbidden/u);
  assert.match(implementation, /providerObservedAt/u);
  assert.match(implementation, /evidenceReference/u);
  assert.match(
    implementation,
    /verifiedMessageIdHeader === `<\$\{core\.externalMessageId\}>`/u,
  );
  assert.match(implementation, /transport_outcome_unknown/u);
  assert.doesNotMatch(
    `${source}\n${implementation}`,
    /sendCakemailMessage|sendOutboundMessage|fetch\(/u,
  );
});

test("the Mailgun canary is operator-only and pinned to one configured recipient", async () => {
  const source = await readFile(new URL("../app/api/admin/mailgun-canary/route.ts", import.meta.url), "utf8");
  assert.match(source, /CRM_CANARY_RECIPIENT/u);
  assert.match(source, /recipient !== configuredRecipient/u);
  assert.match(source, /confirmed !== true/u);
  assert.match(source, /requireSameOriginOperatorJsonRequest\(/u);
  assert.match(source, /DELIVERABILITY_CANARY_SENDER/u);
  assert.doesNotMatch(source, /loadContactCompliance|canEmail|appendComplianceFooter/u);
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
  const operationalReply = await readFile(new URL("../lib/operational-reply.ts", import.meta.url), "utf8");
  const tasks = await readFile(new URL("../app/api/tasks/route.ts", import.meta.url), "utf8");
  assert.match(send, /canEmail\(contact, configuration\)/u);
  assert.match(send, /advanceSendAuthorization/u);
  assert.match(send, /complianceEvidenceSnapshot/u);
  assert.match(send, /const suppressionCategory = "prospecting"/u);
  assert.match(send, /loadOperationalReplyEvidence/u);
  assert.match(send, /advanceOperationalReplyAuthorization/u);
  assert.match(send, /operational_reply_confirmation_required/u);
  assert.match(send, /requireMailgunOperationalConfig/u);
  assert.match(send, /operationalReplyApprovalDigest/u);
  assert.match(send, /operationalReplyApprovalMatches/u);
  assert.match(send, /runtimeString\("CRM_OPERATIONAL_REPLY_APPROVAL_SHA256"\)/u);
  assert.match(send, /isWellFormedUnicode/u);
  assert.match(send, /kind: "solicited_operational_reply"/u);
  assert.match(send, /approvalDigest: operationalReplyDigest/u);
  assert.match(
    send,
    /operationalReply,[\s\S]*operationalReplyDigest!,[\s\S]*auth\.operator\.email,[\s\S]*"pending",[\s\S]*"authorized"/u,
  );
  assert.match(
    send,
    /mailbox\.purpose === "operations"[\s\S]*\(!conversationId \|\| !content\.text \|\| content\.html !== null\)/u,
  );
  assert.match(operationalReply, /mailbox\.purpose='operations'/u);
  assert.match(operationalReply, /inbound\.direction='inbound'/u);
  assert.match(operationalReply, /inbound\.status='received'/u);
  assert.match(operationalReply, /inbound\.transport_provider='mailgun'/u);
  assert.match(operationalReply, /FROM contact_suppressions suppression/u);
  assert.match(operationalReply, /operator_confirmed_at IS NOT NULL/u);
  assert.match(
    operationalReply,
    /json_extract\(compliance_snapshot_json, '\$\.approvalDigest'\)=\?/u,
  );
  assert.doesNotMatch(send, /mailbox\.purpose !== "sales"/u);
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
  const requestParser = await readFile(new URL("../lib/unsubscribe-request.ts", import.meta.url), "utf8");
  assert.match(source, /verifyUnsubscribeToken/u);
  assert.match(requestParser, /boundedRequest/u);
  assert.match(requestParser, /List-Unsubscribe/u);
  assert.match(requestParser, /One-Click/u);
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
