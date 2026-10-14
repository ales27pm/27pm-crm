/** Cloudflare Worker entry point for the vinext-starter template. */
import { handleImageOptimization, DEFAULT_DEVICE_SIZES, DEFAULT_IMAGE_SIZES } from "vinext/server/image-optimization";
import handler from "vinext/server/app-router-entry";
import { handleAttachmentDownloadRequest } from "../lib/attachment-download-worker";
import type { AttachmentDownloadEnvironment } from "../lib/attachment-download-worker";
import { prepareInternalApiRequest } from "../lib/internal-api-edge";
import type { InternalApiNonceDatabase } from "../lib/internal-api-nonce-store";
import {
  isAllowedDuringPredeployBackup,
  isPredeployBackupFreezeActive,
  PREDEPLOY_BACKUP_PATHS,
  predeployMaintenanceResponse,
} from "../lib/predeploy-backup";

interface Env {
  ASSETS: Fetcher;
  DB: D1Database &
    InternalApiNonceDatabase &
    AttachmentDownloadEnvironment["DB"];
  BUCKET: AttachmentDownloadEnvironment["BUCKET"];
  IMAGES: {
    input(stream: ReadableStream): {
      transform(options: Record<string, unknown>): {
        output(options: { format: string; quality: number }): Promise<{ response(): Response }>;
      };
    };
  };
  CRM_API_AUTH_MODE?: string;
  CRM_ATTACHMENT_DOWNLOAD_ORIGIN?: string;
  CRM_ATTACHMENT_DOWNLOAD_SIGNING_KEY?: string;
  CRM_INTERNAL_API_AUDIENCE?: string;
  CRM_INTERNAL_API_SIGNING_KEY?: string;
  CRM_SITES_TRUSTED_ORIGIN?: string;
  CRM_PREDEPLOY_BACKUP_MODE?: string;
  CRM_PREDEPLOY_BACKUP_EXPIRES_AT?: string;
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
    // Freeze before attachment consumption or HMAC nonce writes. The two backup
    // routes retain their own short-lived token and exact-origin authorization.
    const backupPath = new URL(request.url).pathname;
    if (isPredeployBackupFreezeActive(
      env.CRM_PREDEPLOY_BACKUP_MODE,
      env.CRM_PREDEPLOY_BACKUP_EXPIRES_AT,
    )) {
      if (!isAllowedDuringPredeployBackup(request.method, backupPath)) {
        return withSecurityHeaders(predeployMaintenanceResponse());
      }
      return withSecurityHeaders(await handler.fetch(request, env, ctx));
    }
    if (PREDEPLOY_BACKUP_PATHS.has(backupPath)) {
      // An expired or missing window must never fall through into ordinary auth.
      return withSecurityHeaders(new Response(null, { status: 404 }));
    }
    const attachmentDownload = await handleAttachmentDownloadRequest(
      request,
      env,
      new Date(),
      ctx,
    );
    if (attachmentDownload) return withSecurityHeaders(attachmentDownload);

    const preparedRequest = await prepareInternalApiRequest(request, env, ctx);
    if (preparedRequest instanceof Response) {
      return withSecurityHeaders(preparedRequest);
    }
    request = preparedRequest;
    const url = new URL(request.url);

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
