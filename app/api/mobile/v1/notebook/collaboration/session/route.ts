import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import {
  CollaborationSessionError,
  createCollaborationSessionGrant,
  parseCollaborationSessionRequest,
} from '@/app/lib/collaboration/session-service';
import {
  COLLABORATION_SCHEMA_VERSION,
  RICH_MARKDOWN_SCHEMA_VERSION,
  type CollaborationSessionResponse,
} from '@/app/lib/collaboration/types';
import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import { issueMobileCollaborationTicket } from '@/app/lib/mobile/collaboration-ticket';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canRead' });
  if (workspaceResult.response) return workspaceResult.response;
  const limited = applyRateLimit(request, {
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'mobile-notebook-collaboration-session',
  });
  if (limited) return limited;

  if (!liveCollaborationRuntimeAvailable()) {
    return NextResponse.json(
      { success: false, error: 'Live collaboration requires Postgres.' },
      { status: 409 },
    );
  }

  const body = await readJsonBody<{ path?: unknown }>(request);
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);
  const collaborationRequest = parseCollaborationSessionRequest({
    path: body.path,
    provider: 'yjs',
    representation: 'auto',
  });
  if (!collaborationRequest) {
    return NextResponse.json(
      { success: false, error: 'A supported Markdown or plain-text path is required.' },
      { status: 400 },
    );
  }

  try {
    const grant = await createCollaborationSessionGrant({
      workspace: workspaceResult.workspace,
      fileOptions,
      request: collaborationRequest,
    });
    const sessionId = String((workspaceResult.session.session as { id?: string }).id || '');
    if (!sessionId) throw new Error('Authenticated session has no stable identifier.');

    const ticket = issueMobileCollaborationTicket({
      claims: {
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
      },
      user: {
        id: workspaceResult.session.user.id,
        name: workspaceResult.session.user.name
          || workspaceResult.session.user.email
          || 'User',
        email: workspaceResult.session.user.email || null,
        role: workspaceResult.session.user.role || null,
      },
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
      token: ticket.token,
      expiresAt: ticket.expiresAt,
      websocketUrl: '/ws/collaboration',
      user: {
        id: workspaceResult.session.user.id,
        name: workspaceResult.session.user.name
          || workspaceResult.session.user.email
          || 'User',
        ...colors,
      },
    };
    return NextResponse.json(response, {
      headers: { 'Cache-Control': 'no-store, private' },
    });
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
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
