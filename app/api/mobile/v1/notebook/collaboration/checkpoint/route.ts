import { NextRequest, NextResponse } from 'next/server';

import { applyRateLimit, readJsonBody } from '@/app/lib/api/route-helpers';
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { requireRequestWorkspace } from '@/app/lib/workspaces/request';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';
import { materializeCollaborationCheckpoint, CollaborationCheckpointSupersededError } from '@/app/lib/collaboration/checkpoint';
import { collaborationUpdateStateProof, isCollaborationStateProof } from '@/app/lib/collaboration/state-proof';
import { Y } from '@/app/lib/collaboration/server-runtime';
import { classifyCollaborationProjectionError } from '@/app/lib/collaboration/projection-errors';
import { loadCollaborationProjectionStatus, recordCollaborationProjectionFailure } from '@/app/lib/collaboration/projection-repository';
import { isCanonicalAdmissionPath } from '@/app/lib/collaboration/room-admission-contract';

export const dynamic = 'force-dynamic';

/** Uses the current authenticated workspace; mobile WebSocket tickets are one-use. */
export async function POST(request: NextRequest) {
  const context = await requireRequestWorkspace(request, { permissions: 'canWrite' });
  if (context.response) return context.response;
  const limited = applyRateLimit(request, { limit: 60, windowMs: 60_000, keyPrefix: 'mobile-notebook-checkpoint' });
  if (limited) return limited;
  const body = await readJsonBody<Record<string, unknown>>(request).catch(() => null);
  if (!body || typeof body.path !== 'string' || !isCanonicalAdmissionPath(body.path) || !body.path
    || typeof body.expectedDocumentId !== 'string' || !body.expectedDocumentId || body.expectedDocumentId.length > 256
    || /[\u0000-\u001f\u007f]/u.test(body.expectedDocumentId)
    || !Number.isSafeInteger(body.expectedLifecycleGeneration) || Number(body.expectedLifecycleGeneration) < 1
    || !Number.isSafeInteger(body.documentSequence) || Number(body.documentSequence) < 0
    || !isCollaborationStateProof(body.stateProof) || typeof body.stateVector !== 'string'
    || !body.stateVector || body.stateVector.length > 64 * 1024 || body.stateVector.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/u.test(body.stateVector)) {
    return NextResponse.json({ success: false, code: 'checkpoint_invalid_request', error: 'An exact document identity and saved Yjs state are required.' }, { status: 400 });
  }
  const path = body.path;
  const file = await readFileCollaborationState({ workspace: context.workspace, path });
  const state = await loadCollaborationState(body.expectedDocumentId);
  if (!file.document || file.document.id !== body.expectedDocumentId || !state || state.status !== 'active'
    || state.workspaceId !== context.workspace.workspaceId || state.path !== path
    || state.organizationId !== (context.workspace.organizationId ?? null)
    || state.lifecycleGeneration !== body.expectedLifecycleGeneration) {
    return NextResponse.json({ success: false, code: 'checkpoint_identity_changed', error: 'The document identity changed. Reopen the current session.' }, { status: 409 });
  }
  const vector = Buffer.from(body.stateVector, 'base64');
  if (!vector.length || vector.toString('base64') !== body.stateVector || state.documentSequence !== body.documentSequence || !Buffer.from(state.stateVector).equals(vector)
    || collaborationUpdateStateProof(state.yjsState, Y) !== body.stateProof) {
    return NextResponse.json({ success: false, code: 'checkpoint_state_changed', error: 'The checkpoint is waiting for the exact saved Yjs state.' }, { status: 409 });
  }
  try {
    const checkpoint = await materializeCollaborationCheckpoint({ state, workspace: context.workspace,
      actorUserId: context.session.user.id, actorType: 'user',
      sourceSessionId: String((context.session.session as { id?: string }).id || '') });
    const final = checkpoint.state;
    const status = await loadCollaborationProjectionStatus(final);
    const exact = final.documentId === body.expectedDocumentId && final.lifecycleGeneration === body.expectedLifecycleGeneration
      && final.documentSequence === body.documentSequence && final.checkpointSequence === body.documentSequence
      && collaborationUpdateStateProof(final.yjsState, Y) === body.stateProof && status.projectionFinalized === true && !status.degraded;
    return NextResponse.json({ success: exact, documentId: final.documentId, lifecycleGeneration: final.lifecycleGeneration,
      documentSequence: final.documentSequence, checkpointSequence: final.checkpointSequence,
      stateVector: Buffer.from(final.stateVector).toString('base64'), stateProof: collaborationUpdateStateProof(final.yjsState, Y),
      revisionId: checkpoint.revisionId, ...status,
      ...(!exact ? { code: 'checkpoint_not_finalized', error: 'The exact file checkpoint is not finalized yet.' } : {}) },
    { status: exact ? 200 : 409, headers: { 'Cache-Control': 'no-store, private' } });
  } catch (error) {
    const failure = classifyCollaborationProjectionError(error);
    if (!(error instanceof CollaborationCheckpointSupersededError)) {
      await recordCollaborationProjectionFailure(state, failure).catch(() => {});
    }
    return NextResponse.json({ success: false, code: error instanceof CollaborationCheckpointSupersededError
      ? 'checkpoint_state_changed' : failure.code, error: 'The current file checkpoint could not be confirmed.' },
    { status: error instanceof CollaborationCheckpointSupersededError ? 409 : 500 });
  }
}
