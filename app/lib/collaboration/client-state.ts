import { isCollaborationStateProof } from './state-proof';
import { COLLABORATION_CHECKPOINT_ERROR_CODES } from './checkpoint-errors';
import { collaborationFailure, COLLABORATION_FAILURE_CODES, isCollaborationProjectionErrorCode, type CollaborationFailure } from './failure';
import type {
  CollaborationPermission,
  TextCollaborationConnectionState,
  TextCollaborationDurabilityState,
} from './types';

export type TextCollaborationClientState = {
  connection: TextCollaborationConnectionState;
  durability: TextCollaborationDurabilityState;
  indexedDbHydrated: boolean;
  locallyUsable?: boolean;
  remoteSynced: boolean;
  ready: boolean;
  unsyncedChanges: number;
  documentSequence: number | null;
  checkpointSequence: number | null;
  checkpointStateVector: string | null;
  checkpointStateProof: string | null;
  persistedStateProof: string | null;
  projectionError: { code: string | null; sequence: number } | null;
  error: string | null;
  failure: CollaborationFailure | null;
  quarantineSequence?: number;
  authorizationRecoveryEligible?: boolean;
};

export type TextCollaborationClientEvent =
  | { type: 'indexeddb_hydrated' }
  | { type: 'local_document_restored' }
  | { type: 'document_changed' }
  | { type: 'provider_status'; status: 'connected' | 'connecting' | 'disconnected'; permission: CollaborationPermission }
  | { type: 'remote_synced'; permission: CollaborationPermission }
  | { type: 'unsynced_changes'; count: number }
  | {
      type: 'authoritative_snapshot';
      documentSequence: number;
      checkpointSequence: number;
      stateVector: string;
      stateProof: string;
      matchesCurrentDocument: boolean;
      degraded?: boolean;
      projectionError?: { code: string; sequence: number; permanent: boolean };
      projectionFinalized?: boolean;
      schemaValidated?: boolean;
      /** Set only by the registry after fresh, scoped location authorization. */
      authorizationRevalidated?: boolean;
    }
  | { type: 'checkpoint_requested' }
  | { type: 'checkpointed'; sequence: number; stateVector: string; stateProof: string; matchesCurrentDocument: boolean }
  | { type: 'checkpoint_superseded'; sequence: number }
  | { type: 'checkpoint_failed'; message: string; code?: string }
  | { type: 'projection_failed'; sequence: number; code?: string }
  | { type: 'degraded'; message: string; code?: string; sequence?: number }
  | { type: 'authentication_failed'; message: string };

export function createInitialTextCollaborationClientState(input: {
  permission?: CollaborationPermission;
  documentSequence?: number;
  checkpointSequence?: number;
  stateVector?: string;
  degraded?: boolean;
  projectionError?: { code: string; sequence: number; permanent: boolean };
} = {}): TextCollaborationClientState {
  const documentSequence = Number.isSafeInteger(input.documentSequence)
    ? input.documentSequence ?? null
    : null;
  const checkpointSequence = Number.isSafeInteger(input.checkpointSequence)
    ? input.checkpointSequence ?? null
    : null;
  const quarantined = Boolean(input.degraded || input.projectionError?.permanent);
  return {
    connection: input.permission === 'read' ? 'read_only' : 'connecting',
    // The session describes the server, not the not-yet-hydrated local doc.
    durability: quarantined ? 'degraded' : 'server_received',
    indexedDbHydrated: false,
    remoteSynced: false,
    ready: false,
    unsyncedChanges: 0,
    documentSequence,
    checkpointSequence,
    checkpointStateVector: null,
    checkpointStateProof: null,
    persistedStateProof: null,
    projectionError: input.projectionError && !input.projectionError.permanent ? input.projectionError : null,
    error: quarantined ? 'The saved document is quarantined. Recovery is required.' : null,
    failure: quarantined ? collaborationFailure(input.projectionError?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.quarantined) : null,
    authorizationRecoveryEligible: false,
    ...(quarantined && documentSequence !== null ? { quarantineSequence: documentSequence } : {}),
  };
}

function withReadiness(state: TextCollaborationClientState): TextCollaborationClientState {
  return {
    ...state,
    ready: state.indexedDbHydrated && (state.remoteSynced || state.locallyUsable === true),
  };
}

function hasPersistedCurrentDocument(state: TextCollaborationClientState): boolean {
  return state.ready && state.unsyncedChanges === 0 && isCollaborationStateProof(state.persistedStateProof);
}

