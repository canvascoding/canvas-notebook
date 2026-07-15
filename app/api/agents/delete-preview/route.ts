import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { managementErrorDetails, previewManagedAgentDeletion } from '@/app/lib/agents/management-actions';
import { rateLimit } from '@/app/lib/utils/rate-limit';

export async function POST(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 20, windowMs: 60_000, keyPrefix: 'agents-delete-preview' });
  if (!limited.ok) return limited.response;

  try {
    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const agentId = typeof payload.agentId === 'string' ? payload.agentId : '';
    const data = await previewManagedAgentDeletion({
      userId: session.user.id,
      sessionId: session.session.id,
      source: 'api',
      organizationId: request.nextUrl.searchParams.get('organizationId'),
      workspaceId: request.nextUrl.searchParams.get('workspaceId'),
      projectId: request.nextUrl.searchParams.get('projectId'),
    }, agentId);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const details = managementErrorDetails(error);
    return NextResponse.json(
      { success: false, code: details.code, error: details.message, ...(details.details || {}) },
      { status: details.status },
    );
  }
}
