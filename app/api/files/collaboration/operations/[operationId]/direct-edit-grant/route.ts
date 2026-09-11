import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit } from '@/app/lib/api/route-helpers';
import { isAgentDatabaseCapacityError } from '@/app/lib/collaboration/agent-database-capacity';
import {
  AgentDirectEditGrantUnavailableError,
  getAgentDirectEditGrantForOperation,
  setAgentDirectEditGrantForOperation,
} from '@/app/lib/collaboration/agent-direct-edit-grants';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

type RouteContext = { params: Promise<{ operationId: string }> };

function failure(error: unknown) {
  if (isAgentDatabaseCapacityError(error)) {
    return NextResponse.json({ success: false, code: error.code, error: 'Agent editing is busy. Please try again.' },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '5' } });
  }
  return NextResponse.json({ success: false,
    code: error instanceof AgentDirectEditGrantUnavailableError ? error.code : 'direct_edit_grant_failed',
    error: error instanceof AgentDirectEditGrantUnavailableError ? error.message : 'Could not update direct editing permission.',
  }, { status: 409, headers: { 'Cache-Control': 'no-store' } });
}

export async function GET(request: NextRequest, context: RouteContext) {
  const authorized = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (authorized.response) return authorized.response;
  try {
    const result = await getAgentDirectEditGrantForOperation({
      operationId: (await context.params).operationId,
      workspace: authorized.workspace, userId: authorized.session.user.id,
    });
    return NextResponse.json({ success: true, ...result }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  // Revocation remains available after write/agent permissions are withdrawn.
  const authorized = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (authorized.response) return authorized.response;
  const limited = applyRateLimit(request, { limit: 30, windowMs: 60_000, keyPrefix: 'collaboration-direct-edit-grant' });
  if (limited) return limited;
  let body: unknown;
  try { body = await request.json(); } catch { body = null; }
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => key !== 'action' && key !== 'idempotencyKey')
    || !('action' in body) || (body.action !== 'grant' && body.action !== 'revoke')
    || !('idempotencyKey' in body) || typeof body.idempotencyKey !== 'string'
    || !body.idempotencyKey.trim() || body.idempotencyKey.length > 200) {
    return NextResponse.json({ success: false,
      error: 'Only action (grant or revoke) and an idempotency key of at most 200 characters are accepted.',
    }, { status: 400 });
  }
  try {
    const grant = await setAgentDirectEditGrantForOperation({
      operationId: (await context.params).operationId,
      workspace: authorized.workspace, userId: authorized.session.user.id,
      action: body.action, idempotencyKey: body.idempotencyKey,
    });
    return NextResponse.json({ success: true, grant }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return failure(error);
  }
}
