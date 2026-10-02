#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  readBoundedResponseBytes,
  ResponseByteLimitError,
} from "./read-bounded-response.mjs";

export const D1_SNAPSHOT_FILE = "d1-snapshot.json";
export const R2_INVENTORY_FILE = "r2-inventory.json";
export const R2_INVENTORY_FORMAT = "27pm-r2-inventory-v1";

const D1_MAX_BYTES = 25 * 1_024 * 1_024;
const R2_PAGE_MAX_BYTES = 3 * 1_024 * 1_024;
const MAX_R2_PAGES = 10_000;
const MAX_R2_OBJECTS = 1_000_000;
const REQUEST_TIMEOUT_MS = 30_000;
const HOSTING_CONFIG_URL = new URL("../.openai/hosting.json", import.meta.url);
const VALIDATOR_PATH = fileURLToPath(
  new URL("./validate-d1-export.mjs", import.meta.url),
);

export class PredeployBackupCaptureError extends Error {
  constructor(message) {
    super(message);
    this.name = "PredeployBackupCaptureError";
  }
}

export function configFromEnvironment(env = process.env, args = []) {
  if (args.length !== 0) {
    throw new PredeployBackupCaptureError(
      "Command-line arguments are not accepted; configure the capture through environment variables.",
    );
  }

  const token = requiredExactValue(env, "CRM_BACKUP_TOKEN");
  const tokenBytes = Buffer.byteLength(token, "utf8");
  if (tokenBytes < 32 || tokenBytes > 512) {
    throw new PredeployBackupCaptureError(
      "CRM_BACKUP_TOKEN must contain between 32 and 512 bytes.",
    );
  }

  const sourceCommitSha = requiredExactValue(
    env,
    "CRM_BACKUP_SOURCE_COMMIT_SHA",
  ).toLowerCase();
  if (!/^[0-9a-f]{40}$/u.test(sourceCommitSha)) {
    throw new PredeployBackupCaptureError(
      "CRM_BACKUP_SOURCE_COMMIT_SHA must be a full commit SHA.",
    );
  }

  const sitesVersionId = requiredExactValue(
    env,
    "CRM_BACKUP_SITES_VERSION_ID",
  );
  if (
    !/^appgprj_[a-zA-Z0-9]+~appgver_[a-zA-Z0-9]+$/u.test(sitesVersionId)
  ) {
    throw new PredeployBackupCaptureError(
      "CRM_BACKUP_SITES_VERSION_ID must be a full Sites version ID.",
    );
  }

  const outputValue = requiredExactValue(
    env,
    "CRM_BACKUP_OUTPUT_DIRECTORY",
  );
  if (outputValue.includes("\0")) {
    throw new PredeployBackupCaptureError(
      "CRM_BACKUP_OUTPUT_DIRECTORY contains an invalid character.",
    );
  }

  const d1Url = secureEndpoint(
    requiredExactValue(env, "CRM_BACKUP_D1_EXPORT_URL"),
    "CRM_BACKUP_D1_EXPORT_URL",
    "/api/admin/d1-export",
  );
  const r2Url = secureEndpoint(
    requiredExactValue(env, "CRM_BACKUP_R2_INVENTORY_URL"),
    "CRM_BACKUP_R2_INVENTORY_URL",
    "/api/admin/r2-inventory",
  );
  if (d1Url.origin !== r2Url.origin) {
    throw new PredeployBackupCaptureError(
      "The D1 and R2 backup endpoints must use the same HTTPS origin.",
    );
  }

  return {
    d1Url,
    r2Url,
    token,
    outputDirectory: resolve(outputValue),
    checkpoint: { sourceCommitSha, sitesVersionId },
  };
}