function recordProjectionFailure(state: TextCollaborationClientState, sequence: number, code?: string): TextCollaborationClientState {
  if (!Number.isSafeInteger(sequence) || sequence < 0
    || sequence < (state.projectionError?.sequence ?? -1)
    || sequence < (state.checkpointSequence ?? -1)) return state;
  return { ...state, projectionError: { code: typeof code === 'string' ? code : null, sequence } };
}

export function reduceTextCollaborationClientState(
  state: TextCollaborationClientState,
  event: TextCollaborationClientEvent,
): TextCollaborationClientState {
  switch (event.type) {
    case 'indexeddb_hydrated':
      return withReadiness({ ...state, indexedDbHydrated: true });
    case 'local_document_restored':
      if (state.connection === 'denied' || state.failure) return state;
      return withReadiness({ ...state, locallyUsable: true, connection: 'offline', durability: 'local_pending' });
    case 'provider_status':
      if (state.connection === 'denied') return state;
      return withReadiness({
        ...state,
        // A TCP/WebSocket reconnect is not proof of renewed authorization.
        connection: event.permission === 'read'
          ? 'read_only'
          : event.status === 'connected'
            ? state.remoteSynced ? 'live' : 'connecting'
            : event.status === 'connecting' ? 'reconnecting' : 'offline',
        error: state.durability === 'degraded' ? state.error : null,
        failure: state.durability === 'degraded' ? state.failure : null,
      });
    case 'remote_synced':
      if (state.connection === 'denied') return state;
      return withReadiness({
        ...state,
        remoteSynced: true,
        connection: event.permission === 'read' ? 'read_only' : 'live',
        error: state.durability === 'degraded' ? state.error : null,
        // A successful authenticated sync permits revalidation, not an automatic
        // release of a previously paused Markdown checkpoint.
        failure: state.durability === 'degraded' ? state.failure : null,
      });
    case 'document_changed':
      return {
        ...state,
        checkpointStateVector: null,
        checkpointStateProof: null,
        persistedStateProof: null,
        durability: state.durability === 'degraded' || state.connection === 'denied' ? 'degraded'
          : state.unsyncedChanges > 0 ? 'local_pending' : 'server_received',
      };
    case 'unsynced_changes': {
      const count = Math.max(0, event.count);
      return {
        ...state,
        unsyncedChanges: count,
        persistedStateProof: count > 0 ? null : state.persistedStateProof,
        durability: state.durability === 'degraded' ? 'degraded' : count > 0
          ? 'local_pending'
          : state.durability === 'local_pending' ? 'server_received' : state.durability,
      };
    }
    case 'authoritative_snapshot': {
      if (
        !Number.isSafeInteger(event.documentSequence)
        || !Number.isSafeInteger(event.checkpointSequence)
        || !isCollaborationStateProof(event.stateProof)
        || event.documentSequence < 0
        || event.checkpointSequence < 0
        || event.checkpointSequence > event.documentSequence
        || event.documentSequence < (state.documentSequence ?? -1)
      ) return state;
      const documentSequence = Math.max(state.documentSequence ?? 0, event.documentSequence);
      const checkpointSequence = event.documentSequence === (state.documentSequence ?? -1)
        ? Math.max(state.checkpointSequence ?? 0, event.checkpointSequence)
        : event.checkpointSequence;
      const checkpointCoversDocument = checkpointSequence >= documentSequence && event.projectionFinalized !== false;
      const exactPersistedDocument = state.ready && event.matchesCurrentDocument
        && isCollaborationStateProof(event.stateProof) && state.unsyncedChanges === 0;
      const binaryRecoveryAllowed = state.failure?.code === COLLABORATION_FAILURE_CODES.persistenceFailed
        || isCollaborationProjectionErrorCode(state.failure?.code);
      const validatedRecovery = event.schemaValidated === true && event.projectionFinalized === true
        && event.documentSequence > (state.quarantineSequence ?? state.documentSequence ?? Infinity);
      const authorizationRecovery = event.authorizationRevalidated === true
        && state.authorizationRecoveryEligible === true && state.remoteSynced
        && (state.connection === 'live' || state.connection === 'read_only')
        && event.degraded !== true && !event.projectionError?.permanent;
      const recoveryAllowed = state.failure?.kind === 'authentication'
        ? authorizationRecovery : validatedRecovery || binaryRecoveryAllowed;
      const stillDegraded = event.degraded === true || state.connection === 'denied' || (state.durability === 'degraded'
        && (state.failure?.kind === 'lifecycle'
          || !(exactPersistedDocument && recoveryAllowed)));
      const persistedProjectionError = event.projectionError && !event.projectionError.permanent
        ? { code: event.projectionError.code, sequence: event.projectionError.sequence } : null;
      return {
        ...state,
        documentSequence,
        checkpointSequence,
        checkpointStateVector: exactPersistedDocument && checkpointCoversDocument
          ? event.stateVector
          : null,
        checkpointStateProof: exactPersistedDocument && checkpointCoversDocument ? event.stateProof : null,
        persistedStateProof: exactPersistedDocument ? event.stateProof : null,
        projectionError: persistedProjectionError ?? (state.projectionError && event.projectionFinalized === true
          && checkpointSequence >= state.projectionError.sequence ? null : state.projectionError),
        durability: stillDegraded ? 'degraded' : state.unsyncedChanges > 0
          ? 'local_pending'
          : exactPersistedDocument
            ? checkpointCoversDocument ? 'checkpointed_file' : 'persisted_yjs'
            : 'server_received',
        error: event.degraded ? 'The saved document is quarantined. Recovery is required.'
          : state.connection === 'denied' || stillDegraded ? state.error : null,
        failure: event.degraded ? collaborationFailure(event.projectionError?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.quarantined)
          : state.connection === 'denied' || stillDegraded ? state.failure : null,
        authorizationRecoveryEligible: stillDegraded && event.degraded !== true && !event.projectionError?.permanent
          ? state.authorizationRecoveryEligible : false,
        ...(event.degraded ? { quarantineSequence: event.documentSequence } : {}),
      };
    }
    case 'checkpoint_requested':
      if (state.durability === 'degraded') return state;
      return {
        ...state,
        durability: hasPersistedCurrentDocument(state) ? state.durability
          : state.unsyncedChanges > 0 ? 'local_pending' : 'checkpoint_pending',
        error: null,
        failure: null,
      };
    case 'checkpointed': {
      return reduceTextCollaborationClientState(state, {
        type: 'authoritative_snapshot',
        documentSequence: event.sequence,
        checkpointSequence: event.sequence,
        stateVector: event.stateVector,
        stateProof: event.stateProof,
        matchesCurrentDocument: event.matchesCurrentDocument,
        projectionFinalized: true,
        schemaValidated: true,
      });
    }
    case 'checkpoint_superseded':
      if (state.durability === 'degraded') return state;
      if (event.sequence <= (state.checkpointSequence ?? -1)) return state;
      return {
        ...state,
        documentSequence: Math.max(state.documentSequence ?? 0, event.sequence),
        durability: state.unsyncedChanges > 0 ? 'local_pending' : 'checkpoint_pending',
      };
    case 'checkpoint_failed':
      if (isCollaborationProjectionErrorCode(event.code)) {
        // An explicit export can fail while the exact current Yjs state remains
        // durable. Without a binary acknowledgement, do not invent a sequence.
        return hasPersistedCurrentDocument(state) && state.documentSequence !== null
          ? recordProjectionFailure(state, state.documentSequence, event.code) : state;
      }
      return {
        ...state,
        // A failed retry cannot validate a state that was already rejected.
        durability: state.durability === 'degraded' ? 'degraded'
          : state.unsyncedChanges > 0 ? 'local_pending' : 'server_received',
        error: event.message,
        // Retain the reason the editor is blocked when only its retry fails.
        failure: state.durability === 'degraded' ? state.failure : collaborationFailure(event.code),
      };
    case 'projection_failed':
      return recordProjectionFailure(state, event.sequence, event.code);
    case 'degraded':
      if (isCollaborationProjectionErrorCode(event.code) && hasPersistedCurrentDocument(state)
        && state.documentSequence !== null) {
        return recordProjectionFailure(state, state.documentSequence, event.code);
      }
      return {
        ...state,
        durability: 'degraded',
        quarantineSequence: event.sequence ?? state.documentSequence ?? undefined,
        authorizationRecoveryEligible: false,
        error: event.message,
        failure: collaborationFailure(event.code),
      };
    case 'authentication_failed':
      return withReadiness({
        ...state,
        connection: 'denied',
        durability: 'degraded',
        error: event.message,
        failure: collaborationFailure(COLLABORATION_FAILURE_CODES.authenticationFailed),
        // An access failure must not erase an earlier schema/unknown quarantine.
        authorizationRecoveryEligible: state.failure?.kind === 'authentication'
          ? state.authorizationRecoveryEligible === true : state.durability !== 'degraded' && state.failure === null,
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
