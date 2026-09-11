import { NextRequest, NextResponse } from 'next/server';

import { Y } from '@/app/lib/collaboration/server-runtime';
import { collaborationUpdateStateProof, isCollaborationStateProof } from '@/app/lib/collaboration/state-proof';
import { COLLABORATION_FAILURE_CODES } from '@/app/lib/collaboration/failure';
import { logCollaborationDiagnostic } from '@/app/lib/collaboration/diagnostics';
import { recordAuditEvent } from '@/app/lib/audit/audit-service';
import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import {
  CollaborationCheckpointSupersededError,
  materializeCollaborationCheckpoint,
} from '@/app/lib/collaboration/checkpoint';
import {
  COLLABORATION_CHECKPOINT_ERROR_CODES,
  collaborationCheckpointValidationFailure,
} from '@/app/lib/collaboration/checkpoint-errors';
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
    stateProof: collaborationUpdateStateProof(state.yjsState, Y),
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
    stateProof?: string;
  }>(request);
  if (typeof body.token !== 'string' || typeof body.stateVector !== 'string'
    || !isCollaborationStateProof(body.stateProof)) {
    return NextResponse.json({ success: false, error: 'Token, stateVector and a current stateProof are required. Reload or update the editor.' }, { status: 400 });
  }

  let checkpointContext: {
    workspaceId: string;
    documentId?: string;
    path?: string;
  } = {
    workspaceId: workspaceResult.workspace.workspaceId,
  };
  let attemptedState: PersistedCollaborationState | null = null;

  try {
    let claims: ReturnType<typeof verifyCollaborationTicket>;
    try { claims = verifyCollaborationTicket(body.token); }
    catch {
      return NextResponse.json({ success: false, code: COLLABORATION_FAILURE_CODES.authenticationFailed,
        error: 'Collaboration authorization expired. Reload to sign in again.' }, { status: 401 });
    }
    checkpointContext = {
      workspaceId: claims.workspaceId,
      documentId: claims.documentId,
      path: claims.path,
    };
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
      return NextResponse.json({ success: false, code: COLLABORATION_FAILURE_CODES.generationChanged,
        error: 'Collaboration document generation is stale.' }, { status: 409 });
    }
    const suppliedVector = decodeStateVector(body.stateVector);
    if (!suppliedVector || !Buffer.from(state.stateVector).equals(suppliedVector)
      || collaborationUpdateStateProof(state.yjsState, Y) !== body.stateProof) {
      return NextResponse.json({ success: false, error: 'Checkpoint is not based on the latest persisted Yjs state.' }, { status: 409 });
    }
    if (state.checkpointSequence >= state.documentSequence) {
      return NextResponse.json(checkpointResponse(state, {
        revisionId: null,
        alreadyCheckpointed: true,
      }));
    }
    attemptedState = state;
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
    const validationFailure = collaborationCheckpointValidationFailure(error);
    if (validationFailure) {
      logCollaborationDiagnostic('warn', {
        event: 'projection_failed', workspaceId: checkpointContext.workspaceId, documentId: checkpointContext.documentId,
        generation: attemptedState?.lifecycleGeneration, documentSequence: attemptedState?.documentSequence,
        checkpointSequence: attemptedState?.checkpointSequence, code: validationFailure.code,
      });
      return NextResponse.json({
        ...(attemptedState ? checkpointResponse(attemptedState, { revisionId: null }) : {}),
        success: false,
        code: validationFailure.code,
        error: validationFailure.message,
      }, { status: validationFailure.status });
    }
    if (error instanceof CollaborationCheckpointSupersededError) {
      return NextResponse.json({
        success: false,
        code: COLLABORATION_CHECKPOINT_ERROR_CODES.superseded,
        error: 'The collaboration checkpoint was superseded by newer changes.',
      }, { status: 409 });
    }
    logCollaborationDiagnostic('warn', {
      event: 'projection_failed', workspaceId: checkpointContext.workspaceId, documentId: checkpointContext.documentId,
      generation: attemptedState?.lifecycleGeneration, documentSequence: attemptedState?.documentSequence,
      checkpointSequence: attemptedState?.checkpointSequence, code: COLLABORATION_CHECKPOINT_ERROR_CODES.failed,
    });
    return NextResponse.json({
      ...(attemptedState ? checkpointResponse(attemptedState, { revisionId: null }) : {}),
      success: false,
      code: COLLABORATION_CHECKPOINT_ERROR_CODES.failed,
      error: 'The collaboration checkpoint could not be created.',
    }, { status: 500 });
  }
}
