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
