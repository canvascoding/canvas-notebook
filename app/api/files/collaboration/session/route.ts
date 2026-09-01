import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';
import { issueCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import {
  CollaborationSessionError,
  createCollaborationSessionGrant,
  parseCollaborationSessionRequest,
} from '@/app/lib/collaboration/session-service';
import {
  COLLABORATION_SCHEMA_VERSION,
  RICH_MARKDOWN_SCHEMA_VERSION,
  type CollaborationProvider,
  type CollaborationSessionRepresentation,
  type CollaborationSessionResponse,
} from '@/app/lib/collaboration/types';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const rateLimitResponse = applyRateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'collaboration-session',
  });
  if (rateLimitResponse) return rateLimitResponse;

  if (!liveCollaborationRuntimeAvailable()) {
    return NextResponse.json({ success: false, error: 'Live collaboration requires Postgres.' }, { status: 409 });
  }

  const body = await readJsonBody<{
    path?: string;
    representation?: CollaborationSessionRepresentation;
    provider?: CollaborationProvider;
  }>(request);
  const requested = parseCollaborationSessionRequest(body);
  if (!requested) {
    return NextResponse.json({ success: false, error: 'A supported path, provider, and collaboration representation are required.' }, { status: 400 });
  }

  try {
    const grant = await createCollaborationSessionGrant({
      workspace: workspaceResult.workspace,
      fileOptions: workspaceFileOptions(workspaceResult.workspace),
      request: requested,
    });
    const sessionId = String((workspaceResult.session.session as { id?: string }).id || '');
    if (!sessionId) throw new Error('Authenticated session has no stable identifier.');
    const issued = issueCollaborationTicket({
      userId: workspaceResult.session.user.id,
      sessionId,
      workspaceId: workspaceResult.workspace.workspaceId,
      organizationId: workspaceResult.workspace.organizationId ?? null,
      documentId: grant.documentId,
      path: grant.path,
      provider: grant.provider,
      representation: grant.representation,
      permission: grant.permission,
      lifecycleGeneration: grant.lifecycleGeneration,
    });
    const colors = collaborationUserColors(workspaceResult.session.user.id);
    const response: CollaborationSessionResponse = {
      success: true,
      documentId: grant.documentId,
      documentName: grant.documentName,
      provider: grant.provider,
      representation: grant.representation,
      lifecycleGeneration: grant.lifecycleGeneration,
      schemaVersion: COLLABORATION_SCHEMA_VERSION,
      richTextSchemaVersion: RICH_MARKDOWN_SCHEMA_VERSION,
      permission: grant.permission,
      documentSequence: grant.documentSequence,
      checkpointSequence: grant.checkpointSequence,
      stateVector: grant.stateVector,
      token: issued.token,
      expiresAt: new Date(issued.claims.expiresAt).toISOString(),
      websocketUrl: grant.provider === 'excalidraw' ? '/ws/collaboration/excalidraw' : '/ws/collaboration',
      user: {
        id: workspaceResult.session.user.id,
        name: workspaceResult.session.user.name || workspaceResult.session.user.email || 'User',
        ...colors,
      },
    };
    return NextResponse.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const status = error instanceof CollaborationSessionError
      ? error.status
      : code === 'ENOENT' ? 404 : 500;
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Could not start collaboration.',
      ...(error instanceof CollaborationSessionError && error.code ? { code: error.code } : {}),
    }, { status });
  }
}
