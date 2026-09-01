import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { materializeCollaborationCheckpoint } from '@/app/lib/collaboration/checkpoint';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { verifyCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { richMarkdownFromYDoc } from '@/app/lib/collaboration/markdown-state';
import { Y } from '@/app/lib/collaboration/server-runtime';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

export async function POST(request: NextRequest) {
  const workspaceResult = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (workspaceResult.response) return workspaceResult.response;
  const rateLimitResponse = applyRateLimit(request, {
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'collaboration-checkpoint',
  });
  if (rateLimitResponse) return rateLimitResponse;

  const body = await readJsonBody<{
    token?: string;
    stateVector?: string;
  }>(request);
  if (!body.token || !body.stateVector) {
    return NextResponse.json({ success: false, error: 'Token and stateVector are required.' }, { status: 400 });
  }

  try {
    const claims = verifyCollaborationTicket(body.token);
    const sessionId = String((workspaceResult.session.session as { id?: string }).id || '');
    if (
      claims.permission !== 'write'
      || claims.userId !== workspaceResult.session.user.id
      || claims.sessionId !== sessionId
      || claims.workspaceId !== workspaceResult.workspace.workspaceId
    ) {
      return NextResponse.json({ success: false, error: 'Collaboration ticket scope mismatch.' }, { status: 403 });
    }
    const state = await loadCollaborationState(claims.documentId);
    if (!state || state.lifecycleGeneration !== claims.lifecycleGeneration || state.path !== claims.path) {
      return NextResponse.json({ success: false, error: 'Collaboration document generation is stale.' }, { status: 409 });
    }
    const suppliedVector = Buffer.from(body.stateVector, 'base64');
    if (!Buffer.from(state.stateVector).equals(suppliedVector)) {
      return NextResponse.json({ success: false, error: 'Checkpoint is not based on the latest persisted Yjs state.' }, { status: 409 });
    }
    if (state.checkpointSequence >= state.documentSequence) {
      return NextResponse.json({
        success: true,
        sequence: state.documentSequence,
        revisionId: null,
        alreadyCheckpointed: true,
      });
    }
    const doc = new Y.Doc({ gc: true });
    Y.applyUpdate(doc, state.yjsState);
    const canonicalContent = state.representation === 'plain_text'
      ? doc.getText('content').toString()
      : richMarkdownFromYDoc(doc);
    doc.destroy();
    const result = await materializeCollaborationCheckpoint({
      state,
      workspace: workspaceResult.workspace,
      canonicalContent,
      actorUserId: workspaceResult.session.user.id,
      actorType: 'user',
      sourceSessionId: sessionId,
    });
    await recordAuditEvent({
      organizationId: workspaceResult.workspace.organizationId,
      workspaceId: workspaceResult.workspace.workspaceId,
      userId: workspaceResult.session.user.id,
      source: 'files',
      eventType: 'file',
      entityType: 'collaboration_document',
      entityId: state.documentId,
      action: 'file.collaboration.checkpoint',
      status: 'success',
      summary: `Collaboration checkpoint materialized for ${state.path}.`,
      metadata: {
        path: state.path,
        documentSequence: state.documentSequence,
        revisionId: result.revisionId,
      },
    });
    return NextResponse.json({ success: true, sequence: state.documentSequence, revisionId: result.revisionId });
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Checkpoint failed.',
    }, { status: 500 });
  }
}
