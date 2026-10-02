import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { buildLogicalD1Snapshot } from "../lib/d1-snapshot.ts";
import {
  configFromEnvironment,
  runCapture,
} from "../scripts/capture-predeploy-backup.mjs";

const PROJECT_ID = "appgprj_6a8d706605548191a846e670fafdc72b";
const SOURCE_COMMIT = "c".repeat(40);
const VERSION_ID = `${PROJECT_ID}~appgver_example`;
const CHECKPOINT = {
  sourceCommitSha: SOURCE_COMMIT,
  sitesVersionId: VERSION_ID,
};
const TOKEN = "t".repeat(64);

test("capture configuration pins the two endpoints to one exact HTTPS origin", () => {
  const environment = captureEnvironment("/tmp/unused-backup-output");
  const configuration = configFromEnvironment(environment, []);
  assert.equal(configuration.d1Url.href, "https://crm.27pm.org/api/admin/d1-export");
  assert.equal(configuration.r2Url.href, "https://crm.27pm.org/api/admin/r2-inventory");

  assert.throws(
    () => configFromEnvironment({
      ...environment,
      CRM_BACKUP_D1_EXPORT_URL: "https://attacker.example/api/admin/d1-export",
    }, []),
    /same HTTPS origin/u,
  );
  assert.throws(
    () => configFromEnvironment({
      ...environment,
      CRM_BACKUP_D1_EXPORT_URL: "https://crm.27pm.org/api/admin/d1-export/",
    }, []),
    /exact HTTPS/u,
  );
  assert.throws(
    () => configFromEnvironment(environment, ["--token", TOKEN]),
    /arguments are not accepted/u,
  );
});

test("capture sends a bodyless D1 request, paginates R2, and writes private artifacts", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "27pm-predeploy-capture-test-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const outputDirectory = join(parent, "backup");
  const requests = [];
  const logs = [];
  let r2Page = 0;

  const fetchImpl = async (input, init) => {
    const url = new URL(input);
    requests.push({ url, init });
    assert.equal(init.headers.origin, "https://crm.27pm.org");
    assert.equal(init.headers["accept-encoding"], "identity");
    assert.equal(init.headers["x-27pm-backup-token"], TOKEN);
    if (url.pathname === "/api/admin/d1-export") {
      assert.equal(init.body, undefined);
      assert.equal(init.headers["content-type"], undefined);
      return jsonResponse({
        format: "27pm-d1-logical-v2",
        source: { projectId: PROJECT_ID, binding: "DB" },
        checkpoint: CHECKPOINT,
        quiescence: {
          dispatchingSendCommands: 0,
          reservedWebhookReceipts: 0,
        },
        tables: [],
        schemaObjects: [],
      });
    }

    assert.equal(url.pathname, "/api/admin/r2-inventory");
    assert.equal(init.headers["content-type"], "application/json");
    const payload = JSON.parse(init.body);
    r2Page += 1;
    if (r2Page === 1) {
      assert.deepEqual(payload, {});
      return jsonResponse({
        format: "27pm-r2-inventory-v1",
        source: { projectId: PROJECT_ID, binding: "BUCKET" },
        checkpoint: CHECKPOINT,
        objects: [],
        truncated: true,
        cursor: "next-page",
      });
    }
    assert.deepEqual(payload, { cursor: "next-page" });
    return jsonResponse({
      format: "27pm-r2-inventory-v1",
      source: { projectId: PROJECT_ID, binding: "BUCKET" },
      checkpoint: CHECKPOINT,
      objects: [],
      truncated: false,
    });
  };

  const result = await runCapture({
    args: [],
    env: captureEnvironment(outputDirectory),
    fetchImpl,
    now: sequenceClock(
      "2026-10-02T20:00:00.000Z",
      "2026-10-02T20:00:01.000Z",
    ),
    validateImpl: async ({ snapshotPath, inventoryPath }) => {
      assert.equal(JSON.parse(await readFile(snapshotPath, "utf8")).checkpoint.sitesVersionId, VERSION_ID);
      assert.equal(JSON.parse(await readFile(inventoryPath, "utf8")).pageCount, 2);
      return { restoredQuickCheck: "ok" };
    },
    log: (line) => logs.push(line),
  });

  assert.equal(requests.length, 3);
  assert.equal(result.status, "validated");
  assert.equal(result.r2Pages, 2);
  assert.equal(result.r2Objects, 0);
  assert.equal((await stat(outputDirectory)).mode & 0o777, 0o700);
  for (const file of ["d1-snapshot.json", "r2-inventory.json"]) {
    assert.equal((await stat(join(outputDirectory, file))).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(join(outputDirectory, file), "utf8"), new RegExp(TOKEN, "u"));
  }
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], new RegExp(TOKEN, "u"));
});

