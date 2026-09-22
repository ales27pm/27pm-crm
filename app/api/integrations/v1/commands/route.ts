import { crmDatabase } from '@/lib/d1';
import { handleIntegration } from '@/lib/integration';
import { runtimeString } from '@/lib/runtime';
export const dynamic = 'force-dynamic';
export async function POST(request: Request) {
  return handleIntegration(request, crmDatabase(), {
    token: runtimeString('CRM_INTEGRATION_TOKEN'),
    scopes: runtimeString('CRM_INTEGRATION_SCOPES'),
    subject: runtimeString('CRM_INTEGRATION_SUBJECT'),
  });
}
