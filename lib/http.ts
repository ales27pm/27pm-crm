export function jsonError(
  status: number,
  code: string,
  detail?: string,
): Response {
  return Response.json(
    detail ? { error: code, detail } : { error: code },
    { status },
  );
}

export function privateJsonError(status: number, error: string): Response {
  return Response.json(
    { error },
    { status, headers: privateNoStoreHeaders() },
  );
}

export function privateNoStoreHeaders(): HeadersInit {
  return {
    "cache-control": "private, no-store",
    "referrer-policy": "no-referrer",
  };
}

export function isSameOriginBrowserRequest(request: Request): boolean {
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin") return false;

  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

export async function readJsonObject(
  request: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function optionalTrimmedString(
  value: unknown,
  maximumLength: number,
): string | null | undefined {
  if (value === null) return null;
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (normalized.length > maximumLength) return undefined;
  return normalized || null;
}

export function validIsoTimestamp(value: unknown): string | null | undefined {
  const candidate = optionalTrimmedString(value, 64);
  if (candidate === null || candidate === undefined) return candidate;
  const date = new Date(candidate);
  return Number.isNaN(date.valueOf()) ? undefined : date.toISOString();
}
