import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { readMobileSharedConnectionTargets } from '@/app/lib/mobile/scoped-resources-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Params = { params: Promise<{ connectionRef: string }> };

export async function GET(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, []);
    const reference = (await params.params).connectionRef;
    return await readMobileSharedConnectionTargets(context, reference);
  } catch (error) { return mobileScopedError(error); }
}
