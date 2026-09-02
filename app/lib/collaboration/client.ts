'use client';

import { useEffect, useState } from 'react';

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

import { workspaceHeaders } from '@/app/lib/files/client';
import { CollaborationCheckpointRequestError } from './checkpoint-errors';
import {
  createInitialTextCollaborationClientState,
  reduceTextCollaborationClientState,
  textCollaborationLegacyStatus,
  type TextCollaborationClientEvent,
  type TextCollaborationClientState,
} from './client-state';
import type {
  CollaborationConnectionStatus,
  TextCollaborationRepresentation,
  CollaborationSessionResponse,
} from './types';

type RequestedTextCollaborationRepresentation = TextCollaborationRepresentation | 'auto';

type CollaborationCompositionRange = {
  textName: 'content' | 'body';
  from: number;
  to: number;
} | null;

type SetCollaborationComposition = (range: CollaborationCompositionRange) => void;

type CollaborationDurabilitySnapshot = {
  documentId: string;
  lifecycleGeneration: number;
  documentSequence: number;
  checkpointSequence: number;
  stateVector: string;
};

type RegistryEntry = {
  key: string;
  refs: number;
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  persistence: IndexeddbPersistence | null;
  session: CollaborationSessionResponse | null;
  clientState: TextCollaborationClientState;
  listeners: Set<() => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  startPromise: Promise<void>;
  checkpointPromise?: Promise<void>;
  pendingAuthoritativeSnapshot?: CollaborationDurabilitySnapshot;
  setComposition: SetCollaborationComposition;
  requestCheckpoint: () => Promise<void>;
};

export type CollaborationDocument = {
  registryKey: string;
  doc: Y.Doc;
  provider: HocuspocusProvider | null;
  session: CollaborationSessionResponse | null;
  status: CollaborationConnectionStatus;
  clientState: TextCollaborationClientState;
  connection: TextCollaborationClientState['connection'];
  durability: TextCollaborationClientState['durability'];
  ready: boolean;
  error: string | null;
  setComposition: SetCollaborationComposition;
  requestCheckpoint: () => Promise<void>;
};

const registry = new Map<string, RegistryEntry>();

function emit(entry: RegistryEntry): void {
  for (const listener of entry.listeners) listener();
}

function transition(entry: RegistryEntry, event: TextCollaborationClientEvent): void {
  entry.clientState = reduceTextCollaborationClientState(entry.clientState, event);
  emit(entry);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return window.btoa(binary);
}

function durabilitySnapshot(value: unknown): CollaborationDurabilitySnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<CollaborationDurabilitySnapshot>;
  if (
    typeof candidate.documentId !== 'string'
    || !Number.isSafeInteger(candidate.lifecycleGeneration)
    || !Number.isSafeInteger(candidate.documentSequence)
    || !Number.isSafeInteger(candidate.checkpointSequence)
    || (candidate.lifecycleGeneration ?? -1) < 0
    || (candidate.documentSequence ?? -1) < 0
    || (candidate.checkpointSequence ?? -1) < 0
    || (candidate.checkpointSequence ?? 0) > (candidate.documentSequence ?? -1)
    || typeof candidate.stateVector !== 'string'
    || candidate.stateVector.length === 0
  ) return null;
  return candidate as CollaborationDurabilitySnapshot;
}

function waitForEntryState(
  entry: RegistryEntry,
  predicate: (state: TextCollaborationClientState) => boolean,
  timeoutMs: number,
): Promise<void> {
  if (predicate(entry.clientState)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      entry.listeners.delete(listener);
      reject(new Error('Timed out while waiting for collaboration to synchronize.'));
    }, timeoutMs);
    const listener = () => {
      if (!predicate(entry.clientState)) return;
      window.clearTimeout(timeout);
      entry.listeners.delete(listener);
      resolve();
    };
    entry.listeners.add(listener);
  });
}

