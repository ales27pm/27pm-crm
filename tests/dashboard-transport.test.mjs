import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard exposes the selected outbound provider without disclosing secrets", async () => {
  const [route, runtime, types, demo] = await Promise.all([
    readFile(new URL("../app/api/dashboard/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../lib/outbound-runtime.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/crm-types.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/demo-data.ts", import.meta.url), "utf8"),
  ]);

  assert.match(route, /transportProvider:\s*selectedOutboundProviderStatus\(\)/u);
  assert.match(runtime, /selectedOutboundProviderStatus\(\): OutboundProvider \| "unknown"/u);
  assert.match(runtime, /catch \{[\s\S]*return "unknown";/u);
  assert.match(types, /transportProvider: TransportProvider;/u);
  assert.match(demo, /transportProvider: "unknown"/u);
  assert.doesNotMatch(route, /CRM_EXCHANGE_CLIENT_SECRET/u);
});
