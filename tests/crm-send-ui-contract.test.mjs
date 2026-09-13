import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the CRM retains the send key and draft until local recording is repaired", async () => {
  const [source, resultContract] = await Promise.all([
    readFile(
      new URL("../app/components/crm-app.tsx", import.meta.url),
      "utf8",
    ),
    readFile(new URL("../lib/send-ui-result.ts", import.meta.url), "utf8"),
  ]);
  const sendStart = source.indexOf("async function sendMessage");
  const responseBody = source.indexOf("await response.json()", sendStart);
  const classification = source.indexOf(
    "classifyMessageSendHttpResponse",
    responseBody,
  );
  const localRepair = source.indexOf('outcome === "local_repair"', classification);
  const acceptedConfirmation = source.indexOf(
    "attempts.confirm(payload, idempotencyKey)",
    localRepair,
  );
  const localReturn = source.indexOf(
    "return sendUiResult(outcome, LOCAL_REPAIR_MESSAGE)",
    localRepair,
  );

  assert.ok(sendStart >= 0);
  assert.ok(responseBody > sendStart);
  assert.ok(classification > responseBody);
  assert.ok(localRepair > classification);
  assert.ok(localReturn > localRepair);
  assert.ok(acceptedConfirmation > localReturn);
  assert.doesNotMatch(
    source.slice(localRepair, localReturn),
    /attempts\.confirm\(payload, idempotencyKey\)/u,
  );
  assert.match(
    resultContract,
    /réessayez sans modifier le brouillon pour réparer son enregistrement CRM sans le renvoyer/u,
  );
});

test("compose and reply durably reserve the exact draft before the API call", async () => {
  const helper = await readFile(
    new URL("../app/components/frozen-send-ui.ts", import.meta.url),
    "utf8",
  );
  const reserve = helper.indexOf("reservation = await registry.reserve(");
  const frozenUi = helper.indexOf("onReserved(draftFromReservation(reservation))", reserve);
  const providerCall = helper.indexOf("await send(payload)", frozenUi);
  const settle = helper.indexOf("settleBestEffort(", providerCall);

  assert.ok(reserve >= 0);
  assert.ok(frozenUi > reserve);
  assert.ok(providerCall > frozenUi);
  assert.ok(settle > providerCall);

  for (const path of [
    "../app/components/compose-dialog.tsx",
    "../app/components/thread-view.tsx",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    assert.match(source, /restoreFrozenDraft\(/u);
    assert.match(source, /executeFrozenSend\(\{/u);
    assert.match(
      source,
      /(?:frozenDraft|draftState\.frozen)\?\.outcome === "outcome_unknown"/u,
    );
    assert.match(
      source,
      /(?:frozenDraft|draftState\.frozen)\?\.outcome === "local_repair"/u,
    );
    assert.match(
      source,
      /(?:disabled=\{!(?:view\.)?draftReady[^}]*sending|fieldsDisabled)/u,
    );
  }
});

test("the reply path freezes the full request identity, not only its body", async () => {
  const source = await readFile(
    new URL("../app/components/thread-view.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /conversationId: conversation\.id,[\s\S]*from: conversation\.mailboxAddress,[\s\S]*to: conversation\.contactEmail,[\s\S]*subject: conversation\.subject,[\s\S]*body: value,[\s\S]*complianceConfirmed: true/u,
  );
  assert.match(source, /replyPayload\(frozenDraft\.payload\)/u);
});

test("compose and reply clear drafts only after a typed accepted result", async () => {
  const helper = await readFile(
    new URL("../app/components/frozen-send-ui.ts", import.meta.url),
    "utf8",
  );
  const settlement = helper.indexOf("settleBestEffort(");
  const accepted = helper.indexOf(
    'result.outcome === "accepted" && draft === null',
    settlement,
  );
  assert.ok(settlement >= 0);
  assert.ok(accepted > settlement);

  for (const path of [
    "../app/components/compose-dialog.tsx",
    "../app/components/thread-view.tsx",
  ]) {
    const source = await readFile(new URL(path, import.meta.url), "utf8");
    const acceptedAndSettled = source.indexOf("execution.acceptedAndSettled");
    const clearDraft = source.indexOf('body: ""', acceptedAndSettled);
    const replyClear = source.indexOf('setBody("")', acceptedAndSettled);

    assert.ok(acceptedAndSettled >= 0, path);
    assert.ok(clearDraft > acceptedAndSettled || replyClear > acceptedAndSettled, path);
    assert.match(source, /Promise<SendUiResult>/u, path);
  }
});

test("the compose dialog routes the exact 27PM Gmail canary through its administrative endpoint", async () => {
  const app = await readFile(
    new URL("../app/components/crm-app.tsx", import.meta.url),
    "utf8",
  );
  const dialog = await readFile(
    new URL("../app/components/compose-dialog.tsx", import.meta.url),
    "utf8",
  );
  const config = await readFile(
    new URL("../lib/deliverability-canary.ts", import.meta.url),
    "utf8",
  );

  assert.match(config, /DELIVERABILITY_CANARY_RECIPIENT = "27pmorg@gmail\.com"/u);
  assert.match(app, /DELIVERABILITY_CANARY_RECIPIENT/u);
  assert.match(app, /fetch\("\/api\/admin\/mailgun-canary"/u);
  assert.match(app, /confirmed: payload\.complianceConfirmed/u);
  assert.match(app, /subject: payload\.subject/u);
  assert.match(app, /text: payload\.body/u);
  assert.match(dialog, /Test de délivrabilité 27PM/u);
  assert.match(dialog, /Envoyer le test/u);
  assert.match(dialog, /test interne envoyé uniquement à votre boîte Gmail 27PM/u);
});
