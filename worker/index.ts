/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleAttachmentDownloadRequest } from "../lib/attachment-download-worker";
import type { AttachmentDownloadEnvironment } from "../lib/attachment-download-worker";
import { prepareInternalApiRequest } from "../lib/internal-api-edge";
import type { InternalApiNonceDatabase } from "../lib/internal-api-nonce-store";
import { handleAttachmentV2Request } from "../lib/attachment-v2-worker";
import type { AttachmentV2Environment } from "../lib/attachment-v2-worker";

import {
  isAllowedDuringPredeployBackup,
  isPredeployBackupFreeze,
  predeployMaintenanceResponse,
} from "../lib/predeploy-backup";

interface Env extends AttachmentV2Environment {
  ASSETS: Fetcher;
  DB: D1Database &
    InternalApiNonceDatabase &
    AttachmentDownloadEnvironment["DB"] & AttachmentV2Environment["DB"];
  BUCKET: AttachmentDownloadEnvironment["BUCKET"] & AttachmentV2Environment["BUCKET"];
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  CRM_PREDEPLOY_BACKUP_MODE?: string;
  CRM_API_AUTH_MODE?: string;
  CRM_ATTACHMENT_DOWNLOAD_ORIGIN?: string;
  CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY?: string;
  CRM_INTERNAL_API_AUDIENCE?: string;
  CRM_INTERNAL_API_SIGNING_KEY?: string;
  CRM_SITES_TRUSTED_ORIGIN?: string;
  CRM_SITES_MCP_ORIGIN?: string;
}

interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

// Image security config. SVG sources with .svg extension auto-skip the
// optimization endpoint on the client side (served directly, no proxy).
// To route SVGs through the optimizer (with security headers), set
// dangerouslyAllowSVG: true in next.config.js and uncomment below:
// const imageConfig: ImageConfig = { dangerouslyAllowSVG: true };

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (isPredeployBackupFreeze(env.CRM_PREDEPLOY_BACKUP_MODE)) {
      if (!isAllowedDuringPredeployBackup(request.method, url.pathname)) {
        return withSecurityHeaders(predeployMaintenanceResponse());
      }
      // Backup routes authenticate their own short-lived credential; health is
      // public. Skip attachment handlers and nonce writes while frozen.
      return withSecurityHeaders(await handler.fetch(request, env, ctx));
    }

    const attachmentDownload = await handleAttachmentDownloadRequest(
      request,
      env,
      new Date(),
      ctx,
    );
    if (attachmentDownload) return withSecurityHeaders(attachmentDownload);

    // Each v2 route verifies its own narrow mobile or machine identity. It
    // never converts a scanner credential into an operator identity.
    const attachmentV2 = await handleAttachmentV2Request(request, env);
    if (attachmentV2) return withSecurityHeaders(attachmentV2);

    const preparedRequest = await prepareInternalApiRequest(request, env, ctx);
    if (preparedRequest instanceof Response) {
      return withSecurityHeaders(preparedRequest);
    }
    request = preparedRequest;

    if (url.pathname === "/_vinext/image") {
      const allowedWidths = [...DEFAULT_DEVICE_SIZES, ...DEFAULT_IMAGE_SIZES];
      const response = await handleImageOptimization(request, {
        fetchAsset: (path) => env.ASSETS.fetch(new Request(new URL(path, request.url))),
        transformImage: async (body, { width, format, quality }) => {
          const result = await env.IMAGES.input(body).transform(width > 0 ? { width } : {}).output({ format, quality });
          return result.response();
        },
      }, allowedWidths);
      return withSecurityHeaders(response);
    }

    return withSecurityHeaders(await handler.fetch(request, env, ctx));
  },
};

function withSecurityHeaders(response: Response): Response {
  const secured = new Response(response.body, response);
  secured.headers.set("permissions-policy", "camera=(), geolocation=(), microphone=()");
  if (secured.headers.get("referrer-policy") !== "no-referrer") {
    secured.headers.set("referrer-policy", "same-origin");
  }
  secured.headers.set("x-content-type-options", "nosniff");
  secured.headers.set("x-frame-options", "DENY");
  secured.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return secured;
}

export default worker;
