import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { readMobileSharedConnections,writeMobileSharedConnection } from '@/app/lib/mobile/scoped-resources-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request, ['source', 'scope']);
    return await readMobileSharedConnections(context, request);
  } catch (error) { return mobileScopedError(error); }
}

export async function POST(request: NextRequest) {
  try {
    const context = await requireMobileScopedContext(request, []);
    return await writeMobileSharedConnection(context, request);
  } catch (error) { return mobileScopedError(error); }
}
