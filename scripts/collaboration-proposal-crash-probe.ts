import type * as Y from 'yjs';
import type { AgentDirectConnectionInput } from '../app/lib/collaboration/direct-connection';
import type { fileVersionHistoryService } from '../app/lib/file-version-center/history-service';

export type CrashPoint = 'persisted-before-ack' | 'persisted-before-history' | 'history-before-receipt';
export type CrashTarget = { documentId: string; workspaceId: string; path: string; userId: string };
type Handler = <T>(input: AgentDirectConnectionInput, apply: (doc: Y.Doc) => T,
  onApplied?: (result: T) => Promise<void>) => Promise<T>;
type Bridge = { __canvasCollaborationDirectConnection?: Handler };
type History = Pick<typeof fileVersionHistoryService, 'capturePersistedCollaboration'>;
type AppliedObservation = { operationId: string; mutations: number; acknowledged: boolean;
  appliedUpdate?: Uint8Array; representation: AgentDirectConnectionInput['documentRepresentation'] };

/** Installed only by the explicit local crash launcher, never by product startup. */
export function installProposalCrashProbe(options: {
  bridge: Bridge; history: History; target: CrashTarget; point: CrashPoint;
  encodeApplied(doc: Y.Doc): Uint8Array;
  persistedMatches(input: { persistedUpdate: Uint8Array; candidateUpdate: Uint8Array;
    representation: AgentDirectConnectionInput['documentRepresentation'] }): boolean;
  interrupt(evidence: { point: CrashPoint; operationId: string; mutations: number; acknowledged: boolean;
    historyCaptured: boolean; documentSequence: number }): Promise<never>;
}): () => void {
  const original = options.bridge.__canvasCollaborationDirectConnection;
  if (typeof original !== 'function') throw new Error('Collaboration bridge is not ready.');
  if (!['persisted-before-ack', 'persisted-before-history', 'history-before-receipt'].includes(options.point)
    || !/^fvrc-1008-ordinary-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.md$/u.test(options.target.path)
    || ![options.target.documentId, options.target.workspaceId, options.target.userId].every(id =>
      typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(id))) {
    throw new Error('Invalid crash fixture scope.');
  }
  let active: AppliedObservation | null = null;
  const originalCapture = options.history.capturePersistedCollaboration;
  const wrapped: Handler = async (input, apply, onApplied) => {
    if (input.documentId !== options.target.documentId || input.workspace.workspaceId !== options.target.workspaceId
      || input.documentPath !== options.target.path || input.initiatedByUserId !== options.target.userId
      || input.actorType !== 'user' || input.versionSource !== 'agent_apply') return original(input, apply, onApplied);
    if (active) throw new Error('The crash fixture permits only one action.');
    const observation: AppliedObservation = { operationId: input.operationId, mutations: 0,
      acknowledged: false, representation: input.documentRepresentation };
    active = observation;
    return original(input, doc => {
      const result = apply(doc);
      observation.appliedUpdate = options.encodeApplied(doc);
      observation.mutations++;
      return result;
    }, async result => {
      if (options.point === 'persisted-before-ack') {
        // Leave the normal background store active, but do not fabricate the
        // applied snapshot. The process dies only when that store reaches history.
        await new Promise<never>(() => {});
      }
      await onApplied?.(result);
      observation.acknowledged = true;
    });
  };
  const capture: History['capturePersistedCollaboration'] = async input => {
    if (!active || input.state.documentId !== options.target.documentId
      || input.state.workspaceId !== options.target.workspaceId || input.state.path !== options.target.path
      || input.source !== 'agent_apply' || active.mutations !== 1 || !active.appliedUpdate
      || !options.persistedMatches({ persistedUpdate: input.state.yjsState, candidateUpdate: active.appliedUpdate,
        representation: active.representation })) return originalCapture(input);
    const afterHistory = options.point === 'history-before-receipt';
    if (afterHistory) {
      const captured = await originalCapture(input);
      if ((captured.outcome !== 'captured' && captured.outcome !== 'already_captured')
        || !captured.revision || !captured.binding) return captured;
    }
    return options.interrupt({ point: options.point, operationId: active.operationId,
      mutations: active.mutations, acknowledged: active.acknowledged, historyCaptured: afterHistory,
      documentSequence: input.state.documentSequence });
  };
  options.bridge.__canvasCollaborationDirectConnection = wrapped;
  options.history.capturePersistedCollaboration = capture;
  return () => {
    if (options.bridge.__canvasCollaborationDirectConnection === wrapped) options.bridge.__canvasCollaborationDirectConnection = original;
    if (options.history.capturePersistedCollaboration === capture) options.history.capturePersistedCollaboration = originalCapture;
  };
}