export async function runCapture({
  args = [],
  env = process.env,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  validateImpl = validateLocally,
  log = (message) => process.stdout.write(`${message}\n`),
  hostingConfigUrl = HOSTING_CONFIG_URL,
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new PredeployBackupCaptureError(
      "A Fetch-compatible implementation is required.",
    );
  }
  const configuration = configFromEnvironment(env, args);
  const hosting = await readHostingIdentity(hostingConfigUrl);
  const previousUmask = process.umask(0o077);
  let createdOutputDirectory = false;
  let rawCaptureComplete = false;

  try {
    try {
      await mkdir(configuration.outputDirectory, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") {
        throw new PredeployBackupCaptureError(
          "Refusing to overwrite an existing backup output path.",
        );
      }
      throw error;
    }
    createdOutputDirectory = true;
    const outputStats = await lstat(configuration.outputDirectory);
    if (!outputStats.isDirectory() || outputStats.isSymbolicLink()) {
      throw new PredeployBackupCaptureError(
        "Backup output path must be a newly created real directory.",
      );
    }
    await chmod(configuration.outputDirectory, 0o700);

    const snapshot = await postJson({
      label: "D1 export",
      url: configuration.d1Url,
      token: configuration.token,
      payload: undefined,
      maximumBytes: D1_MAX_BYTES,
      fetchImpl,
    });
    assertArtifactEnvelope(snapshot, {
      format: "27pm-d1-logical-v2",
      source: { projectId: hosting.projectId, binding: hosting.d1Binding },
      checkpoint: configuration.checkpoint,
      label: "D1 export",
    });
    assertSnapshotQuiescence(snapshot);

    const inventory = await captureR2Inventory({
      url: configuration.r2Url,
      token: configuration.token,
      fetchImpl,
      now,
      expectedSource: {
        projectId: hosting.projectId,
        binding: hosting.r2Binding,
      },
      expectedCheckpoint: configuration.checkpoint,
    });

    const snapshotPath = join(configuration.outputDirectory, D1_SNAPSHOT_FILE);
    const inventoryPath = join(configuration.outputDirectory, R2_INVENTORY_FILE);
    await atomicPrivateJsonWrite(snapshotPath, snapshot);
    await atomicPrivateJsonWrite(inventoryPath, inventory);
    rawCaptureComplete = true;

    const validation = await validateImpl({
      snapshotPath,
      inventoryPath,
      outputDirectory: configuration.outputDirectory,
    });
    const result = {
      status: "validated",
      outputDirectory: configuration.outputDirectory,
      r2Pages: inventory.pageCount,
      r2Objects: inventory.objects.length,
      validation,
    };
    log(JSON.stringify(result));
    return result;
  } catch (error) {
    if (createdOutputDirectory && !rawCaptureComplete) {
      await rm(configuration.outputDirectory, {
        recursive: true,
        force: true,
      }).catch(() => {});
    }
    if (error instanceof PredeployBackupCaptureError) throw error;
    throw new PredeployBackupCaptureError("Pre-deployment backup capture failed.");
  } finally {
    process.umask(previousUmask);
  }
}

export async function captureR2Inventory({
  url,
  token,
  fetchImpl,
  now,
  expectedSource,
  expectedCheckpoint,
}) {
  const startedAt = now().toISOString();
  const objects = [];
  const objectKeys = new Set();
  const cursors = new Set();
  let cursor = null;
  let pageCount = 0;

  while (true) {
    pageCount += 1;
    if (pageCount > MAX_R2_PAGES) {
      throw new PredeployBackupCaptureError(
        "R2 inventory exceeded the page safety limit.",
      );
    }
    const page = await postJson({
      label: "R2 inventory",
      url,
      token,
      payload: cursor ? { cursor } : {},
      maximumBytes: R2_PAGE_MAX_BYTES,
      fetchImpl,
    });
    assertR2Page(page, expectedSource, expectedCheckpoint);
    for (const object of page.objects) {
      if (objectKeys.has(object.key)) {
        throw new PredeployBackupCaptureError(
          "R2 inventory returned a duplicate object key.",
        );
      }
      objectKeys.add(object.key);
      objects.push(object);
      if (objects.length > MAX_R2_OBJECTS) {
        throw new PredeployBackupCaptureError(
          "R2 inventory exceeded the object safety limit.",
        );
      }
    }

    if (!page.truncated) break;
    if (cursors.has(page.cursor)) {
      throw new PredeployBackupCaptureError(
        "R2 inventory returned a repeated pagination cursor.",
      );
    }
    cursors.add(page.cursor);
    cursor = page.cursor;
  }

  return {
    format: R2_INVENTORY_FORMAT,
    source: expectedSource,
    checkpoint: expectedCheckpoint,
    startedAt,
    completedAt: now().toISOString(),
    complete: true,
    pageCount,
    objects: objects.toSorted((left, right) => left.key.localeCompare(right.key)),
  };
}

