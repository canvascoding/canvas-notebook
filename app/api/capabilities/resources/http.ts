import 'server-only';

import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { CapabilityResourceError, type CapabilityResourceActor } from '@/app/lib/capabilities/resources/contracts';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';

export async function resourceRequestActor(request: Request): Promise<CapabilityResourceActor | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, code: 'unauthorized', error: 'Sign in to manage resources.' }, { status: 401 });
  const workspaceId = request.headers.get(WORKSPACE_ID_HEADER)?.trim()
    || new URL(request.url).searchParams.get('workspaceId')?.trim() || null;
  if (workspaceId && workspaceId.length > 256) throw new CapabilityResourceError('invalid_request', 'Invalid workspace selection.');
  return { userId: session.user.id, workspaceId };
}

export async function resourceRequestJson(request: Request): Promise<unknown> {
  try { return await request.json(); }
  catch { throw new CapabilityResourceError('invalid_request', 'The resource request must contain valid JSON.'); }
}

export function resourceResponseError(error: unknown): NextResponse {
  if (error instanceof CapabilityResourceError) {
    return NextResponse.json({ success: false, code: error.code, error: error.message }, { status: error.status });
  }
  if (error instanceof Error && error.name === 'ZodError') {
    return NextResponse.json({ success: false, code: 'invalid_request', error: 'Invalid resource management request.' }, { status: 400 });
  }
  console.error('[CapabilityResources] Request failed.', { errorType: error instanceof Error ? error.name : 'UnknownError' });
  return NextResponse.json({ success: false, code: 'resource_unavailable', error: 'Resource management is currently unavailable.' }, { status: 500 });
}

export function resourceResponse(data: Record<string, unknown>): NextResponse {
  return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
}
