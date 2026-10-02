import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildLogicalD1Snapshot } from "../lib/d1-snapshot.ts";
import {
  authorizePredeployBackupRequest,
  isAllowedDuringPredeployBackup,
  isPredeployBackupFreeze,
  predeployMaintenanceResponse,
} from "../lib/predeploy-backup.ts";
import {
  buildR2InventoryPage,
  parseR2InventoryCursor,
} from "../lib/r2-inventory.ts";

const ORIGIN = "https://crm-backup.27pm.org";
const TOKEN = "a".repeat(64);
const NOW = Date.parse("2026-10-02T18:00:00.000Z");
const CONFIGURATION = {
  mode: "freeze",
  token: TOKEN,
  expiresAt: "2026-10-02T18:30:00.000Z",
  origin: ORIGIN,
  sourceCommitSha: "c".repeat(40),
  sitesVersionId: "appgprj_example~appgver_example",
};

test("backup access requires freeze mode, a short-lived strong token, and the configured HTTPS origin", async () => {
  const allowed = request("/api/admin/d1-export", {
    origin: ORIGIN,
    "x-27pm-backup-token": TOKEN,
  });
  assert.equal(
    await authorizePredeployBackupRequest(allowed, CONFIGURATION, NOW),
    null,
  );

  const cases = [
    [request("/api/admin/d1-export", { "x-27pm-backup-token": TOKEN }), 403],
    [request("/api/admin/d1-export", { origin: ORIGIN }), 401],
    [request("/api/admin/d1-export", {
      origin: "https://alias.example",
      "x-27pm-backup-token": TOKEN,
    }, "https://alias.example"), 403],
    [allowed, 503, { ...CONFIGURATION, mode: "enabled" }],
    [allowed, 503, { ...CONFIGURATION, token: "short" }],
    [allowed, 503, { ...CONFIGURATION, expiresAt: "2026-10-02T17:59:59.000Z" }],
    [allowed, 503, { ...CONFIGURATION, expiresAt: "2026-10-02T20:00:00.000Z" }],
    [allowed, 503, { ...CONFIGURATION, origin: "http://crm-backup.27pm.org" }],
  ];
  for (const [candidate, expectedStatus, configuration = CONFIGURATION] of cases) {
    const response = await authorizePredeployBackupRequest(
      candidate,
      configuration,
      NOW,
    );
    assert.equal(response?.status, expectedStatus);
    assert.equal(response?.headers.get("cache-control"), "private, no-store");
  }
});

test("freeze admits only the two exact backup routes and health", async () => {
  for (const path of [
    "/api/admin/d1-export",
    "/api/admin/r2-inventory",
  ]) {
    assert.equal(isAllowedDuringPredeployBackup("POST", path), true, path);
    assert.equal(isAllowedDuringPredeployBackup("GET", path), false, path);
  }
  assert.equal(isAllowedDuringPredeployBackup("GET", "/api/health"), true);
  assert.equal(isAllowedDuringPredeployBackup("HEAD", "/api/health"), true);
  assert.equal(isAllowedDuringPredeployBackup("POST", "/api/health"), false);
  for (const path of [
    "/",
    "/api/dashboard",
    "/api/webhooks/mailgun/events",
    "/api/admin/d1-export/",
    "/api/admin/r2-inventory/next",
    "/_vinext/image",
  ]) {
    assert.equal(isAllowedDuringPredeployBackup("POST", path), false, path);
  }
  const response = predeployMaintenanceResponse();
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "300");
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(isPredeployBackupFreeze(" freeze "), true);
  assert.equal(isPredeployBackupFreeze("enabled"), false);
});

test("D1 snapshot is complete, read-only, and internally consistent", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE parent (id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL);
    CREATE TABLE child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER NOT NULL REFERENCES parent(id),
      payload BLOB
    );
    CREATE INDEX child_parent_idx ON child(parent_id);
    CREATE VIEW child_view AS SELECT id, parent_id FROM child;
    CREATE TRIGGER child_touch AFTER UPDATE ON child BEGIN SELECT NEW.id; END;
    CREATE TABLE _cf_KV (key TEXT PRIMARY KEY, value BLOB);
    CREATE TABLE send_commands (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE webhook_receipts (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO parent (label) VALUES ('owner''s row');`);
  database
    .prepare("INSERT INTO child (id, parent_id, payload) VALUES (?, ?, ?)")
    .run(1, 1, Uint8Array.from([0, 1, 127, 255]));

  const queries = [];
  let batches = 0;
  const snapshot = await buildLogicalD1Snapshot(
    d1Adapter(database, queries, () => { batches += 1; }),
    sequenceClock("2026-10-02T18:00:00.000Z", "2026-10-02T18:00:01.000Z"),
  );

  assert.equal(snapshot.format, "27pm-d1-logical-v2");
  assert.deepEqual(snapshot.source, {
    projectId: "appgprj_6a8d706605548191a846e670fafdc72b",
    binding: "DB",
  });
  assert.equal(batches, 1);
  assert.deepEqual(snapshot.quickCheck, ["ok"]);
  assert.deepEqual(snapshot.foreignKeyViolations, []);
  assert.deepEqual(snapshot.quiescence, {
    dispatchingSendCommands: 0,
    reservedWebhookReceipts: 0,
  });
  assert.ok(!snapshot.schemaObjects.some((entry) => entry.name.startsWith("_cf_")));
  assert.ok(!snapshot.tables.some((table) => table.name.startsWith("_cf_")));
  assert.ok(snapshot.schemaObjects.some((entry) => entry.type === "trigger"));
  assert.ok(snapshot.schemaObjects.some((entry) => entry.type === "view"));
  const child = snapshot.tables.find((table) => table.name === "child");
  assert.equal(child?.rowCount, 1);
  assert.deepEqual(child?.rows[0][2], { kind: "blob", base64: "AAF//w==" });
  assert.ok(queries.every((query) => /^\s*(?:SELECT|PRAGMA)\b/iu.test(query)));
  const snapshotSource = await source("lib/d1-snapshot.ts");
  assert.match(snapshotSource, /Number\.isInteger\(value\) && !Number\.isSafeInteger\(value\)/u);
});

test("D1 snapshot fails closed while provider work remains in flight", async (t) => {
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE send_commands (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE webhook_receipts (id INTEGER PRIMARY KEY, status TEXT NOT NULL);
    INSERT INTO send_commands (id, status) VALUES ('send-1', 'dispatching');`);

  await assert.rejects(
    buildLogicalD1Snapshot(d1Adapter(database, [], () => {})),
    /not quiescent/u,
  );

  database.exec(`DELETE FROM send_commands;
    INSERT INTO webhook_receipts (id, status) VALUES (1, 'reserved');`);
  await assert.rejects(
    buildLogicalD1Snapshot(d1Adapter(database, [], () => {})),
    /not quiescent/u,
  );
});

