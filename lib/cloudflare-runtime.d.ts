declare module "cloudflare:workers" {
  export const env: Record<string, unknown> & {
    DB?: unknown;
    BUCKET?: unknown;
  };
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface D1Database {
  readonly __d1Brand?: never;
}