async function requestSession(
  path: string,
  representation: RequestedTextCollaborationRepresentation,
): Promise<CollaborationSessionResponse> {
  const response = await fetch('/api/files/collaboration/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify({ path, representation }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<CollaborationSessionResponse> & { error?: string };
  if (!response.ok || payload.success !== true) throw new Error(payload.error || 'Collaboration could not be started.');
  return payload as CollaborationSessionResponse;
}

function requireTextSession(
  session: CollaborationSessionResponse,
  representation?: TextCollaborationRepresentation,
): CollaborationSessionResponse {
  if (
    session.provider !== 'yjs'
    || (session.representation !== 'plain_text' && session.representation !== 'tiptap_xml')
    || (representation && session.representation !== representation)
  ) {
    throw new Error('The collaboration representation does not match this editor. Reload to use the current document representation.');
  }
  return session;
}

function websocketUrl(relative: string): string {
  const url = new URL(relative, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function createEntry(
  key: string,
  path: string,
  representation: TextCollaborationRepresentation,
  initialSession?: CollaborationSessionResponse | null,
): RegistryEntry {
  const entry: RegistryEntry = {
    key,
    refs: 0,
    doc: null,
    provider: null,
    persistence: null,
    session: null,
    clientState: createInitialTextCollaborationClientState({
      permission: initialSession?.permission,
      documentSequence: initialSession?.documentSequence,
      checkpointSequence: initialSession?.checkpointSequence,
      stateVector: initialSession?.stateVector,
    }),
    listeners: new Set(),
    startPromise: Promise.resolve(),
    requestCheckpoint: () => Promise.reject(new Error('Collaboration is still connecting.')),
    setComposition: (range) => {
      const provider = entry.provider;
      if (!provider) return;
      const current = provider.awareness?.getLocalState()?.canvas as Record<string, unknown> | undefined;
      provider.setAwarenessField('canvas', { ...(current || {}), composition: range });
    },
  };
  entry.startPromise = (async () => {
    try {
      const [{ HocuspocusProvider }, { IndexeddbPersistence }, Y] = await Promise.all([
        import('@hocuspocus/provider'),
        import('y-indexeddb'),
        import('yjs'),
      ]);
      if (entry.refs === 0 && !registry.has(key)) return;
      entry.doc = new Y.Doc({ gc: true });
      let session = requireTextSession(
        initialSession || await requestSession(path, representation),
        representation,
      );
      entry.session = session;
      entry.clientState = createInitialTextCollaborationClientState({
        permission: session.permission,
        documentSequence: session.documentSequence,
        checkpointSequence: session.checkpointSequence,
        stateVector: session.stateVector,
      });
      entry.pendingAuthoritativeSnapshot = durabilitySnapshot({
        documentId: session.documentId,
        lifecycleGeneration: session.lifecycleGeneration,
        documentSequence: session.documentSequence,
        checkpointSequence: session.checkpointSequence,
        stateVector: session.stateVector,
      }) ?? undefined;
      const persistence = new IndexeddbPersistence(
        `canvas:${session.documentId}:${session.lifecycleGeneration}:${representation}`,
        entry.doc,
      );
      entry.persistence = persistence;
      await persistence.whenSynced;
      transition(entry, { type: 'indexeddb_hydrated' });
      if (entry.refs === 0 && !registry.has(key)) return;
      const reconcileAuthoritativeSnapshot = (snapshot: CollaborationDurabilitySnapshot) => {
        if (
          !entry.doc
          || !entry.session
          || snapshot.documentId !== entry.session.documentId
          || snapshot.lifecycleGeneration !== entry.session.lifecycleGeneration
        ) return;
        entry.pendingAuthoritativeSnapshot = snapshot;
        if (!entry.clientState.remoteSynced) return;
        const currentStateVector = bytesToBase64(Y.encodeStateVector(entry.doc));
        transition(entry, {
          type: 'authoritative_snapshot',
          documentSequence: snapshot.documentSequence,
          checkpointSequence: snapshot.checkpointSequence,
          stateVector: snapshot.stateVector,
          matchesCurrentDocument: currentStateVector === snapshot.stateVector,
        });
        if (snapshot.checkpointSequence > 0) {
          entry.provider?.sendStateless(JSON.stringify({
            type: 'checkpoint_ack',
            documentId: snapshot.documentId,
            lifecycleGeneration: snapshot.lifecycleGeneration,
            sequence: snapshot.checkpointSequence,
          }));
        }
      };
      const provider = new HocuspocusProvider({
        url: websocketUrl(session.websocketUrl),
        preserveTrailingSlash: true,
        name: session.documentName,
        document: entry.doc,
        token: async () => {
          if (Date.parse(session.expiresAt) - Date.now() < 30_000) {
            const refreshed = requireTextSession(await requestSession(path, 'auto'), representation);
            if (
              refreshed.documentId !== session.documentId
              || refreshed.lifecycleGeneration !== session.lifecycleGeneration
            ) {
              throw new Error('The collaboration document generation changed. Reload to use the current document state.');
            }
            session = refreshed;
            entry.session = session;
          }
          return session.token;
        },
        flushDelay: 75,
        onStatus: ({ status }) => {
          transition(entry, {
            type: 'provider_status',
            status: status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected',
            permission: session.permission,
          });
        },
        onSynced: () => {
          transition(entry, { type: 'remote_synced', permission: session.permission });
          if (entry.pendingAuthoritativeSnapshot) {
            reconcileAuthoritativeSnapshot(entry.pendingAuthoritativeSnapshot);
          }
        },
        onUnsyncedChanges: ({ number }) => {
          transition(entry, { type: 'unsynced_changes', count: number });
        },
        onAuthenticationFailed: ({ reason }) => {
          transition(entry, {
            type: 'authentication_failed',
            message: reason || 'Collaboration authentication failed.',
          });
        },
        onStateless: ({ payload }) => {
          try {
            const message = JSON.parse(payload) as {
              type?: string;
              message?: string;
              sequence?: number;
              stateVector?: string;
              documentId?: string;
              lifecycleGeneration?: number;
              documentSequence?: number;
              checkpointSequence?: number;
            };
            if (message.type === 'degraded') {
              transition(entry, { type: 'degraded', message: message.message || 'Checkpoint failed.' });
              return;
            }
            if (message.type === 'durability_snapshot') {
              const snapshot = durabilitySnapshot(message);
              if (snapshot) reconcileAuthoritativeSnapshot(snapshot);
              return;
            }
            if (
              message.type === 'checkpointed'
              && Number.isSafeInteger(message.sequence)
              && typeof message.stateVector === 'string'
              && entry.doc
            ) {
              reconcileAuthoritativeSnapshot({
                documentId: message.documentId || session.documentId,
                lifecycleGeneration: message.lifecycleGeneration ?? session.lifecycleGeneration,
                documentSequence: message.documentSequence ?? message.sequence as number,
                checkpointSequence: message.checkpointSequence ?? message.sequence as number,
                stateVector: message.stateVector,
              });
              return;
            }
            if (message.type === 'checkpoint_superseded' && Number.isSafeInteger(message.sequence)) {
              const snapshot = durabilitySnapshot(message);
              if (snapshot) reconcileAuthoritativeSnapshot(snapshot);
              else transition(entry, {
                type: 'checkpoint_superseded',
                sequence: message.sequence as number,
              });
            }
          } catch {}
        },
      });
      entry.provider = provider;
      entry.requestCheckpoint = () => {
        if (entry.checkpointPromise) return entry.checkpointPromise;
        entry.checkpointPromise = (async () => {
          transition(entry, { type: 'checkpoint_requested' });
          await waitForEntryState(
            entry,
            (state) => state.ready && state.unsyncedChanges === 0,
            10_000,
          );
          if (!entry.doc || !entry.session) throw new Error('Collaboration is not ready.');
          const stateVector = bytesToBase64(Y.encodeStateVector(entry.doc));
          if (
            entry.clientState.durability === 'checkpointed_file'
            && entry.clientState.checkpointStateVector === stateVector
          ) {
            return;
          }

          if (Date.parse(entry.session.expiresAt) - Date.now() < 30_000) {
            const refreshed = requireTextSession(await requestSession(path, 'auto'), representation);
            if (
              refreshed.documentId !== entry.session.documentId
              || refreshed.lifecycleGeneration !== entry.session.lifecycleGeneration
            ) {
              throw new Error('The collaboration document generation changed. Reload to use the current document state.');
            }
            entry.session = refreshed;
            session = refreshed;
          }

          let lastError = 'Checkpoint is waiting for the latest Yjs persistence.';
          let lastErrorCode: string | null = null;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            const response = await fetch('/api/files/collaboration/checkpoint', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
              body: JSON.stringify({ token: entry.session.token, stateVector }),
            });
            const payload = await response.json().catch(() => ({})) as Record<string, unknown> & {
              code?: string;
              error?: string;
            };
            const snapshot = durabilitySnapshot(payload);
            if (
              response.ok
              && snapshot
              && snapshot.documentId === entry.session.documentId
              && snapshot.lifecycleGeneration === entry.session.lifecycleGeneration
            ) {
              reconcileAuthoritativeSnapshot(snapshot);
              return;
            }
            lastError = response.ok
              ? 'Checkpoint response did not contain a valid authoritative collaboration snapshot.'
              : payload.error || lastError;
            lastErrorCode = typeof payload.code === 'string' ? payload.code : null;
            if (response.status !== 409) break;
            await new Promise((resolve) => window.setTimeout(resolve, 200));
          }
          throw lastErrorCode
            ? new CollaborationCheckpointRequestError(lastErrorCode, lastError)
            : new Error(lastError);
        })().catch((error) => {
          const message = error instanceof Error ? error.message : 'Checkpoint failed.';
          transition(entry, { type: 'checkpoint_failed', message });
          throw error;
        }).finally(() => {
          entry.checkpointPromise = undefined;
        });
        return entry.checkpointPromise;
      };
      provider.setAwarenessField('canvas', {
        userId: session.user.id,
        displayName: session.user.name,
        color: session.user.color,
        colorLight: session.user.colorLight,
        activity: session.permission === 'write' ? 'editing' : 'viewing',
      });
      emit(entry);
    } catch (error) {
      transition(entry, {
        type: 'degraded',
        message: error instanceof Error ? error.message : 'Collaboration could not be started.',
      });
    }
  })();
  return entry;
}

function snapshot(entry: RegistryEntry): CollaborationDocument {
  if (!entry.doc) throw new Error('Collaboration document is not initialized.');
  return {
    registryKey: entry.key,
    doc: entry.doc,
    provider: entry.provider,
    session: entry.session,
    status: textCollaborationLegacyStatus(entry.clientState),
    clientState: entry.clientState,
    connection: entry.clientState.connection,
    durability: entry.clientState.durability,
    ready: entry.clientState.ready && Boolean(entry.provider),
    error: entry.clientState.error,
    setComposition: entry.setComposition,
    requestCheckpoint: entry.requestCheckpoint,
  };
}

export function useCollaborationDocument(input: {
  enabled: boolean;
  workspaceId: string | null;
  path: string | undefined;
  representation: TextCollaborationRepresentation;
  session?: CollaborationSessionResponse | null;
}): CollaborationDocument | null {
  const key = input.enabled && input.workspaceId && input.path
    ? input.session
      ? `${input.workspaceId}\0${input.path}\0${input.session.documentId}\0${input.session.lifecycleGeneration}\0${input.representation}`
      : `${input.workspaceId}\0${input.path}\0${input.representation}`
    : null;
  const [state, setState] = useState<CollaborationDocument | null>(null);
  useEffect(() => {
    if (!key || !input.path) {
      return;
    }
    let entry = registry.get(key);
    if (!entry) {
      entry = createEntry(key, input.path, input.representation, input.session);
      registry.set(key, entry);
    }
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.refs += 1;
    const update = () => setState(entry.doc ? snapshot(entry) : null);
    entry.listeners.add(update);
    update();
    return () => {
      entry.listeners.delete(update);
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.cleanupTimer = setTimeout(() => {
          if (entry.refs !== 0) return;
          entry.provider?.destroy();
          entry.persistence?.destroy();
          entry.doc?.destroy();
          registry.delete(key);
        }, 1_000);
      }
    };
  }, [input.path, input.representation, input.session, key]);
  return key && state?.registryKey === key ? state : null;
}

