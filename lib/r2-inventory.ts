import type { PrivateObjectBucket } from "./runtime";
import { r2BackupSource, type BackupSource } from "./backup-source";

export const R2_INVENTORY_FORMAT = "27pm-r2-inventory-v1";
export const R2_INVENTORY_PAGE_LIMIT = 1_000;

export type R2InventoryPage = {
  format: typeof R2_INVENTORY_FORMAT;
  source: BackupSource;
  objects: Array<{
    key: string;
    size: number;
    etag?: string;
    version?: string;
    uploaded?: string;
    sha256?: string;
  }>;
  truncated: boolean;
  cursor?: string;
};

export function parseR2InventoryCursor(
  payload: Record<string, unknown> | null,
): string | null | undefined {
  if (!payload) return undefined;
  if (Object.keys(payload).some((key) => key !== "cursor")) return undefined;
  if (!("cursor" in payload) || payload.cursor === null) return null;
  if (
    typeof payload.cursor !== "string" ||
    payload.cursor.length === 0 ||
    payload.cursor.length > 4_096
  ) {
    return undefined;
  }
  return payload.cursor;
}

export async function buildR2InventoryPage(
  bucket: PrivateObjectBucket,
  cursor: string | null,
): Promise<R2InventoryPage> {
  const listed = await bucket.list({
    limit: R2_INVENTORY_PAGE_LIMIT,
    ...(cursor ? { cursor } : {}),
  });
  if (!Array.isArray(listed.objects) || typeof listed.truncated !== "boolean") {
    throw new Error("R2 returned an invalid inventory page.");
  }

  const nextCursor = listed.truncated ? listed.cursor : undefined;
  if (
    listed.truncated &&
    (typeof nextCursor !== "string" || !nextCursor || nextCursor.length > 4_096)
  ) {
    throw new Error("R2 returned a truncated page without a valid cursor.");
  }

  const objects = listed.objects.map((object) => {
    if (
      !object ||
      typeof object.key !== "string" ||
      !object.key ||
      !Number.isSafeInteger(object.size) ||
      object.size < 0
    ) {
      throw new Error("R2 returned invalid object metadata.");
    }

    const sha256 = nativeSha256Hex(object.checksums?.sha256);
    const uploaded = normalizeUploadedAt(object.uploaded);
    return {
      key: object.key,
      size: object.size,
      ...(nonEmptyString(object.etag) ? { etag: object.etag } : {}),
      ...(nonEmptyString(object.version) ? { version: object.version } : {}),
      ...(uploaded ? { uploaded } : {}),
      ...(sha256 ? { sha256 } : {}),
    };
  });

  return {
    format: R2_INVENTORY_FORMAT,
    source: r2BackupSource(),
    objects,
    truncated: listed.truncated,
    ...(nextCursor ? { cursor: nextCursor } : {}),
  };
}

function nativeSha256Hex(value: ArrayBuffer | ArrayBufferView | undefined): string | null {
  if (value === undefined) return null;
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.byteLength !== 32) {
    throw new Error("R2 returned an invalid native SHA-256 checksum.");
  }
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeUploadedAt(value: Date | string | undefined): string | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("R2 returned an invalid upload timestamp.");
  }
  return date.toISOString();
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