async function postJson({
  label,
  url,
  token,
  payload,
  maximumBytes,
  fetchImpl,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    let response;
    try {
      const headers = {
        accept: "application/json",
        "accept-encoding": "identity",
        "cache-control": "no-store",
        origin: url.origin,
        "x-27pm-backup-token": token,
      };
      if (payload !== undefined) headers["content-type"] = "application/json";
      response = await fetchImpl(url.href, {
        method: "POST",
        headers,
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
        cache: "no-store",
        redirect: "error",
        signal: controller.signal,
      });
    } catch {
      throw new PredeployBackupCaptureError(`${label} request failed.`);
    }

    if (!response.ok) {
      throw new PredeployBackupCaptureError(
        `${label} returned HTTP ${response.status}.`,
      );
    }
    if (!response.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
      throw new PredeployBackupCaptureError(`${label} did not return JSON.`);
    }
    if (!response.headers.get("cache-control")?.toLowerCase().includes("no-store")) {
      throw new PredeployBackupCaptureError(
        `${label} response was not marked no-store.`,
      );
    }
    if (!response.body) {
      throw new PredeployBackupCaptureError(`${label} returned an empty body.`);
    }

    let bytes;
    try {
      bytes = await readBoundedResponseBytes(response.body, maximumBytes);
    } catch (error) {
      if (error instanceof ResponseByteLimitError) {
        throw new PredeployBackupCaptureError(
          `${label} exceeded its response size limit.`,
        );
      }
      throw new PredeployBackupCaptureError(`${label} response could not be read.`);
    }
    validateDeclaredByteCount(response.headers, bytes.byteLength, label);

    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new PredeployBackupCaptureError(`${label} returned invalid JSON.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function validateDeclaredByteCount(headers, actualBytes, label) {
  const backupByteCount = headers.get("x-27pm-backup-byte-count");
  if (
    backupByteCount === null ||
    !/^(?:0|[1-9][0-9]*)$/u.test(backupByteCount) ||
    Number(backupByteCount) !== actualBytes
  ) {
    throw new PredeployBackupCaptureError(
      `${label} returned an inconsistent backup byte count.`,
    );
  }

  const contentLength = headers.get("content-length");
  if (
    headers.get("content-encoding") === null &&
    contentLength !== null &&
    (!/^(?:0|[1-9][0-9]*)$/u.test(contentLength) ||
      Number(contentLength) !== actualBytes)
  ) {
    throw new PredeployBackupCaptureError(
      `${label} returned an inconsistent content length.`,
    );
  }
}

function assertArtifactEnvelope(value, expected) {
  if (!value || value.format !== expected.format) {
    throw new PredeployBackupCaptureError(
      `${expected.label} returned an unsupported format.`,
    );
  }
  assertSource(value.source, expected.source, expected.label);
  assertCheckpoint(value.checkpoint, expected.checkpoint, expected.label);
}

function assertR2Page(page, expectedSource, expectedCheckpoint) {
  assertArtifactEnvelope(page, {
    format: R2_INVENTORY_FORMAT,
    source: expectedSource,
    checkpoint: expectedCheckpoint,
    label: "R2 inventory",
  });
  if (!Array.isArray(page.objects) || typeof page.truncated !== "boolean") {
    throw new PredeployBackupCaptureError(
      "R2 inventory returned malformed pagination data.",
    );
  }
  if (
    page.truncated
      ? typeof page.cursor !== "string" ||
        page.cursor.length === 0 ||
        page.cursor.length > 4_096
      : page.cursor !== undefined
  ) {
    throw new PredeployBackupCaptureError(
      "R2 inventory returned an invalid pagination cursor.",
    );
  }
  for (const object of page.objects) validateR2Object(object);
}

function assertSnapshotQuiescence(snapshot) {
  if (
    !snapshot.quiescence ||
    snapshot.quiescence.dispatchingSendCommands !== 0 ||
    snapshot.quiescence.reservedWebhookReceipts !== 0
  ) {
    throw new PredeployBackupCaptureError(
      "D1 export was captured while provider work was still in flight.",
    );
  }
}

function validateR2Object(object) {
  if (
    !object ||
    typeof object.key !== "string" ||
    object.key.length === 0 ||
    object.key.includes("\0") ||
    !Number.isSafeInteger(object.size) ||
    object.size < 0
  ) {
    throw new PredeployBackupCaptureError(
      "R2 inventory returned invalid object metadata.",
    );
  }
  for (const field of ["etag", "version"]) {
    if (
      object[field] !== undefined &&
      (typeof object[field] !== "string" || object[field].length === 0)
    ) {
      throw new PredeployBackupCaptureError(
        `R2 inventory returned an invalid ${field}.`,
      );
    }
  }
  if (
    object.uploaded !== undefined &&
    (typeof object.uploaded !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(object.uploaded) ||
      Number.isNaN(Date.parse(object.uploaded)))
  ) {
    throw new PredeployBackupCaptureError(
      "R2 inventory returned an invalid upload timestamp.",
    );
  }
  if (
    object.sha256 !== undefined &&
    (typeof object.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(object.sha256))
  ) {
    throw new PredeployBackupCaptureError(
      "R2 inventory returned an invalid native SHA-256 checksum.",
    );
  }
}

function assertSource(actual, expected, label) {
  if (
    !actual ||
    actual.projectId !== expected.projectId ||
    actual.binding !== expected.binding
  ) {
    throw new PredeployBackupCaptureError(
      `${label} returned an unexpected Sites resource identity.`,
    );
  }
}

function assertCheckpoint(actual, expected, label) {
  if (
    !actual ||
    actual.sourceCommitSha !== expected.sourceCommitSha ||
    actual.sitesVersionId !== expected.sitesVersionId
  ) {
    throw new PredeployBackupCaptureError(
      `${label} returned an unexpected deployment checkpoint.`,
    );
  }
}

async function readHostingIdentity(hostingConfigUrl) {
  let value;
  try {
    value = JSON.parse(await readFile(hostingConfigUrl, "utf8"));
  } catch {
    throw new PredeployBackupCaptureError(
      "The Sites hosting configuration could not be read.",
    );
  }
  if (
    !value ||
    typeof value.project_id !== "string" ||
    !/^appgprj_[a-zA-Z0-9]+$/u.test(value.project_id) ||
    value.d1 !== "DB" ||
    value.r2 !== "BUCKET"
  ) {
    throw new PredeployBackupCaptureError(
      "The Sites hosting configuration does not identify the expected D1 and R2 bindings.",
    );
  }
  return {
    projectId: value.project_id,
    d1Binding: value.d1,
    r2Binding: value.r2,
  };
}

async function atomicPrivateJsonWrite(target, value) {
  const temporary = join(
    dirname(target),
    `.partial-${process.pid}-${crypto.randomUUID()}`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function validateLocally({ snapshotPath, inventoryPath, outputDirectory }) {
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-sqlite",
      VALIDATOR_PATH,
      snapshotPath,
      inventoryPath,
      outputDirectory,
    ],
    {
      cwd: dirname(VALIDATOR_PATH),
      encoding: "utf8",
      env: { LANG: "C", LC_ALL: "C", TZ: "UTC" },
      maxBuffer: 1 * 1_024 * 1_024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new PredeployBackupCaptureError(
      "Local restoration validation failed; captured artifacts were retained for inspection.",
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new PredeployBackupCaptureError(
      "Local restoration validator returned an invalid summary.",
    );
  }
}

function requiredExactValue(env, name) {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value !== value.trim()
  ) {
    throw new PredeployBackupCaptureError(
      `${name} is required without surrounding whitespace.`,
    );
  }
  return value;
}

function secureEndpoint(value, name, expectedPathname) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new PredeployBackupCaptureError(`${name} must be a valid HTTPS URL.`);
  }
  if (
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== expectedPathname ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new PredeployBackupCaptureError(
      `${name} must be the exact HTTPS ${expectedPathname} endpoint without credentials, query, or fragment.`,
    );
  }
  return url;
}

const isMain =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  await runCapture({ args: process.argv.slice(2) });
}
