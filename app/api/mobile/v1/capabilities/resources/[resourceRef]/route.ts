import { NextRequest } from 'next/server';
import { requireMobileScopedContext, mobileScopedError } from '@/app/lib/mobile/scoped-route-v2';
import { readMobileCapabilityResource,writeMobileCapabilityResource } from '@/app/lib/mobile/scoped-resources-v2';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
type Params = { params: Promise<{ resourceRef: string }> };

export async function GET(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, []);
    const reference = (await params.params).resourceRef;
    return await readMobileCapabilityResource(context, reference);
  } catch (error) { return mobileScopedError(error); }
}

export async function POST(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, []);
    const reference = (await params.params).resourceRef;
    return await writeMobileCapabilityResource(context, request, reference, true);
  } catch (error) { return mobileScopedError(error); }
}

export async function PATCH(request: NextRequest, params: Params) {
  try {
    const context = await requireMobileScopedContext(request, []);
    const reference = (await params.params).resourceRef;
    return await writeMobileCapabilityResource(context, request, reference);
  } catch (error) { return mobileScopedError(error); }
}
