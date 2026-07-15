import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import {
  inspectManagedAgent,
  managementErrorDetails,
  removeManagedAgentGrant,
  setManagedAgentGrant,
  type AgentManagementActor,
} from '@/app/lib/agents/management-actions';
import type { AgentGrantTargetType } from '@/app/lib/agents/grants';
import { rateLimit } from '@/app/lib/utils/rate-limit';

function actor(request: NextRequest, userId: string, sessionId: string): AgentManagementActor {
  return {
    userId,
    sessionId,
    source: 'api',
    organizationId: request.nextUrl.searchParams.get('organizationId'),
    workspaceId: request.nextUrl.searchParams.get('workspaceId'),
    projectId: request.nextUrl.searchParams.get('projectId'),
  };
}

function responseError(error: unknown) {
  const details = managementErrorDetails(error);
  return NextResponse.json(
    { success: false, code: details.code, error: details.message, ...(details.details || {}) },
    { status: details.status },
  );
}

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const agentId = request.nextUrl.searchParams.get('agentId') || '';
    const data = await inspectManagedAgent(actor(request, session.user.id, session.session.id), agentId, { includeAccess: true });
    return NextResponse.json({ success: true, data: { agent: data.agent, grants: data.grants || [] } });
  } catch (error) {
    return responseError(error);
  }
}

export async function PUT(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'agents-grants-put' });
  if (!limited.ok) return limited.response;
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const data = await setManagedAgentGrant({
      actor: actor(request, session.user.id, session.session.id),
      agentId: typeof payload.agentId === 'string' ? payload.agentId : '',
      expectedRevision: typeof payload.expectedRevision === 'number' ? payload.expectedRevision : 0,
      targetType: payload.targetType as AgentGrantTargetType,
      targetId: typeof payload.targetId === 'string' ? payload.targetId : '',
      canUse: payload.canUse === true,
      canEdit: payload.canEdit === true,
      canManage: payload.canManage === true,
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return responseError(error);
  }
}

export async function DELETE(request: NextRequest) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const limited = rateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'agents-grants-delete' });
  if (!limited.ok) return limited.response;
  try {
    const payload = (await request.json()) as Record<string, unknown>;
    const data = await removeManagedAgentGrant({
      actor: actor(request, session.user.id, session.session.id),
      agentId: typeof payload.agentId === 'string' ? payload.agentId : '',
      expectedRevision: typeof payload.expectedRevision === 'number' ? payload.expectedRevision : 0,
      targetType: payload.targetType as AgentGrantTargetType,
      targetId: typeof payload.targetId === 'string' ? payload.targetId : '',
    });
    return NextResponse.json({ success: true, data });
  } catch (error) {
    return responseError(error);
  }
}
