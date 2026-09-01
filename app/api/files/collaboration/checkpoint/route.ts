import { NextRequest, NextResponse } from 'next/server';

import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import {
  CollaborationCheckpointSupersededError,
  materializeCollaborationCheckpoint,
} from '@/app/lib/collaboration/checkpoint';
import {
  loadCollaborationState,
  type PersistedCollaborationState,
} from '@/app/lib/collaboration/persistence';
import { verifyCollaborationTicket } from '@/app/lib/collaboration/ticket';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';

function checkpointResponse(
  state: PersistedCollaborationState,
  input: { revisionId: string | null; alreadyCheckpointed?: boolean },
) {
  return {
    success: true,
    documentId: state.documentId,
    lifecycleGeneration: state.lifecycleGeneration,
    documentSequence: state.documentSequence,
    checkpointSequence: state.checkpointSequence,
    stateVector: Buffer.from(state.stateVector).toString('base64'),
    sequence: state.documentSequence,
    revisionId: input.revisionId,
    ...(input.alreadyCheckpointed ? { alreadyCheckpointed: true } : {}),
  };
}

function decodeStateVector(value: string): Buffer | null {
  if (value.length > 64 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

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
      claims.provider !== 'yjs'
      || claims.representation === 'excalidraw_scene'
      || claims.permission !== 'write'
      || claims.userId !== workspaceResult.session.user.id
      || claims.sessionId !== sessionId
      || claims.workspaceId !== workspaceResult.workspace.workspaceId
    ) {
      return NextResponse.json({ success: false, error: 'Collaboration ticket scope mismatch.' }, { status: 403 });
    }
    const state = await loadCollaborationState(claims.documentId);
    if (
      !state
      || state.workspaceId !== claims.workspaceId
      || state.organizationId !== claims.organizationId
      || state.lifecycleGeneration !== claims.lifecycleGeneration
      || state.path !== claims.path
      || state.representation !== claims.representation
    ) {
      return NextResponse.json({ success: false, error: 'Collaboration document generation is stale.' }, { status: 409 });
    }
    const suppliedVector = decodeStateVector(body.stateVector);
    if (!suppliedVector || !Buffer.from(state.stateVector).equals(suppliedVector)) {
      return NextResponse.json({ success: false, error: 'Checkpoint is not based on the latest persisted Yjs state.' }, { status: 409 });
    }
    if (state.checkpointSequence >= state.documentSequence) {
      return NextResponse.json(checkpointResponse(state, {
        revisionId: null,
        alreadyCheckpointed: true,
      }));
    }
    const result = await materializeCollaborationCheckpoint({
      state,
      workspace: workspaceResult.workspace,
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
        documentSequence: result.state.documentSequence,
        revisionId: result.revisionId,
      },
    });
    return NextResponse.json(checkpointResponse(result.state, { revisionId: result.revisionId }));
  } catch (error) {
    return NextResponse.json({
      success: false,
      error: error instanceof Error ? error.message : 'Checkpoint failed.',
    }, { status: error instanceof CollaborationCheckpointSupersededError ? 409 : 500 });
  }
}