export type TextCollaborationSessionResolution = {
  session: CollaborationSessionResponse | null;
  loading: boolean;
  error: string | null;
  retry: () => void;
};

/**
 * Resolves the durable Yjs representation before an editor selects its root
 * type. This is intentionally separate from the WebSocket registry so the
 * UI can choose CodeMirror or Tiptap without making an unsafe first guess.
 */
export function useTextCollaborationSession(input: {
  enabled: boolean;
  workspaceId: string | null;
  path: string | undefined;
}): TextCollaborationSessionResolution {
  const key = input.enabled && input.workspaceId && input.path
    ? `${input.workspaceId}\0${input.path}`
    : null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    attempt: number;
    session: CollaborationSessionResponse | null;
    error: string | null;
  }>({ key: null, attempt: -1, session: null, error: null });

  useEffect(() => {
    if (!key || !input.path) {
      return;
    }
    let cancelled = false;
    void requestSession(input.path, 'auto')
      .then((session) => requireTextSession(session))
      .then((session) => {
        if (!cancelled) setState({ key, attempt, session, error: null });
      })
      .catch((error) => {
        if (!cancelled) {
          setState({
            key,
            attempt,
            session: null,
            error: error instanceof Error ? error.message : 'Collaboration could not be started.',
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [input.path, key, attempt]);

  const current = state.key === key && state.attempt === attempt ? state : { session: null, error: null };
  return {
    session: current.session,
    loading: Boolean(key) && !current.session && !current.error,
    error: current.error,
    retry: () => setAttempt((currentAttempt) => currentAttempt + 1),
  };
}
