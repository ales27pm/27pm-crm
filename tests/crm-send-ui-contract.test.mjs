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
      /(?:disabled=\{[\s\S]{0,260}!(?:view\.)?draftReady[\s\S]{0,260}(?:view\.)?sending|fieldsDisabled)/u,
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
  assert.match(
    source,
    /operationalReply \? \{ operationalReplyConfirmed: true \} : \{\}/u,
  );
  assert.match(
    source,
    /setReplyConfirmation\(\{[\s\S]*draftSlot,[\s\S]*payload,[\s\S]*localRepair:[\s\S]*operationalReply,/u,
  );
  assert.doesNotMatch(source, /window\.confirm/u);
  assert.match(
    source,
    /payload\.operationalReplyConfirmed === true[\s\S]*operationalReplyConfirmed: true/u,
  );
  assert.match(source, /replyPayload\(frozenDraft\.payload\)/u);
});

test("thread replies require an accessible in-app review before dispatch", async () => {
  const source = await readFile(
    new URL("../app/components/thread-view.tsx", import.meta.url),
    "utf8",
  );

  const submit = source.indexOf("async function submit()");
  const review = source.indexOf("setReplyConfirmation({", submit);
  const cancel = source.indexOf("function cancelReply", review);
  const confirmation = source.indexOf("function confirmReply", cancel);
  const guard = source.indexOf(
    "if (!confirmation || sendingRef.current) return;",
    confirmation,
  );
  const slotGuard = source.indexOf(
    "confirmation.draftSlot !== draftSlot",
    guard,
  );
  const dispatch = source.indexOf(
    "void dispatchReply(confirmation.draftSlot, confirmation.payload)",
    slotGuard,
  );
  const lock = source.indexOf("sendingRef.current = true", dispatch);
  const freeze = source.indexOf("executeFrozenSend({", dispatch);

  assert.ok(submit >= 0);
  assert.ok(review >= 0);
  assert.ok(cancel > review);
  assert.ok(confirmation > review);
  assert.ok(guard > confirmation);
  assert.ok(slotGuard > guard);
  assert.ok(dispatch > confirmation);
  assert.ok(lock > dispatch);
  assert.ok(freeze > dispatch);
  assert.doesNotMatch(source.slice(review, cancel), /dispatchReply|executeFrozenSend/u);
  assert.doesNotMatch(source.slice(cancel, confirmation), /dispatchReply|executeFrozenSend/u);
  assert.match(source, /<dialog[\s\S]*aria-modal="true"[\s\S]*aria-labelledby="reply-confirmation-title"[\s\S]*aria-describedby="reply-confirmation-description"/u);
  assert.match(source, /dialog\.showModal\(\)/u);
  assert.match(source, /onCancel=\{\(event\) => \{[\s\S]*event\.preventDefault\(\);[\s\S]*actions\.cancel\(\)/u);
  assert.match(source, /cancelButtonRef\.current\?\.focus\(\)/u);
  assert.match(source, /<dt>De<\/dt><dd>\{view\.confirmation\.payload\.from\}<\/dd>/u);
  assert.match(source, /<dt>À<\/dt><dd>\{view\.confirmation\.payload\.to\}<\/dd>/u);
  assert.match(source, /<dt>Objet<\/dt><dd>\{view\.confirmation\.payload\.subject\}<\/dd>/u);
  assert.match(source, /<pre>\{view\.confirmation\.payload\.body\}<\/pre>/u);
  assert.match(source, /ce destinataire unique est qualifié[\s\S]*fondement LCAP/u);
  assert.match(source, /dernier message entrant sollicite cette réponse administrative unique/u);
  assert.match(source, /Confirmer et envoyer/u);
  assert.match(
    source,
    /disabled=\{[\s\S]{0,260}view\.replyConfirmation !== null/u,
  );
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
