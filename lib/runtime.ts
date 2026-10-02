import "server-only";

import { env } from "cloudflare:workers";

type RuntimeBindings = Record<string, unknown>;

export interface PrivateObjectBody {
  body: ReadableStream<Uint8Array>;
  httpEtag?: string;
}

export interface PrivateObjectMetadata {
  key: string;
  size: number;
  etag?: string;
  version?: string;
  uploaded?: Date | string;
  checksums?: {
    sha256?: ArrayBuffer | ArrayBufferView;
  };
}

export interface PrivateObjectBucket {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | Blob | ReadableStream,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<unknown>;
  get(key: string): Promise<PrivateObjectBody | null>;
  list(options?: {
    cursor?: string;
    limit?: number;
  }): Promise<{
    objects: PrivateObjectMetadata[];
    truncated: boolean;
    cursor?: string;
  }>;
}

function bindings(): RuntimeBindings {
  return env as unknown as RuntimeBindings;
}

export function runtimeString(name: string): string | null {
  const bound = bindings()[name];
  if (typeof bound === "string" && bound.trim()) return bound.trim();

  const local = typeof process !== "undefined" ? process.env[name] : undefined;
  return local?.trim() || null;
}

export function requireRuntimeString(name: string): string {
  const value = runtimeString(name);
  if (!value) throw new Error(`Runtime value ${name} is unavailable.`);
  return value;
}

export function getPrivateObjectBucket(): PrivateObjectBucket {
  const bucket = bindings().BUCKET;
  if (!bucket) throw new Error("Cloudflare R2 binding `BUCKET` is unavailable.");
  return bucket as PrivateObjectBucket;
}
