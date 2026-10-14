import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import ts from "typescript";
import * as backup from "../lib/predeploy-backup.ts";

async function harness() {
  const source = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  const calls = { attachment: 0, identity: 0, route: 0 };
  const modules = {
    "vinext/server/image-optimization": {},
    "vinext/server/app-router-entry": { default: { fetch: async () => {
      calls.route += 1;
      return new Response("route");
    } } },
    "../lib/attachment-download-worker": { handleAttachmentDownloadRequest: async () => {
      calls.attachment += 1;
      return null;
    } },
    "../lib/internal-api-edge": { prepareInternalApiRequest: async (request) => {
      calls.identity += 1;
      return request;
    } },
    "../lib/predeploy-backup": backup,
  };
  const exports = {};
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(output, {
    exports, URL, Request, Response, Date,
    require(name) {
      assert.ok(Object.hasOwn(modules, name), `unexpected import ${name}`);
      return modules[name];
    },
  });
  return { worker: exports.default, calls };
}

test("temporary freeze precedes every ordinary route, identity nonce and attachment side effect", async () => {
  const { worker, calls } = await harness();
  const env = {
    CRM_PREDEPLOY_BACKUP_MODE: "freeze",
    CRM_PREDEPLOY_BACKUP_EXPIRES_AT: new Date(Date.now() + 60_000).toISOString(),
  };
  for (const path of ["/api/dashboard", "/api/webhooks/mailgun/inbound", "/api/public/intake", "/api/mobile/token", "/_vinext/image"]) {
    const response = await worker.fetch(new Request(`https://api.crm.27pm.org${path}`, { method: "POST" }), env, {});
    assert.equal(response.status, 503, path);
    assert.equal(response.headers.get("retry-after"), "300");
  }
  assert.deepEqual(calls, { attachment: 0, identity: 0, route: 0 });
  const response = await worker.fetch(new Request("https://api.crm.27pm.org/api/admin/d1-export", { method: "POST" }), env, {});
  assert.equal(response.status, 200);
  assert.deepEqual(calls, { attachment: 0, identity: 0, route: 1 });
});

test("expiry automatically restores normal handling while backup routes stay unavailable", async () => {
  const { worker, calls } = await harness();
  const env = { CRM_PREDEPLOY_BACKUP_MODE: "freeze", CRM_PREDEPLOY_BACKUP_EXPIRES_AT: "2020-01-01T00:00:00Z" };
  const request = (path) => new Request(`https://api.crm.27pm.org${path}`);
  assert.equal((await worker.fetch(request("/api/admin/d1-export"), env, {})).status, 404);
  assert.deepEqual(calls, { attachment: 0, identity: 0, route: 0 });
  assert.equal((await worker.fetch(request("/api/dashboard"), env, {})).status, 200);
  assert.deepEqual(calls, { attachment: 1, identity: 1, route: 1 });
});
