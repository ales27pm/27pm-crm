import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("the CRM confirms provider acceptance without hiding a local recording failure", async () => {
  const source = await readFile(
    new URL("../app/components/crm-app.tsx", import.meta.url),
    "utf8",
  );
  const sendStart = source.indexOf("async function sendMessage");
  const responseBody = source.indexOf("await response.json()", sendStart);
  const accepted = source.indexOf(
    "attempts.confirm(payload, idempotencyKey)",
    sendStart,
  );
  const localWarning = source.indexOf("result.crmRecorded === false", sendStart);
  const refresh = source.indexOf("await refreshDashboard()", sendStart);

  assert.ok(sendStart >= 0);
  assert.ok(responseBody > sendStart);
  assert.ok(accepted > responseBody);
  assert.ok(localWarning > accepted);
  assert.ok(refresh > localWarning);
  assert.match(
    source.slice(sendStart, refresh + 500),
    /Courriel accepté par Mailgun; son enregistrement CRM doit être vérifié/u,
  );
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
