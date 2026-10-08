import type { NextConfig } from "next";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(fileURLToPath(import.meta.url));
const isVercelTarget = process.env.CRM_DEPLOY_TARGET === "vercel";
const cloudflareWorkersStub = path.join(
  projectRoot,
  "lib/cloudflare-workers-vercel.ts",
);

// Keep the native Next.js/Vercel response policy aligned with the Cloudflare
// Worker in worker/index.ts. The Worker remains the source of these headers for
// the existing Sites deployment; this rule covers the parallel Vercel runtime.
const securityHeaders = [
  {
    key: "Permissions-Policy",
    value: "camera=(), geolocation=(), microphone=()",
  },
  {
    key: "Referrer-Policy",
    value: "same-origin",
  },
  {
    key: "X-Content-Type-Options",
    value: "nosniff",
  },
  {
    key: "X-Frame-Options",
    value: "DENY",
  },
  {
    key: "X-Robots-Tag",
    value: "noindex, nofollow, noarchive",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/:path*",
        headers: securityHeaders,
      },
    ];
  },
  ...(isVercelTarget
    ? {
        // API requests are rewritten by proxy.ts to the Cloudflare data plane.
        // The native build still analyzes the legacy route modules, so replace
        // only their unavailable platform import with a fail-closed empty env.
        turbopack: {
          resolveAlias: {
            "cloudflare:workers": "./lib/cloudflare-workers-vercel.ts",
          },
        },
        webpack(config) {
          config.resolve.alias["cloudflare:workers"] = cloudflareWorkersStub;
          return config;
        },
      }
    : {}),
};

export default nextConfig;
