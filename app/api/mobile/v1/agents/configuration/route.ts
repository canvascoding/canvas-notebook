import { NextRequest } from 'next/server';
import { readMobileAgentConfiguration, createMobileAgentConfiguration, updateMobileAgentConfiguration } from '@/app/lib/mobile/extension-context-v2';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request, ['agentId', 'includeFiles', 'includeAccess']);
    return await readMobileAgentConfiguration(context, request);
  } catch (error) { return mobileScopedError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request);
    return await createMobileAgentConfiguration(context, request);
  } catch (error) { return mobileScopedError(error); }
}

export async function PATCH(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request);
    return await updateMobileAgentConfiguration(context, request);
  } catch (error) { return mobileScopedError(error); }
}
