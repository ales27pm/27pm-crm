import { crmDatabase } from "@/lib/d1";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";
import { readMobileAuthJson } from "@/lib/mobile-auth";
import { revokeMobileSession } from "@/lib/mobile-auth-store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const payload = await readMobileAuthJson(request);
  if (!payload) return privateJsonError(400, "invalid_request");
  try {
    await revokeMobileSession(crmDatabase(), {
      refreshToken: payload.refreshToken,
    });
    return new Response(null, {
      status: 204,
      headers: privateNoStoreHeaders(),
    });
  } catch {
    return privateJsonError(503, "mobile_logout_unavailable");
  }
}
