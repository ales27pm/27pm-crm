// Native Vercel builds analyze every route module even though proxy.ts sends
// /api traffic to the Cloudflare data plane. An empty binding object keeps that
// analysis fail-closed: any accidental local execution still throws through
// the existing binding checks instead of touching a different data source.
export const env: Record<string, never> = {};
