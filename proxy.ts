import { auth } from "@/auth";
import {
  fetchPreparedVercelApiRequest,
  prepareVercelApiRequest,
} from "@/lib/vercel-api-proxy";

export const proxy = auth(async (request) => {
  const prepared = await prepareVercelApiRequest(
    request,
    request.auth?.user?.email,
    {
      apiOrigin: process.env.CRM_API_ORIGIN,
      audience: process.env.CRM_INTERNAL_API_AUDIENCE,
      operatorAllowlist: process.env.CRM_ADMIN_EMAILS,
      signingKey: process.env.CRM_INTERNAL_API_SIGNING_KEY,
    },
  );
  if (prepared instanceof Response) return prepared;
  return fetchPreparedVercelApiRequest(request, prepared);
});

export const config = {
  matcher: ["/api/((?!auth(?:/|$)).*)"],
};
