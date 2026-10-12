import 'server-only';

import { NextResponse } from 'next/server';
import { auth } from '@/app/lib/auth';
import { WORKSPACE_ID_HEADER } from '@/app/lib/workspaces/constants';
import { IntegrationConnectionError, type IntegrationConnectionActor } from './contracts';

export type IntegrationDesktopRequestInitiator = { actor: IntegrationConnectionActor; authSessionId: string };

/** Capture a human actor and authentication session from one verified response. Fresh resource rights remain in CommonStore. */
export async function captureIntegrationDesktopRequestInitiator(request: Request,
  options: { allowEmptyWorkspace?: boolean } = {}): Promise<IntegrationDesktopRequestInitiator | NextResponse> {
  const session = await auth.api.getSession({ headers: request.headers });
  const expiresAt = session?.session ? new Date(session.session.expiresAt).getTime() : Number.NaN;
  if (!session || typeof session.session?.id !== 'string' || !session.session.id.trim()
    || session.session.userId !== session.user.id || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return NextResponse.json({ success: false, code: 'unauthorized', error: 'Sign in to manage shared sign-in.' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } });
  }
  const query = new URL(request.url).searchParams;
  if (query.getAll('workspaceId').length > 1) {
    throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Supply one workspace selection.', 400);
  }
  const rawHeader = request.headers.get(WORKSPACE_ID_HEADER), rawQuery = query.get('workspaceId');
  if (!options.allowEmptyWorkspace && (rawHeader !== null && !rawHeader.trim() || rawQuery !== null && !rawQuery.trim())) {
    throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Invalid workspace selection.', 400);
  }
  const headerWorkspaceId = rawHeader?.trim() || null, queryWorkspaceId = rawQuery?.trim() || null;
  if (headerWorkspaceId && queryWorkspaceId && headerWorkspaceId !== queryWorkspaceId) {
    throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Workspace selections do not match.', 400);
  }
  const workspaceId = headerWorkspaceId || queryWorkspaceId;
  if (workspaceId && (workspaceId.length > 200 || /[\x00-\x1f\x7f]/u.test(workspaceId))) {
    throw new IntegrationConnectionError('CONNECTION_REQUEST_INVALID', 'Invalid workspace selection.', 400);
  }
  return { actor: { userId: session.user.id, workspaceId }, authSessionId: session.session.id };
}