test("R2 inventory is cursor-paginated and exposes metadata plus native SHA-256 without object bytes", async () => {
  const calls = [];
  const nativeSha256 = Uint8Array.from({ length: 32 }, (_, index) => index);
  const bucket = {
    async list(options) {
      calls.push(options);
      return {
        objects: [{
          key: "private/thread/attachment.bin",
          size: 4,
          etag: "etag-value",
          version: "version-value",
          uploaded: new Date("2026-10-02T17:00:00.000Z"),
          checksums: { sha256: nativeSha256 },
        }],
        truncated: true,
        cursor: "next-page",
      };
    },
  };

  const inventory = await buildR2InventoryPage(bucket, "opaque-cursor");
  assert.deepEqual(calls, [{ cursor: "opaque-cursor", limit: 1_000 }]);
  assert.deepEqual(inventory, {
    format: "27pm-r2-inventory-v1",
    source: {
      projectId: "appgprj_6a8d706605548191a846e670fafdc72b",
      binding: "BUCKET",
    },
    objects: [{
      key: "private/thread/attachment.bin",
      size: 4,
      etag: "etag-value",
      version: "version-value",
      uploaded: "2026-10-02T17:00:00.000Z",
      sha256: "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    }],
    truncated: true,
    cursor: "next-page",
  });
  assert.equal("body" in inventory.objects[0], false);
  assert.equal(parseR2InventoryCursor({}), null);
  assert.equal(parseR2InventoryCursor({ cursor: "opaque" }), "opaque");
  assert.equal(parseR2InventoryCursor({ cursor: "" }), undefined);
  assert.equal(parseR2InventoryCursor({ unexpected: true }), undefined);
});

test("checkpoint routes are POST-only, fail closed, no-store, and worker-level freeze runs before app dispatch", async () => {
  const [d1Route, r2Route, worker] = await Promise.all([
    source("app/api/admin/d1-export/route.ts"),
    source("app/api/admin/r2-inventory/route.ts"),
    source("worker/index.ts"),
  ]);
  for (const route of [d1Route, r2Route]) {
    assert.match(route, /export async function POST\(request: Request\)/u);
    assert.doesNotMatch(route, /export async function GET/u);
    assert.match(route, /CRM_PREDEPLOY_BACKUP_TOKEN/u);
    assert.match(route, /CRM_PREDEPLOY_BACKUP_EXPIRES_AT/u);
    assert.match(route, /CRM_PREDEPLOY_BACKUP_MODE/u);
    assert.match(route, /CRM_PREDEPLOY_BACKUP_ORIGIN/u);
    assert.match(route, /CRM_PREDEPLOY_BACKUP_SOURCE_COMMIT_SHA/u);
    assert.match(route, /CRM_PREDEPLOY_BACKUP_SITES_VERSION_ID/u);
    assert.doesNotMatch(route, /console\.(?:log|error|warn)/u);
  }
  assert.match(d1Route, /boundedRequest\(request, 0\)/u);
  assert.ok(
    worker.indexOf("isPredeployBackupFreeze") < worker.indexOf("handler.fetch"),
  );
  assert.match(worker, /predeployMaintenanceResponse/u);
});

function request(path, headers, origin = ORIGIN) {
  return new Request(`${origin}${path}`, { method: "POST", headers });
}

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

function d1Adapter(database, queries, onBatch) {
  return {
    prepare(query) {
      queries.push(query);
      return prepared(database, query, []);
    },
    async batch(statements) {
      onBatch();
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.all());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

function prepared(database, query, values) {
  return {
    bind(...nextValues) {
      return prepared(database, query, nextValues);
    },
    async all() {
      return {
        results: database.prepare(query).all(...values).map((row) => ({ ...row })),
        success: true,
        meta: { changes: 0 },
      };
    },
  };
}

function sequenceClock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}
