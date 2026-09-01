import type {
  CollaborationPermission,
  TextCollaborationConnectionState,
  TextCollaborationDurabilityState,
} from './types';

export type TextCollaborationClientState = {
  connection: TextCollaborationConnectionState;
  durability: TextCollaborationDurabilityState;
  indexedDbHydrated: boolean;
  remoteSynced: boolean;
  ready: boolean;
  unsyncedChanges: number;
  documentSequence: number | null;
  checkpointSequence: number | null;
  checkpointStateVector: string | null;
  error: string | null;
};

export type TextCollaborationClientEvent =
  | { type: 'indexeddb_hydrated' }
  | { type: 'provider_status'; status: 'connected' | 'connecting' | 'disconnected'; permission: CollaborationPermission }
  | { type: 'remote_synced'; permission: CollaborationPermission }
  | { type: 'unsynced_changes'; count: number }
  | { type: 'checkpoint_requested' }
  | { type: 'checkpointed'; sequence: number; stateVector: string; matchesCurrentDocument: boolean }
  | { type: 'checkpoint_superseded'; sequence: number }
  | { type: 'checkpoint_failed'; message: string }
  | { type: 'degraded'; message: string }
  | { type: 'authentication_failed'; message: string };

export function createInitialTextCollaborationClientState(input: {
  permission?: CollaborationPermission;
  documentSequence?: number;
  checkpointSequence?: number;
} = {}): TextCollaborationClientState {
  const documentSequence = Number.isSafeInteger(input.documentSequence)
    ? input.documentSequence ?? null
    : null;
  const checkpointSequence = Number.isSafeInteger(input.checkpointSequence)
    ? input.checkpointSequence ?? null
    : null;
  const checkpointed = documentSequence !== null
    && checkpointSequence !== null
    && checkpointSequence >= documentSequence;
  return {
    connection: input.permission === 'read' ? 'read_only' : 'connecting',
    durability: checkpointed ? 'checkpointed_file' : 'persisted_yjs',
    indexedDbHydrated: false,
    remoteSynced: false,
    ready: false,
    unsyncedChanges: 0,
    documentSequence,
    checkpointSequence,
    checkpointStateVector: null,
    error: null,
  };
}

function withReadiness(state: TextCollaborationClientState): TextCollaborationClientState {
  return {
    ...state,
    ready: state.indexedDbHydrated && state.remoteSynced,
  };
}

export function reduceTextCollaborationClientState(
  state: TextCollaborationClientState,
  event: TextCollaborationClientEvent,
): TextCollaborationClientState {
  switch (event.type) {
    case 'indexeddb_hydrated':
      return withReadiness({ ...state, indexedDbHydrated: true });
    case 'provider_status':
      return withReadiness({
        ...state,
        connection: event.permission === 'read'
          ? 'read_only'
          : event.status === 'connected'
            ? state.remoteSynced ? 'live' : 'connecting'
            : event.status === 'connecting' ? 'reconnecting' : 'offline',
        error: null,
      });
    case 'remote_synced':
      return withReadiness({
        ...state,
        remoteSynced: true,
        connection: event.permission === 'read' ? 'read_only' : 'live',
        error: null,
      });
    case 'unsynced_changes': {
      const count = Math.max(0, event.count);
      return {
        ...state,
        unsyncedChanges: count,
        durability: count > 0
          ? 'local_pending'
          : state.durability === 'local_pending' ? 'server_received' : state.durability,
      };
    }
    case 'checkpoint_requested':
      return {
        ...state,
        durability: state.unsyncedChanges > 0 ? 'local_pending' : 'checkpoint_pending',
        error: null,
      };
    case 'checkpointed': {
      const documentSequence = Math.max(state.documentSequence ?? 0, event.sequence);
      const checkpointSequence = Math.max(state.checkpointSequence ?? 0, event.sequence);
      const coversCurrentDocument = event.matchesCurrentDocument
        && event.sequence >= documentSequence;
      return {
        ...state,
        documentSequence,
        checkpointSequence,
        checkpointStateVector: event.stateVector,
        durability: coversCurrentDocument && state.unsyncedChanges === 0
          ? 'checkpointed_file'
          : state.unsyncedChanges > 0 ? 'local_pending' : 'server_received',
        error: null,
      };
    }
    case 'checkpoint_superseded':
      if (event.sequence <= (state.checkpointSequence ?? -1)) return state;
      return {
        ...state,
        documentSequence: Math.max(state.documentSequence ?? 0, event.sequence),
        durability: state.unsyncedChanges > 0 ? 'local_pending' : 'checkpoint_pending',
      };
    case 'checkpoint_failed':
      return {
        ...state,
        durability: state.unsyncedChanges > 0 ? 'local_pending' : 'server_received',
        error: event.message,
      };
    case 'degraded':
      return {
        ...state,
        durability: 'degraded',
        error: event.message,
      };
    case 'authentication_failed':
      return withReadiness({
        ...state,
        connection: 'denied',
        durability: 'degraded',
        error: event.message,
      });
  }
}

export function textCollaborationLegacyStatus(
  state: TextCollaborationClientState,
): 'connecting' | 'live' | 'persisting' | 'saved' | 'offline' | 'reconnecting' | 'read_only' | 'degraded' {
  if (state.connection === 'denied' || state.durability === 'degraded') return 'degraded';
  if (state.connection === 'offline') return 'offline';
  if (state.connection === 'reconnecting') return 'reconnecting';
  if (state.connection === 'read_only') return 'read_only';
  if (state.connection === 'connecting') return 'connecting';
  if (state.durability === 'checkpointed_file') return 'saved';
  if (state.durability === 'local_pending' || state.durability === 'checkpoint_pending') return 'persisting';
  return 'live';
}