test("validator restores empty-R2 checkpoints and fails closed when R2 bytes are absent", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "27pm-predeploy-validator-test-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const database = new DatabaseSync(":memory:");
  t.after(() => database.close());
  database.exec(`CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    r2_key TEXT NOT NULL UNIQUE,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT,
    scan_status TEXT NOT NULL
  );
  CREATE TABLE send_commands (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE webhook_receipts (id INTEGER PRIMARY KEY, status TEXT NOT NULL);`);
  const snapshot = await buildLogicalD1Snapshot(
    d1Adapter(database),
    sequenceClock(
      "2026-10-02T20:00:00.000Z",
      "2026-10-02T20:00:01.000Z",
    ),
  );
  snapshot.checkpoint = CHECKPOINT;
  const snapshotPath = join(temporary, "snapshot.json");
  const inventoryPath = join(temporary, "inventory.json");
  await writeFile(snapshotPath, JSON.stringify(snapshot));
  await writeFile(inventoryPath, JSON.stringify({
    format: "27pm-r2-inventory-v1",
    source: { projectId: PROJECT_ID, binding: "BUCKET" },
    checkpoint: CHECKPOINT,
    startedAt: "2026-10-02T20:00:01.000Z",
    completedAt: "2026-10-02T20:00:02.000Z",
    complete: true,
    pageCount: 1,
    objects: [],
  }));

  const success = validate(snapshotPath, inventoryPath, join(temporary, "validated"));
  assert.equal(success.status, 0, success.stderr || success.stdout);
  const manifest = JSON.parse(
    await readFile(join(temporary, "validated", "manifest.json"), "utf8"),
  );
  assert.equal(manifest.validation.restoredQuickCheck, "ok");
  assert.equal(manifest.validation.restoredForeignKeyViolations, 0);
  assert.equal(manifest.validation.r2Reconciliation.clean, true);

  await writeFile(inventoryPath, JSON.stringify({
    format: "27pm-r2-inventory-v1",
    source: { projectId: PROJECT_ID, binding: "BUCKET" },
    checkpoint: CHECKPOINT,
    startedAt: "2026-10-02T20:00:01.000Z",
    completedAt: "2026-10-02T20:00:02.000Z",
    complete: true,
    pageCount: 1,
    objects: [{ key: "orphan.bin", size: 1 }],
  }));
  const failure = validate(snapshotPath, inventoryPath, join(temporary, "blocked"));
  assert.notEqual(failure.status, 0);
  assert.match(failure.stderr, /object bytes were not captured/u);
});

function captureEnvironment(outputDirectory) {
  return {
    CRM_BACKUP_D1_EXPORT_URL: "https://crm.27pm.org/api/admin/d1-export",
    CRM_BACKUP_R2_INVENTORY_URL: "https://crm.27pm.org/api/admin/r2-inventory",
    CRM_BACKUP_TOKEN: TOKEN,
    CRM_BACKUP_OUTPUT_DIRECTORY: outputDirectory,
    CRM_BACKUP_SOURCE_COMMIT_SHA: SOURCE_COMMIT,
    CRM_BACKUP_SITES_VERSION_ID: VERSION_ID,
  };
}

function jsonResponse(value) {
  const body = JSON.stringify(value);
  const bytes = Buffer.byteLength(body);
  return new Response(body, {
    status: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(bytes),
      "content-type": "application/json; charset=utf-8",
      "x-27pm-backup-byte-count": String(bytes),
    },
  });
}

function validate(snapshotPath, inventoryPath, outputDirectory) {
  return spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      "scripts/validate-d1-export.mjs",
      snapshotPath,
      inventoryPath,
      outputDirectory,
    ],
    { cwd: process.cwd(), encoding: "utf8" },
  );
}

function d1Adapter(database) {
  const prepared = (query, values = []) => ({
    bind(...nextValues) {
      return prepared(query, nextValues);
    },
    async all() {
      return {
        results: database.prepare(query).all(...values).map((row) => ({ ...row })),
        success: true,
        meta: { changes: 0 },
      };
    },
  });
  return {
    prepare(query) {
      return prepared(query);
    },
    async batch(statements) {
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

function sequenceClock(...values) {
  let index = 0;
  return () => new Date(values[Math.min(index++, values.length - 1)]);
}
