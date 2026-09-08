'use client';

import { useEffect, useState } from 'react';

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { IndexeddbPersistence } from 'y-indexeddb';
import type * as Y from 'yjs';

import { collaborationStateProof, isCollaborationStateProof } from './state-proof';
import { createDocumentAwarenessLease } from './document-awareness';
import { workspaceHeaders } from '@/app/lib/files/client';
import { CollaborationCheckpointRequestError, isCollaborationCheckpointValidationErrorCode } from './checkpoint-errors';
import { prepareRecoverableCollaborationTransition, preserveLocalCollaborationRecovery } from './local-recovery';
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
import { COLLABORATION_CLIENT_CAPABILITIES, COLLABORATION_SCHEMA_VERSION, RICH_MARKDOWN_SCHEMA_VERSION,
  isRichTextCollaborationRepresentation, supportsBlockTreeCollaboration } from './types';

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
  stateProof: string;
};

type RegistryEntry = {
  key: string;
  path: string;
  refs: number;
  lifecycle: AbortController;
  requests: AbortController;
  doc: Y.Doc | null;
  provider: HocuspocusProvider | null;
  persistence: IndexeddbPersistence | null;
  session: CollaborationSessionResponse | null;
  clientState: TextCollaborationClientState;
  listeners: Set<() => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  startPromise: Promise<void>;
  startProvider?: () => void;
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

/** Confirm a full local binary backup before creating a potentially lossy recovery copy. */
export async function preserveCollaborationDocumentRecovery(document: CollaborationDocument): Promise<Uint8Array> {
  const entry = registry.get(document.registryKey);
  if (!entry || entry.doc !== document.doc) throw new Error('Collaboration is still connecting.');
  const scope = entry.requests;
  const assertCurrent = () => {
    assertRequestActive(entry, scope);
    if (!document.session || entry.session?.documentId !== document.session.documentId
      || entry.session.lifecycleGeneration !== document.session.lifecycleGeneration
      || entry.session.representation !== document.session.representation) {
      throw new Error('Collaboration document changed. Please retry.');
    }
  };
  assertCurrent();
  if (!entry.persistence) throw new Error('Local collaboration storage is unavailable.');
  // A download being started is not proof that this snapshot has been saved.
  const snapshot = await preserveLocalCollaborationRecovery(entry.persistence, document.doc);
  assertCurrent();
  return snapshot;
}

export async function prepareCollaborationDocumentTransition(document: CollaborationDocument): Promise<void> {
  const entry = registry.get(document.registryKey);
  if (!entry || entry.doc !== document.doc) throw new Error('Collaboration is still connecting.');
  await prepareRecoverableCollaborationTransition({
    doc: document.doc,
    connection: entry.clientState.connection,
    durability: entry.clientState.durability,
    requestCheckpoint: entry.requestCheckpoint,
    isCheckpointCurrent: () => entry.clientState.durability === 'checkpointed_file',
    preserveLocalSnapshot: async () => {
      if (!entry.persistence) throw new Error('Local collaboration storage is unavailable.');
      await preserveLocalCollaborationRecovery(entry.persistence, document.doc);
    },
  });
}

function assertEntryActive(entry: RegistryEntry): void {
  if (entry.lifecycle.signal.aborted || registry.get(entry.key) !== entry) {
    throw new Error('Collaboration document was closed.');
  }
}

function disposeEntry(entry: RegistryEntry): void {
  if (entry.lifecycle.signal.aborted) return;
  entry.lifecycle.abort();
  entry.requests.abort();
  entry.provider?.destroy();
  void Promise.resolve(entry.persistence?.destroy()).catch(() => undefined);
  entry.doc?.destroy();
  if (registry.get(entry.key) === entry) registry.delete(entry.key);
}

function emit(entry: RegistryEntry): void {
  for (const listener of entry.listeners) listener();
}

function transition(entry: RegistryEntry, event: TextCollaborationClientEvent): void {
  if (entry.lifecycle.signal.aborted) return;
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
    || !isCollaborationStateProof(candidate.stateProof)
  ) return null;
  return candidate as CollaborationDurabilitySnapshot;
}

