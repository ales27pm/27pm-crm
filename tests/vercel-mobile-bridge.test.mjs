import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the Vercel authorization page keeps the mobile signing key on the Worker", async () => {
  const [page, route] = await Promise.all([
    projectFile("app/mobile/authorize/page.tsx"),
    projectFile("app/api/mobile/authorize/route.ts"),
  ]);

  assert.doesNotMatch(page, /CRM_MOBILE_TOKEN_SIGNING_KEY/u);
  assert.doesNotMatch(page, /validMobileSigningSecret/u);
  assert.match(route, /CRM_MOBILE_TOKEN_SIGNING_KEY/u);
  assert.match(route, /validMobileSigningSecret/u);
});

test("the mobile sessions page loads through the authenticated API boundary", async () => {
  const [page, component] = await Promise.all([
    projectFile("app/mobile/sessions/page.tsx"),
    projectFile("app/components/mobile-sessions.tsx"),
  ]);

  assert.doesNotMatch(page, /crmDatabase|listActiveMobileSessions/u);
  assert.match(page, /<MobileSessionsManager\s*\/>/u);
  assert.match(component, /fetch\(["']\/api\/mobile\/sessions["']/u);
  assert.match(component, /cache:\s*["']no-store["']/u);
  assert.match(component, /response\.ok/u);
});

test("the Vercel runbook includes every public iOS authorization value", async () => {
  const runbook = await projectFile("docs/vercel-migration/README.md");
  assert.match(runbook, /CRM_MOBILE_REDIRECT_URI=/u);
  assert.match(runbook, /CRM_IOS_APP_ID=/u);
  assert.match(runbook, /CRM_MOBILE_TOKEN_SIGNING_KEY[^\n]*only on the Worker/u);
});
