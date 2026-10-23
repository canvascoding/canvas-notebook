import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import {
  CollaborationSessionError,
  createCollaborationSessionGrant,
  parseCollaborationSessionRequest,
  type CollaborationSessionGrant,
} from '@/app/lib/collaboration/session-service';
import {
  COLLABORATION_SCHEMA_VERSION,
  RICH_MARKDOWN_SCHEMA_VERSION,
  RICH_BLOCK_TREE_FORMAT_VERSION,
  type CollaborationSessionResponse,
} from '@/app/lib/collaboration/types';
import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import { authenticatedNativeTextSessionEnabled } from '@/app/lib/collaboration/native-text-session-activation';
import { issueMobileCollaborationTicket } from '@/app/lib/mobile/collaboration-ticket';
import { mobileCollaborationProjectionStatus } from '@/app/lib/mobile/collaboration-session';
import { requireRequestWorkspace, workspaceFileOptions } from '@/app/lib/workspaces/request';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const original = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const workspaceResult = await requireRequestWorkspace(original, { permissions: 'canRead' });
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

  const body = await readJsonBody<{ path?: unknown; richTextSchemaVersion?: unknown; blockTreeFormatVersion?: unknown; migration?: unknown; migrationAction?: unknown }>(request).catch(() => null);
  if (!body || typeof body !== 'object' || Array.isArray(body)) return NextResponse.json({ success: false, error: 'A supported document request is required.' }, { status: 400 });
  if (body.migration !== undefined && !workspaceResult.workspace.permissions.canWrite) {
    return NextResponse.json({ success: false, code: 'migration_permission_denied', error: 'Write access is required to prepare formatted editing.' }, { status: 403 });
  }
  const fileOptions = workspaceFileOptions(workspaceResult.workspace);
  const collaborationRequest = parseCollaborationSessionRequest({
    path: body.path,
    provider: 'yjs',
    representation: 'auto',
    richTextSchemaVersion: body.richTextSchemaVersion,
    blockTreeFormatVersion: body.blockTreeFormatVersion,
    migration: body.migration,
    migrationAction: body.migrationAction,
  });
  if (!collaborationRequest) {
    return NextResponse.json(
      { success: false, error: 'A supported Markdown or plain-text path is required.' },
      { status: 400 },
    );
  }

  const nativeSession = authenticatedNativeTextSessionEnabled();
  const responseForGrant = (grant: CollaborationSessionGrant, ticket: { token: string; expiresAt: string }) => {
    const projectionStatus = mobileCollaborationProjectionStatus(grant);
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
      ...(grant.representation === 'tiptap_blocks' ? { blockTreeFormatVersion: RICH_BLOCK_TREE_FORMAT_VERSION } : {}),
      permission: grant.permission,
      documentSequence: grant.documentSequence,
      checkpointSequence: grant.checkpointSequence,
      stateVector: grant.stateVector,
      stateProof: grant.stateProof,
      ...projectionStatus,
      ...(grant.migration ? { migration: grant.migration } : {}),
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
  };
  const pendingResponse = (grant: CollaborationSessionGrant) => grant.migration?.status === 'pending' && grant.migration.reason === 'outcome_unconfirmed'
    ? NextResponse.json({ success: false, migration: grant.migration,
      error: 'The current document session could not be confirmed. Poll the same migration request.' },
    { status: 503, headers: { 'Cache-Control': 'no-store, private' } }) : null;
  const user = { id: workspaceResult.session.user.id,
    name: workspaceResult.session.user.name || workspaceResult.session.user.email || 'User',
    email: workspaceResult.session.user.email || null, role: workspaceResult.session.user.role || null };
  try {
    const sessionId = String((workspaceResult.session.session as { id?: string }).id || '');
    if (!sessionId) throw new Error('Authenticated session has no stable identifier.');
    if (nativeSession && collaborationRequest.provider === 'yjs') {
      const service = await import('@/app/lib/collaboration/authenticated-text-session-service');
      return await service.withAuthenticatedTextCollaborationSessionGrant({ request: original,
        workspaceId: workspaceResult.workspace.workspaceId, sessionRequest: collaborationRequest,
        permission: workspaceResult.workspace.permissions.canWrite ? 'write' : 'read' }, async publication => {
        const pending = pendingResponse(publication.grant); if (pending) return pending;
        if (publication.identity.userId !== user.id || publication.identity.sessionId !== sessionId) {
          throw new Error('Authenticated native session identity changed.');
        }
        // Prepare/validate the wire before taking ownership. Response creation
        // stays inside the publisher so any later failure rolls back adoption.
        mobileCollaborationProjectionStatus(publication.grant);
        const { issueAuthenticatedMobileCollaborationTicket } = await import('@/app/lib/mobile/collaboration-ticket');
        const ticket = issueAuthenticatedMobileCollaborationTicket({ claims: {
          userId: publication.identity.userId, sessionId: publication.identity.sessionId,
          workspaceId: publication.identity.workspaceId, organizationId: publication.identity.organizationId,
          documentId: publication.grant.documentId, path: publication.grant.path, provider: publication.grant.provider,
          representation: publication.grant.representation, permission: publication.grant.permission,
          lifecycleGeneration: publication.grant.lifecycleGeneration,
        }, user, takeTransport: publication.takeTransport });
        return responseForGrant(publication.grant, ticket);
      });
    }
    const grant = await createCollaborationSessionGrant({ workspace: workspaceResult.workspace, fileOptions, request: collaborationRequest });
    const pending = pendingResponse(grant); if (pending) return pending;
    mobileCollaborationProjectionStatus(grant);
    const ticket = issueMobileCollaborationTicket({ claims: {
      userId: user.id, sessionId, workspaceId: workspaceResult.workspace.workspaceId,
      organizationId: workspaceResult.workspace.organizationId ?? null, documentId: grant.documentId,
      path: grant.path, provider: grant.provider, representation: grant.representation,
      permission: grant.permission, lifecycleGeneration: grant.lifecycleGeneration,
    }, user });
    return responseForGrant(grant, ticket);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? String(error.code)
      : '';
    const status = nativeSession
      ? (await import('@/app/lib/collaboration/authenticated-text-session-service')).authenticatedTextSessionErrorStatus(error)
      : error instanceof CollaborationSessionError
      ? error.status
      : code === 'ENOENT' ? 404 : 500;
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Could not start collaboration.',
      ...((nativeSession && code || error instanceof CollaborationSessionError && error.code) ? { code } : {}),
    }, { status });
  }
}
