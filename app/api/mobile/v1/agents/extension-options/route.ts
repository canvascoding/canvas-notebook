import { NextRequest } from 'next/server';
import { readMobileAgentExtensionOptions } from '@/app/lib/mobile/extension-context-v2';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request);
    return await readMobileAgentExtensionOptions(context, request);
  } catch (error) { return mobileScopedError(error); }
}
