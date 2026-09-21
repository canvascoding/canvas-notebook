import { NextRequest, NextResponse } from 'next/server';

import { auth } from '@/app/lib/auth';
import { readOrganizationPermissionForUser } from '@/app/lib/organization/permissions';
import { decideMemoryReview, readMemoryReview } from '@/app/lib/memory/service';
import type { MemoryReviewDecision, MemoryScopeType } from '@/app/lib/memory/contract';

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required.`);
  return value.trim();
}

async function reviewScope(request: NextRequest, userId: string, payload: Record<string, unknown>) {
  const scope = requiredString(payload.scope ?? request.nextUrl.searchParams.get('scope'), 'scope') as MemoryScopeType;
  if (scope !== 'workspace' && scope !== 'organization') throw new Error('Memory reviews require a workspace or organization scope.');
  if (scope === 'workspace') {
    return { target: scope, userId, workspaceId: requiredString(payload.workspaceId ?? request.nextUrl.searchParams.get('workspaceId'), 'workspaceId') } as const;
  }
  const organization = await readOrganizationPermissionForUser(userId);
  if (!organization.organizationId) throw new Error('Organization memory is not configured.');
  return { target: scope, userId, organizationId: organization.organizationId } as const;
}

async function sessionFor(request: NextRequest) {
  return auth.api.getSession({ headers: request.headers });
}

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFor(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  try {
    const { id } = await context.params;
    const scope = await reviewScope(request, session.user.id, {});
    return NextResponse.json({ success: true, data: await readMemoryReview({ ...scope, id }) });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to load memory review.';
    return NextResponse.json({ success: false, error: message }, { status: message.includes('not found') ? 404 : 400 });
  }
}

export async function PATCH(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const session = await sessionFor(request);
  if (!session) return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
  const payload = await request.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload) return NextResponse.json({ success: false, error: 'Invalid JSON body.' }, { status: 400 });
  try {
    const decision = requiredString(payload.decision, 'decision') as MemoryReviewDecision;
    if (decision !== 'approve' && decision !== 'reject') throw new Error('decision must be approve or reject.');
    const expectedRevision = Number(payload.expectedRevision);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error('expectedRevision must be a positive integer.');
    const { id } = await context.params;
    const scope = await reviewScope(request, session.user.id, payload);
    const result = await decideMemoryReview({ ...scope, id, decision, expectedRevision });
    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unable to decide memory review.';
    const status = message.includes('stale') || message.includes('already been decided') ? 409 : 400;
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
