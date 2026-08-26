import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const projectFile = (path) =>
  readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("declares a private, non-indexable operator surface", async () => {
  const [layout, page, accessScreen, worker] = await Promise.all([
    projectFile("app/layout.tsx"),
    projectFile("app/page.tsx"),
    projectFile("app/components/access-screen.tsx"),
    projectFile("worker/index.ts"),
  ]);

  assert.match(layout, /title:\s*["']27PM CRM["']/u);
  assert.match(layout, /index:\s*false/u);
  assert.match(layout, /follow:\s*false/u);
  assert.match(page, /isCrmOperator\(user\.email\)/u);
  assert.match(accessScreen, /Se connecter avec ChatGPT/u);
  assert.match(worker, /x-frame-options["'],\s*["']DENY/u);
  assert.match(worker, /x-robots-tag["'],\s*["']noindex, nofollow, noarchive/u);
});
