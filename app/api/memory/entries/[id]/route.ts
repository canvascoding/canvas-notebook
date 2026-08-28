import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { deleteMemory, publishMemory, readMemoryEntryHistory, updateMemory } from '@/app/lib/memory/service';
import { normalizeManagedAgentId } from '@/app/lib/agents/registry';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';

function normalizedString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function scopeFromPayload(request: NextRequest, userId: string, payload: Record<string, unknown>) {
  const target = normalizedString(payload.scope) ?? 'user';
  if (target === 'user') return { target: 'user' as const, userId };
  if (target === 'agent') return { target: 'agent' as const, userId, agentId: normalizeManagedAgentId(normalizedString(payload.agentId)) };
  if (target === 'workspace') {
    const workspaceId = normalizedString(payload.workspaceId);
    if (!workspaceId) throw new Error('workspaceId is required for workspace memory.');
    return { target: 'workspace' as const, userId, workspaceId };
  }
  if (target === 'organization') {
    const organization = await readOrganizationPermissionForUser(userId);
    if (!organization.organizationId) throw new Error('Organization memory is not configured.');
    return { target: 'organization' as const, userId, organizationId: organization.organizationId };
  }
  throw new Error('Invalid memory scope.');
}

async function sessionFor(request: NextRequest) {
  return auth.api.getSession({ headers: request.headers });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFor(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const { id } = await context.params;
    const scope = await scopeFromPayload(request, session.user.id, Object.fromEntries(request.nextUrl.searchParams.entries()));
    return NextResponse.json({ success: true, data: await readMemoryEntryHistory({ ...scope, id }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load memory history.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFor(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  try {
    const { id } = await context.params;
    const scope = await scopeFromPayload(request, session.user.id, payload);
    const result = payload.action === 'publish'
      ? await publishMemory({ ...scope, id })
      : await updateMemory({ ...scope, id, content: String(payload.content ?? '') });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to update memory.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFor(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const { id } = await context.params;
    const scope = await scopeFromPayload(request, session.user.id, Object.fromEntries(request.nextUrl.searchParams.entries()));
    const result = await deleteMemory({ ...scope, id });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to archive memory.';
    return NextResponse.json({ success: false, error: message }, { status: 400 });
  }
}