function waitForEntryState(
  entry: RegistryEntry,
  predicate: (state: TextCollaborationClientState) => boolean,
  timeoutMs: number,
  signal = entry.lifecycle.signal,
): Promise<void> {
  if (entry.lifecycle.signal.aborted) return Promise.reject(new Error('Collaboration document was closed.'));
  if (signal.aborted) return Promise.reject(new Error('Collaboration location changed.'));
  if (predicate(entry.clientState)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      entry.listeners.delete(listener);
      signal.removeEventListener('abort', abort);
    };
    const abort = () => { cleanup(); reject(new Error(entry.lifecycle.signal.aborted
      ? 'Collaboration document was closed.' : 'Collaboration location changed.')); };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('Timed out while waiting for collaboration to synchronize.'));
    }, timeoutMs);
    const listener = () => {
      if (!predicate(entry.clientState)) return;
      cleanup();
      resolve();
    };
    entry.listeners.add(listener);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function requestSession(
  path: string,
  representation: RequestedTextCollaborationRepresentation,
  workspaceId: string,
  signal?: AbortSignal,
): Promise<CollaborationSessionResponse> {
  signal?.throwIfAborted();
  const response = await fetch('/api/files/collaboration/session', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders(workspaceId) },
    body: JSON.stringify({ path, representation, ...COLLABORATION_CLIENT_CAPABILITIES }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<CollaborationSessionResponse> & { error?: string };
  signal?.throwIfAborted();
  if (!response.ok || payload.success !== true) throw new Error(payload.error || 'Collaboration could not be started.');
  return payload as CollaborationSessionResponse;
}

function requireTextSession(
  session: CollaborationSessionResponse,
  representation?: TextCollaborationRepresentation,
): CollaborationSessionResponse {
  if (
    session.provider !== 'yjs'
    || session.schemaVersion !== COLLABORATION_SCHEMA_VERSION
    || (session.representation !== 'plain_text' && !isRichTextCollaborationRepresentation(session.representation))
    || (isRichTextCollaborationRepresentation(session.representation) && session.richTextSchemaVersion !== RICH_MARKDOWN_SCHEMA_VERSION)
    || (session.representation === 'tiptap_blocks' && !supportsBlockTreeCollaboration(session))
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

function assertRequestActive(entry: RegistryEntry, scope: AbortController): void {
  assertEntryActive(entry);
  if (scope !== entry.requests || scope.signal.aborted) throw new Error('Collaboration location changed.');
}

async function refreshEntrySession(entry: RegistryEntry, scope: AbortController): Promise<void> {
  assertRequestActive(entry, scope);
  const previous = entry.session;
  if (!previous) throw new Error('Collaboration is not ready.');
  const refreshed = requireTextSession(await requestSession(entry.path, 'auto', entry.key.split('\0')[0], scope.signal),
    previous.representation as TextCollaborationRepresentation);
  assertRequestActive(entry, scope);
  if (refreshed.documentId !== previous.documentId || refreshed.lifecycleGeneration !== previous.lifecycleGeneration
    || refreshed.documentName !== previous.documentName) {
    throw new Error('The collaboration document generation changed. Reload to use the current document state.');
  }
  entry.session = refreshed;
}

/** A validated session may move the open document, never replace its Yjs state. */
function adoptEntryLocation(entry: RegistryEntry, path: string, session: CollaborationSessionResponse): void {
  if (entry.path === path) return;
  const previous = entry.session;
  requireTextSession(session, previous?.representation as TextCollaborationRepresentation | undefined);
  if (!previous || session.documentId !== previous.documentId || session.lifecycleGeneration !== previous.lifecycleGeneration
    || session.documentName !== previous.documentName) throw new Error('Collaboration document identity changed.');
  entry.requests.abort();
  entry.requests = new AbortController();
  entry.checkpointPromise = undefined;
  entry.provider?.destroy();
  entry.provider = null;
  entry.path = path;
  entry.session = session;
  entry.pendingAuthoritativeSnapshot = durabilitySnapshot(session) ?? undefined;
  entry.clientState = { ...entry.clientState, remoteSynced: false, ready: false,
    checkpointStateVector: null, checkpointStateProof: null,
    connection: session.permission === 'read' ? 'read_only' : 'reconnecting',
    durability: entry.clientState.durability === 'degraded' ? 'degraded'
      : entry.clientState.unsyncedChanges > 0 ? 'local_pending' : 'server_received' };
  entry.startProvider?.();
  emit(entry);
}

function createEntry(
  key: string,
  path: string,
  representation: TextCollaborationRepresentation,
  initialSession?: CollaborationSessionResponse | null,
): RegistryEntry {
  const workspaceId = key.split('\0')[0];
  const entry: RegistryEntry = {
    key,
    path,
    lifecycle: new AbortController(),
    requests: new AbortController(),
    refs: 0,
    doc: null,
    provider: null,
    persistence: null,
    session: initialSession ?? null,
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
      if (!provider || entry.lifecycle.signal.aborted) return;
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
      if (entry.lifecycle.signal.aborted || registry.get(key) !== entry) return;
      entry.doc = new Y.Doc({ gc: true });
      const session = requireTextSession(
        entry.session || await requestSession(entry.path, representation, workspaceId, entry.requests.signal),
        representation,
      );
      assertEntryActive(entry);
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
        stateProof: session.stateProof,
      }) ?? undefined;
      const persistence = new IndexeddbPersistence(
        `canvas:${session.documentId}:${session.lifecycleGeneration}:${representation}`,
        entry.doc,
      );
      entry.persistence = persistence;
      await persistence.whenSynced;
      assertEntryActive(entry);
      transition(entry, { type: 'indexeddb_hydrated' });
      const reconcileAuthoritativeSnapshot = (snapshot: CollaborationDurabilitySnapshot) => {
        if (
          entry.lifecycle.signal.aborted
          || !entry.doc
          || !entry.session
          || snapshot.documentId !== entry.session.documentId
          || snapshot.lifecycleGeneration !== entry.session.lifecycleGeneration
        ) return;
        const previous = entry.pendingAuthoritativeSnapshot;
        if (previous && (snapshot.documentSequence < previous.documentSequence
          || (snapshot.documentSequence === previous.documentSequence
            && snapshot.checkpointSequence < previous.checkpointSequence))) return;
        entry.pendingAuthoritativeSnapshot = snapshot;
        if (!entry.clientState.remoteSynced) return;
        const matchesCurrentDocument = collaborationStateProof(entry.doc, Y) === snapshot.stateProof;
        transition(entry, {
          type: 'authoritative_snapshot',
          documentSequence: snapshot.documentSequence,
          checkpointSequence: snapshot.checkpointSequence,
          stateVector: snapshot.stateVector,
          stateProof: snapshot.stateProof,
          matchesCurrentDocument,
        });
        if (matchesCurrentDocument && snapshot.checkpointSequence > 0) {
          entry.provider?.sendStateless(JSON.stringify({
            type: 'checkpoint_ack',
            documentId: snapshot.documentId,
            lifecycleGeneration: snapshot.lifecycleGeneration,
            sequence: snapshot.checkpointSequence,
          }));
        }
      };
      entry.doc.on('update', () => {
        // Invalidate immediately, before the provider batches/sends the change.
        transition(entry, { type: 'document_changed' });
        if (entry.pendingAuthoritativeSnapshot) reconcileAuthoritativeSnapshot(entry.pendingAuthoritativeSnapshot);
      });
      entry.startProvider = () => {
        const scope = entry.requests;
        const active = () => !entry.lifecycle.signal.aborted && scope === entry.requests && !scope.signal.aborted;
        const session = entry.session!;
        const provider = new HocuspocusProvider({
          url: websocketUrl(session.websocketUrl),
          preserveTrailingSlash: true,
          name: session.documentName,
          document: entry.doc!,
          awareness: createDocumentAwarenessLease(entry.doc!),
          token: async () => {
            assertRequestActive(entry, scope);
            if (Date.parse(entry.session!.expiresAt) - Date.now() < 30_000) await refreshEntrySession(entry, scope);
            assertRequestActive(entry, scope);
            return entry.session!.token;
          },
          flushDelay: 75,
          onStatus: ({ status }) => {
            if (!active()) return;
            transition(entry, {
              type: 'provider_status',
              status: status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected',
              permission: entry.session!.permission,
            });
          },
          onSynced: () => {
            if (!active()) return;
            transition(entry, { type: 'remote_synced', permission: entry.session!.permission });
            if (entry.pendingAuthoritativeSnapshot) {
              reconcileAuthoritativeSnapshot(entry.pendingAuthoritativeSnapshot);
            }
          },
          onUnsyncedChanges: ({ number }) => {
            if (!active()) return;
            transition(entry, { type: 'unsynced_changes', count: number });
            if (number === 0 && entry.pendingAuthoritativeSnapshot) {
              reconcileAuthoritativeSnapshot(entry.pendingAuthoritativeSnapshot);
            }
          },
          onAuthenticationFailed: ({ reason }) => {
            if (!active()) return;
            transition(entry, {
              type: 'authentication_failed',
              message: reason || 'Collaboration authentication failed.',
            });
          },
          onStateless: ({ payload }) => {
            if (!active()) return;
            try {
              const message = JSON.parse(payload) as {
                type?: string;
                message?: string;
                sequence?: number;
                stateVector?: string;
                stateProof?: string;
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
                && isCollaborationStateProof(message.stateProof)
                && entry.doc
              ) {
                reconcileAuthoritativeSnapshot({
                  documentId: message.documentId || session.documentId,
                  lifecycleGeneration: message.lifecycleGeneration ?? session.lifecycleGeneration,
                  documentSequence: message.documentSequence ?? message.sequence as number,
                  checkpointSequence: message.checkpointSequence ?? message.sequence as number,
                  stateVector: message.stateVector,
                  stateProof: message.stateProof,
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
        provider.setAwarenessField('canvas', {
          userId: session.user.id,
          displayName: session.user.name,
          color: session.user.color,
          colorLight: session.user.colorLight,
          activity: session.permission === 'write' ? 'editing' : 'viewing',
        });
      };
      entry.requestCheckpoint = () => {
        if (entry.lifecycle.signal.aborted) return Promise.reject(new Error('Collaboration document was closed.'));
        if (entry.checkpointPromise) return entry.checkpointPromise;
        const scope = entry.requests;
        const promise = (async () => {
          transition(entry, { type: 'checkpoint_requested' });
          await waitForEntryState(
            entry,
            (state) => state.ready && state.unsyncedChanges === 0,
            10_000,
            scope.signal,
          );
          assertRequestActive(entry, scope);
          if (!entry.doc || !entry.session) throw new Error('Collaboration is not ready.');
          if (Date.parse(entry.session.expiresAt) - Date.now() < 30_000) {
            await refreshEntrySession(entry, scope);
          }

          const stateVector = bytesToBase64(Y.encodeStateVector(entry.doc));
          const stateProof = collaborationStateProof(entry.doc, Y);
          if (!stateProof) throw new Error('Collaboration is waiting for missing Yjs updates.');
          let lastError = 'Checkpoint is waiting for the latest Yjs persistence.';
          let lastErrorCode: string | null = null;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            assertRequestActive(entry, scope);
            const response = await fetch('/api/files/collaboration/checkpoint', {
              signal: scope.signal,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...workspaceHeaders(workspaceId) },
              body: JSON.stringify({ token: entry.session.token, stateVector, stateProof }),
            });
            const payload = await response.json().catch(() => ({})) as Record<string, unknown> & {
              code?: string;
              error?: string;
            };
            assertRequestActive(entry, scope);
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
          // Another checkpoint may have confirmed the exact current document
          // while this HTTP request was pending. Its later failure is obsolete.
          if (scope === entry.requests && !scope.signal.aborted
            && entry.clientState.durability === 'checkpointed_file') return;
          const message = error instanceof Error ? error.message : 'Checkpoint failed.';
          if (scope === entry.requests && !scope.signal.aborted) transition(entry, { type: error instanceof CollaborationCheckpointRequestError
            && isCollaborationCheckpointValidationErrorCode(error.code) ? 'degraded' : 'checkpoint_failed', message });
          throw error;
        }).finally(() => {
          if (entry.checkpointPromise === promise) entry.checkpointPromise = undefined;
        });
        entry.checkpointPromise = promise;
        return promise;
      };
      entry.startProvider();
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
  /** A host's open lifetime, retained while a rename resolves a new session. */
  documentKey?: string;
  waitForSession?: boolean;
}): CollaborationDocument | null {
  const owner = input.enabled && input.workspaceId && input.path
    ? JSON.stringify([input.workspaceId, input.documentKey ?? input.path]) : null;
  const [state, setState] = useState<{
    owner: string | null; key: string; path: string; document: CollaborationDocument | null;
  } | null>(null);
  const key = input.enabled && input.workspaceId && input.path
    ? input.session
      ? `${input.workspaceId}\0${input.documentKey ?? input.path}\0${input.session.documentId}\0${input.session.lifecycleGeneration}\0${input.representation}`
      : input.waitForSession ? state?.owner === owner ? state.key : null
        : `${input.workspaceId}\0${input.path}\0${input.representation}`
    : null;
  useEffect(() => {
    if (!key || !input.path) {
      return;
    }
    let entry = registry.get(key);
    if (!entry) {
      entry = createEntry(key, input.path, input.representation, input.session);
      registry.set(key, entry);
    } else if (input.session) {
      try { adoptEntryLocation(entry, input.path, input.session); }
      catch (error) { transition(entry, { type: 'degraded', message: error instanceof Error ? error.message : 'Collaboration location changed.' }); }
    }
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.refs += 1;
    const update = () => setState({ owner, key, path: entry.path, document: entry.doc ? snapshot(entry) : null });
    entry.listeners.add(update);
    update();
    return () => {
      entry.listeners.delete(update);
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.cleanupTimer = setTimeout(() => {
          if (entry.refs !== 0) return;
          disposeEntry(entry);
        }, 1_000);
      }
    };
  }, [input.path, input.representation, input.session, key, owner]);
  return key && state?.key === key && state.owner === owner && state.path === input.path
    && (!input.waitForSession || input.session) ? state.document : null;
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
  expectedDocumentId?: string | null;
}): TextCollaborationSessionResolution {
  const key = input.enabled && input.workspaceId && input.path
    ? `${input.workspaceId}\0${input.path}\0${input.expectedDocumentId ?? ''}`
    : null;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    key: string | null;
    attempt: number;
    session: CollaborationSessionResponse | null;
    error: string | null;
  }>({ key: null, attempt: -1, session: null, error: null });

  useEffect(() => {
    if (!key || !input.path || !input.workspaceId) {
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void requestSession(input.path, 'auto', input.workspaceId, controller.signal)
      .then((session) => requireTextSession(session))
      .then((session) => {
        if (input.expectedDocumentId && session.documentId !== input.expectedDocumentId) {
          throw new Error('This file path now belongs to another document. Waiting for the original document location.');
        }
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
      controller.abort();
    };
  }, [input.path, input.workspaceId, input.expectedDocumentId, key, attempt]);

  const current = state.key === key && state.attempt === attempt ? state : { session: null, error: null };
  return {
    session: current.session,
    loading: Boolean(key) && !current.session && !current.error,
    error: current.error,
    retry: () => setAttempt((currentAttempt) => currentAttempt + 1),
  };
}
