import type { ExcalidrawServerMessage } from '@/app/lib/excalidraw-collaboration/protocol';
import type { AppliedExcalidrawPatch, PersistedExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';

/** Local commits can overtake queued cross-process notifications. Close that gap before advancing the room. */
export function prepareExcalidrawAppliedDelivery(input: {
  result: AppliedExcalidrawPatch;
  broadcastSequence: number;
  broadcastState: PersistedExcalidrawScene | null;
  replyTo: string;
  messageId: string;
}): { broadcast: boolean; state: PersistedExcalidrawScene; message: Extract<ExcalidrawServerMessage, { type: 'scene:applied' }> } {
  const broadcast = !input.result.duplicate && input.result.state.sceneSequence > input.broadcastSequence;
  const state = !broadcast && input.broadcastState && input.broadcastState.sceneSequence > input.result.state.sceneSequence
    ? input.broadcastState : input.result.state;
  const fullScene = !broadcast || state.sceneSequence > input.broadcastSequence + 1;
  return {
    broadcast,
    state,
    message: {
      schemaVersion: 1, type: 'scene:applied', messageId: input.messageId, replyTo: input.replyTo,
      elements: fullScene ? state.elements : input.result.acceptedElements,
      appState: fullScene ? state.appState : input.result.acceptedAppState,
      assets: state.assets, sceneSequence: state.sceneSequence, canonicalHash: state.canonicalHash,
      persisted: true, checkpointed: state.checkpointSequence >= state.sceneSequence,
    },
  };
}
