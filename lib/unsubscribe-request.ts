import { boundedRequest } from "./bounded-request";

export type UnsubscribeRequestPayload = {
  token: string;
  scope: "global" | "category";
  category: "all" | "prospecting";
  oneClick: boolean;
};

export async function parseUnsubscribeRequest(
  request: Request,
): Promise<UnsubscribeRequestPayload | null> {
  const bounded = await boundedRequest(request, 8_192);
  if (!bounded) return null;
  const contentType = request.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(await bounded.text());
    const entries = [...form.entries()];
    const oneClick = oneClickPayload(request, entries);
    if (oneClick) return oneClick;

    return normalizeConfirmationPayload(
      form.get("token"),
      form.get("scope"),
      form.get("category"),
    );
  }

  if (contentType.includes("multipart/form-data")) {
    const form = await bounded.formData().catch(() => null);
    if (!form) return null;
    return oneClickPayload(request, [...form.entries()]);
  }

  if (contentType.includes("application/json")) {
    const json = (await bounded.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    return normalizeConfirmationPayload(json.token, json.scope, json.category);
  }

  return null;
}

function oneClickPayload(
  request: Request,
  entries: Array<[string, unknown]>,
): UnsubscribeRequestPayload | null {
  if (
    entries.length !== 1 ||
    entries[0]?.[0] !== "List-Unsubscribe" ||
    entries[0]?.[1] !== "One-Click"
  ) {
    return null;
  }
  const token = new URL(request.url).searchParams.get("token") ?? "";
  return validUnsubscribeTokenShape(token)
    ? { token, scope: "global", category: "all", oneClick: true }
    : null;
}

export function validUnsubscribeTokenShape(token: string): boolean {
  return (
    token.length >= 32 &&
    token.length <= 2_048 &&
    /^[A-Za-z0-9._-]+$/u.test(token)
  );
}

function normalizeConfirmationPayload(
  token: unknown,
  scope: unknown,
  category: unknown,
): UnsubscribeRequestPayload | null {
  if (typeof token !== "string" || !validUnsubscribeTokenShape(token)) {
    return null;
  }
  if (scope !== "global" && scope !== "category") return null;
  const normalizedCategory =
    scope === "global"
      ? "all"
      : category === "prospecting"
        ? "prospecting"
        : null;
  return normalizedCategory
    ? {
        token,
        scope,
        category: normalizedCategory,
        oneClick: false,
      }
    : null;
}
