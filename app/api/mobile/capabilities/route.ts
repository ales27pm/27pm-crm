import { requireOperatorOrMobileRequest } from "@/lib/api-auth";
import { privateJsonError, privateNoStoreHeaders } from "@/lib/http";
import { mobileBearerToken } from "@/lib/mobile-auth";

export const dynamic = "force-dynamic";

/** A probe is not permission to drain the iPhone's local attachment queue. */
export async function GET(request: Request) {
  // Native capabilities require a current device session, not a browser identity.
  if (!mobileBearerToken(request)) return privateJsonError(401, "authentication_required");
  const auth = await requireOperatorOrMobileRequest(request, "crm:dashboard:read");
  if (auth.response) return auth.response;

  // The 20 MiB same-host transport, native storage migration and private scanner
  // are not deployed. Never infer readiness from an environment flag alone.
  // Replace this negative capability only with the reviewed readiness probe when
  // those three production boundaries have passed their acceptance checks.
  return Response.json({ attachments: false }, {
    headers: { ...privateNoStoreHeaders(), vary: "Authorization" },
  });
}
