import assert from "node:assert/strict";
import test from "node:test";

import { sites } from "../build/sites-vite-plugin.ts";

test("keeps the required Sites packaging plugin in the repository", () => {
  const plugin = sites();

  assert.equal(plugin.name, "sites");
  assert.equal(plugin.apply, "build");
  assert.equal(typeof plugin.closeBundle, "function");
});
