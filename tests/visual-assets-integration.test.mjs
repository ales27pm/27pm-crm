import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const projectFile = (relativePath, encoding) =>
  readFile(path.join(projectRoot, relativePath), encoding);

async function listFiles(root, prefix = "") {
  const entries = await readdir(path.join(root, prefix), { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const relativePath = path.join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(root, relativePath) : [relativePath];
  }));
  return files.flat().sort();
}

test("publishes an exact copy of the validated visual asset tree", async () => {
  const suiteRoot = path.join(projectRoot, "design/visual-assets-suite/public/visual-assets");
  const publicRoot = path.join(projectRoot, "public/visual-assets");
  const [suiteFiles, publicFiles] = await Promise.all([
    listFiles(suiteRoot),
    listFiles(publicRoot),
  ]);

  assert.deepEqual(publicFiles, suiteFiles);
  assert.equal(publicFiles.length, 120);

  await Promise.all(publicFiles.map(async (relativePath) => {
    const [published, source] = await Promise.all([
      readFile(path.join(publicRoot, relativePath)),
      readFile(path.join(suiteRoot, relativePath)),
    ]);
    assert.deepEqual(published, source, `${relativePath} differs from the suite`);
  }));
});

test("connects logos, editorial art, empty states, and application icons", async () => {
  const expectedReferences = {
    "app/components/access-screen.tsx": [
      "/visual-assets/brand/27pm-crm-horizontal.svg",
      "/visual-assets/backgrounds/login-flow-ivory.png",
      "/visual-assets/backgrounds/mobile-flow-ivory.png",
      "access-denied",
    ],
    "app/components/sidebar.tsx": [
      "/visual-assets/brand/27pm-crm-horizontal.svg",
      "/visual-assets/brand/27pm-crm-compact.svg",
    ],
    "app/components/inbox-rail.tsx": ["inbox-empty"],
    "app/components/thread-view.tsx": ["thread-select"],
    "app/components/account-workspace.tsx": ["accounts-empty", "search-empty"],
    "app/components/pipeline-view.tsx": ["pipeline-empty", "search-empty"],
    "app/components/work-views.tsx": ["projects-empty", "tasks-clear"],
    "app/components/today-view.tsx": ["tasks-clear"],
    "app/components/outreach-strategy-panel.tsx": ["strategy-empty"],
    "app/components/crm-app.tsx": ["connection-error"],
    "app/layout.tsx": [
      "/visual-assets/app-icons/site.webmanifest",
      "apple-touch-icon-180.png",
      "favicon.ico",
    ],
  };

  await Promise.all(Object.entries(expectedReferences).map(async ([relativePath, references]) => {
    const source = await projectFile(relativePath, "utf8");
    for (const reference of references) {
      assert.ok(source.includes(reference), `${reference} missing from ${relativePath}`);
    }
  }));

  const [favicon, suiteFavicon, legacyMark, officialMark] = await Promise.all([
    projectFile("public/favicon.svg"),
    projectFile("design/visual-assets-suite/public/visual-assets/app-icons/favicon-64.svg"),
    projectFile("public/brand/27-mark.png"),
    projectFile("design/visual-assets-suite/public/visual-assets/brand/27pm-mark-original-1024.png"),
  ]);
  assert.deepEqual(favicon, suiteFavicon);
  assert.deepEqual(legacyMark, officialMark);
});

test("keeps illustrations decorative and does not register private offline caching", async () => {
  const [visualAssets, appFiles] = await Promise.all([
    projectFile("app/components/visual-assets.tsx", "utf8"),
    listFiles(path.join(projectRoot, "app")),
  ]);

  assert.match(visualAssets, /alt=["']["']/u);
  assert.match(visualAssets, /decoding=["']async["']/u);

  const applicationSource = (await Promise.all(
    appFiles
      .filter((relativePath) => /\.(?:js|jsx|ts|tsx)$/u.test(relativePath))
      .map((relativePath) => projectFile(path.join("app", relativePath), "utf8")),
  )).join("\n");
  assert.doesNotMatch(applicationSource, /navigator\.serviceWorker|workbox|registerSW\s*\(/iu);
});
