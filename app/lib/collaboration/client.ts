'use client';

import { useEffect, useState } from 'react';

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { collaborationStateProof, isCollaborationStateProof } from './state-proof';
import { createDocumentAwarenessLease } from './document-awareness';
import { workspaceHeaders } from '@/app/lib/files/client';
import { fileGuestApi } from '@/app/lib/file-guests/types';
import { CollaborationCheckpointRequestError, isCollaborationCheckpointValidationErrorCode } from './checkpoint-errors';
import { COLLABORATION_FAILURE_CODES, isCollaborationProjectionErrorCode } from './failure';
import { hasExportedCollaborationRecovery, prepareRecoverableCollaborationTransition, preserveLocalCollaborationRecovery } from './local-recovery';
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
  doc: Y.Doc;
  provider: HocuspocusProvider | null;
  persistence: IndexeddbPersistence | null;
  session: CollaborationSessionResponse | null;
  clientState: TextCollaborationClientState;
  listeners: Set<() => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  cleanupPromise?: Promise<void>;
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

function hasCurrentPersistedSnapshot(entry: RegistryEntry): boolean {
  return (entry.clientState.durability === 'persisted_yjs' || entry.clientState.durability === 'checkpointed_file')
    && entry.clientState.unsyncedChanges === 0
    && isCollaborationStateProof(entry.clientState.persistedStateProof)
    && entry.clientState.persistedStateProof === collaborationStateProof(entry.doc, Y);
}

/** Read the live registry, not a potentially stale React view snapshot. */
export function hasCurrentPersistedCollaborationDocument(document: CollaborationDocument | null | undefined): boolean {
  if (!document?.session) return false;
  const entry = registry.get(document.registryKey);
  return Boolean(entry && !entry.lifecycle.signal.aborted && entry.doc === document.doc
    && entry.session?.documentId === document.session.documentId
    && entry.session.lifecycleGeneration === document.session.lifecycleGeneration
    && entry.session.representation === document.session.representation
    && entry.session.permission === document.session.permission && hasCurrentPersistedSnapshot(entry));
}

export async function prepareCollaborationDocumentTransition(document: CollaborationDocument): Promise<void> {
  const entry = registry.get(document.registryKey);
  if (!entry || entry.doc !== document.doc) throw new Error('Collaboration is still connecting.');
  const scope = entry.requests;
  const assertCurrent = () => {
    assertRequestActive(entry, scope);
    if (!document.session || entry.session?.documentId !== document.session.documentId
      || entry.session.lifecycleGeneration !== document.session.lifecycleGeneration
      || entry.session.representation !== document.session.representation
      || entry.session.permission !== document.session.permission) {
      throw new Error('Collaboration document changed. Please retry.');
    }
  };
  assertCurrent();
  const backup: { snapshot?: Uint8Array } = {};
  await prepareRecoverableCollaborationTransition({
    doc: document.doc,
    isPersistedCurrent: () => hasCurrentPersistedSnapshot(entry),
    preserveLocalSnapshot: async () => {
      if (!entry.persistence) throw new Error('Local collaboration storage is unavailable.');
      backup.snapshot = await preserveLocalCollaborationRecovery(entry.persistence, document.doc);
    },
  });
  assertCurrent();
  if (hasCurrentPersistedSnapshot(entry) || hasExportedCollaborationRecovery(entry.doc)) return;
  const current = Y.encodeStateAsUpdate(entry.doc);
  if (!backup.snapshot || backup.snapshot.length !== current.length
    || !backup.snapshot.every((byte, index) => byte === current[index])) {
    throw new Error('The document changed while its local backup was being saved.');
  }
}

function assertEntryActive(entry: RegistryEntry): void {
  if (entry.lifecycle.signal.aborted || registry.get(entry.key) !== entry) {
    throw new Error('Collaboration document was closed.');
  }
}

function disposeEntry(entry: RegistryEntry): void {
  if (entry.lifecycle.signal.aborted || entry.refs !== 0 || entry.cleanupPromise) return;
  const cleanup = (async () => {
    let localSnapshot: Uint8Array | null = null;
    const state = Y.encodeStateAsUpdate(entry.doc);
    const empty = state.length === 2 && state[0] === 0 && state[1] === 0;
    if (!empty && !hasCurrentPersistedSnapshot(entry) && !hasExportedCollaborationRecovery(entry.doc)) {
      // IndexedDB's destroy() closes its connection; it does not acknowledge an
      // outstanding write. Keep the document alive until a full snapshot commits.
      if (!entry.persistence?.synced) await entry.startPromise;
      if (entry.refs !== 0 || entry.lifecycle.signal.aborted) return;
      if (!entry.persistence) throw new Error('Local collaboration storage is unavailable.');
      localSnapshot = await preserveLocalCollaborationRecovery(entry.persistence, entry.doc);
    }
    // A view may have reacquired this exact document while storage was pending.
    if (entry.refs !== 0 || entry.lifecycle.signal.aborted) return;
    if (localSnapshot && !hasCurrentPersistedSnapshot(entry)) {
      const current = Y.encodeStateAsUpdate(entry.doc);
      if (localSnapshot.length !== current.length || !localSnapshot.every((byte, index) => byte === current[index])) {
        throw new Error('The local collaboration backup was superseded.');
      }
    }
    entry.lifecycle.abort();
    entry.requests.abort();
    entry.provider?.destroy();
    void Promise.resolve(entry.persistence?.destroy()).catch(() => undefined);
    entry.doc.destroy();
    if (registry.get(entry.key) === entry) registry.delete(entry.key);
  })().catch(() => {
    // A failed local commit must not discard the last surviving copy. Reopening
    // the document reuses this registry entry; its next close retries the backup.
    console.warn('[collaboration-client]', { event: 'document_retained', documentId: entry.session?.documentId,
      generation: entry.session?.lifecycleGeneration, code: 'LOCAL_SNAPSHOT_UNCONFIRMED' });
  }).finally(() => {
    if (entry.cleanupPromise === cleanup) entry.cleanupPromise = undefined;
  });
  entry.cleanupPromise = cleanup;
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
  guestInvitationId?: string,
): Promise<CollaborationSessionResponse> {
  signal?.throwIfAborted();
  const response = await fetch(guestInvitationId ? `${fileGuestApi(guestInvitationId)}/session` : '/api/files/collaboration/session', {
    signal,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(guestInvitationId ? {} : workspaceHeaders(workspaceId)) },
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
  const refreshed = requireTextSession(await requestSession(entry.path, 'auto', entry.key.split('\0')[0], scope.signal, previous.guestAccess?.invitationId),
    previous.representation as TextCollaborationRepresentation);
  assertRequestActive(entry, scope);
  if (refreshed.documentId !== previous.documentId || refreshed.lifecycleGeneration !== previous.lifecycleGeneration
    || refreshed.documentName !== previous.documentName) {
    throw new CollaborationCheckpointRequestError(COLLABORATION_FAILURE_CODES.generationChanged,
      'The collaboration document generation changed. Reload to use the current document state.');
  }
  entry.session = refreshed;
}

/** A validated session may move the open document, never replace its Yjs state. */
function adoptEntryLocation(entry: RegistryEntry, path: string, session: CollaborationSessionResponse): void {
  const previous = entry.session;
  requireTextSession(session, previous?.representation as TextCollaborationRepresentation | undefined);
  if (!previous || session.documentId !== previous.documentId || session.lifecycleGeneration !== previous.lifecycleGeneration
    || session.documentName !== previous.documentName) throw new Error('Collaboration document identity changed.');
  // Reusing the same open path must still observe a server permission downgrade.
  // An old view snapshot can never restore write access after a denial.
  if (entry.path === path && !(previous.permission === 'write' && session.permission === 'read')) return;
  entry.requests.abort();
  entry.requests = new AbortController();
  entry.checkpointPromise = undefined;
  entry.provider?.destroy();
  entry.provider = null;
  entry.path = path;
  entry.session = session;
  entry.pendingAuthoritativeSnapshot = durabilitySnapshot(session) ?? undefined;
  const locationRecovered = entry.clientState.failure?.kind === 'lifecycle';
  entry.clientState = { ...entry.clientState, remoteSynced: false, ready: false,
    checkpointStateVector: null, checkpointStateProof: null, persistedStateProof: null,
    connection: session.permission === 'read' ? 'read_only' : 'reconnecting',
    error: locationRecovered ? null : entry.clientState.error,
    failure: locationRecovered ? null : entry.clientState.failure,
    durability: entry.clientState.durability === 'degraded' && !locationRecovered ? 'degraded'
      : entry.clientState.unsyncedChanges > 0 ? 'local_pending' : 'server_received' };
  entry.startProvider?.();
  emit(entry);
}

function createEntry(
  key: string,
  path: string,
  representation: TextCollaborationRepresentation,
  workspaceId: string,
  initialSession?: CollaborationSessionResponse | null,
): RegistryEntry {
  const guestInvitationId = initialSession?.guestAccess?.invitationId;
  const entry: RegistryEntry = {
    key,
    path,
    lifecycle: new AbortController(),
    requests: new AbortController(),
    refs: 0,
    // Keep startup failures observable even if a transport/storage module fails
    // to load. Readiness and local hydration still gate editing and recovery.
    doc: new Y.Doc({ gc: true }),
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
      const [{ HocuspocusProvider }, { IndexeddbPersistence }] = await Promise.all([
        import('@hocuspocus/provider'),
        import('y-indexeddb'),
      ]);
      if (entry.lifecycle.signal.aborted || registry.get(key) !== entry) return;
      const session = requireTextSession(
        entry.session || await requestSession(entry.path, representation, workspaceId, entry.requests.signal, guestInvitationId),
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
        `canvas:${guestInvitationId ? `guest:${guestInvitationId}:` : ''}${session.documentId}:${session.lifecycleGeneration}:${representation}`,
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
          || snapshot.documentSequence < (entry.clientState.documentSequence ?? -1)
        ) return false;
        const previous = entry.pendingAuthoritativeSnapshot;
        if (previous && (snapshot.documentSequence < previous.documentSequence
          || (snapshot.documentSequence === previous.documentSequence
            && (snapshot.checkpointSequence < previous.checkpointSequence
              || snapshot.stateProof !== previous.stateProof)))) return false;
        entry.pendingAuthoritativeSnapshot = snapshot;
        if (!entry.clientState.remoteSynced) return true;
        const matchesCurrentDocument = collaborationStateProof(entry.doc, Y) === snapshot.stateProof;
        transition(entry, {
          type: 'authoritative_snapshot',
          documentSequence: snapshot.documentSequence,
          checkpointSequence: snapshot.checkpointSequence,
          stateVector: snapshot.stateVector,
          stateProof: snapshot.stateProof,
          matchesCurrentDocument,
        });
        const confirmed = entry.clientState;
        if (confirmed.ready && confirmed.unsyncedChanges === 0
          && confirmed.persistedStateProof === snapshot.stateProof
          && confirmed.documentSequence === snapshot.documentSequence
          && (confirmed.durability === 'persisted_yjs' || confirmed.durability === 'checkpointed_file')
          && (confirmed.connection === 'live' || confirmed.connection === 'read_only')) {
          // This only reports which persisted Yjs state this peer has observed.
          // The proof includes deletes; a matching state vector alone is insufficient.
          entry.provider?.sendStateless(JSON.stringify({
            type: 'durability_ack',
            documentId: snapshot.documentId,
            lifecycleGeneration: snapshot.lifecycleGeneration,
            sequence: snapshot.documentSequence,
          }));
          // Retain the projection acknowledgement for older servers.
          if (snapshot.checkpointSequence > 0) entry.provider?.sendStateless(JSON.stringify({
            type: 'checkpoint_ack',
            documentId: snapshot.documentId,
            lifecycleGeneration: snapshot.lifecycleGeneration,
            sequence: snapshot.checkpointSequence,
          }));
        }
        return true;
      };
      entry.doc.on('update', () => {
        // Invalidate immediately, before the provider batches/sends the change.
        transition(entry, { type: 'document_changed' });
        if (entry.pendingAuthoritativeSnapshot) reconcileAuthoritativeSnapshot(entry.pendingAuthoritativeSnapshot);
      });
      const denyAccess = (message: string) => {
        if (entry.session) entry.session = { ...entry.session, permission: 'read' };
        entry.provider?.disconnect();
        transition(entry, { type: 'authentication_failed', message });
      };
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
            denyAccess(reason || 'Collaboration authentication failed.');
          },
          onStateless: ({ payload }) => {
            if (!active()) return;
            try {
              const message = JSON.parse(payload) as {
                type?: string;
                message?: string;
                code?: string;
                sequence?: number;
                stateVector?: string;
                stateProof?: string;
                documentId?: string;
                lifecycleGeneration?: number;
                documentSequence?: number;
                checkpointSequence?: number;
              };
              if (message.type === 'access_revoked' || message.type === 'update_rejected') {
                denyAccess(message.message || 'File access was revoked. Local changes are preserved.');
                return;
              }
              if (message.type === 'degraded') {
                if ((message.documentId !== undefined && message.documentId !== session.documentId)
                  || (message.lifecycleGeneration !== undefined && message.lifecycleGeneration !== session.lifecycleGeneration)
                  || (message.documentSequence !== undefined && (!Number.isSafeInteger(message.documentSequence)
                    || message.documentSequence < (entry.clientState.documentSequence ?? -1)))) return;
                if (isCollaborationProjectionErrorCode(message.code) && message.stateProof !== undefined) {
                  const snapshot = durabilitySnapshot(message);
                  if (snapshot && reconcileAuthoritativeSnapshot(snapshot)) {
                    transition(entry, { type: 'projection_failed', sequence: snapshot.documentSequence, code: message.code });
                  }
                  return;
                }
                transition(entry, { type: 'degraded', message: message.message || 'Checkpoint failed.', code: message.code });
                return;
              }
              if (message.type === 'projection_failed') {
                const snapshot = durabilitySnapshot(message);
                if (!snapshot || !reconcileAuthoritativeSnapshot(snapshot)) return;
                if (message.code !== undefined && !isCollaborationProjectionErrorCode(message.code)) {
                  if (message.code === COLLABORATION_FAILURE_CODES.authenticationFailed) denyAccess('Collaboration authentication failed.');
                  else transition(entry, { type: 'degraded', message: 'The shared document could not be validated.', code: message.code });
                } else {
                  transition(entry, { type: 'projection_failed', sequence: snapshot.documentSequence, code: message.code });
                }
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
        let requestedStateProof: string | null = null;
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
          requestedStateProof = stateProof;
          let lastError = 'Checkpoint is waiting for the latest Yjs persistence.';
          let lastErrorCode: string | null = null;
          for (let attempt = 0; attempt < 20; attempt += 1) {
            assertRequestActive(entry, scope);
            const response = await fetch(guestInvitationId ? `${fileGuestApi(guestInvitationId)}/checkpoint` : '/api/files/collaboration/checkpoint', {
              signal: scope.signal,
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...(guestInvitationId ? {} : workspaceHeaders(workspaceId)) },
              body: JSON.stringify({ token: entry.session.token, stateVector, stateProof }),
            });
            const payload = await response.json().catch(() => ({})) as Record<string, unknown> & {
              code?: string;
              error?: string;
            };
            assertRequestActive(entry, scope);
            const snapshot = durabilitySnapshot(payload);
            if (!response.ok && isCollaborationProjectionErrorCode(payload.code)
              && snapshot && reconcileAuthoritativeSnapshot(snapshot)) {
              transition(entry, { type: 'projection_failed', sequence: snapshot.documentSequence, code: payload.code });
            }
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
            lastErrorCode = response.status === 401 || response.status === 403
              ? COLLABORATION_FAILURE_CODES.authenticationFailed : typeof payload.code === 'string' ? payload.code : null;
            if (response.status !== 409 || lastErrorCode === COLLABORATION_FAILURE_CODES.generationChanged) break;
            await new Promise((resolve) => window.setTimeout(resolve, 200));
          }
          throw lastErrorCode
            ? new CollaborationCheckpointRequestError(lastErrorCode, lastError)
            : new Error(lastError);
        })().catch((error) => {
          const requestCode = error instanceof CollaborationCheckpointRequestError ? error.code : undefined;
          const authenticationFailed = requestCode === COLLABORATION_FAILURE_CODES.authenticationFailed;
          const generationChanged = requestCode === COLLABORATION_FAILURE_CODES.generationChanged;
          const projectionFailed = isCollaborationProjectionErrorCode(requestCode);
          // Another checkpoint may have confirmed the exact current document
          // while this HTTP request was pending. Its later failure is obsolete.
          if (!authenticationFailed && !generationChanged && scope === entry.requests && !scope.signal.aborted
            && entry.clientState.durability === 'checkpointed_file') return;
          const message = error instanceof Error ? error.message : 'Checkpoint failed.';
          if (scope === entry.requests && !scope.signal.aborted) {
            if (authenticationFailed) denyAccess(message);
            else if (projectionFailed) {
              if (requestedStateProof && requestedStateProof === collaborationStateProof(entry.doc, Y)) {
                transition(entry, { type: 'checkpoint_failed', message, code: requestCode });
              }
            } else transition(entry, { type: generationChanged || (requestCode && isCollaborationCheckpointValidationErrorCode(requestCode))
              ? 'degraded' : 'checkpoint_failed', message, code: requestCode });
          }
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
        code: COLLABORATION_FAILURE_CODES.startupFailed,
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

function takeRetainedEntry(key: string, workspaceId: string, session: CollaborationSessionResponse): RegistryEntry | undefined {
  const entry = [...registry.values()].find((candidate) => {
    const previous = candidate.session;
    return candidate.refs === 0 && !candidate.lifecycle.signal.aborted && !candidate.doc.isDestroyed
      && candidate.key.split('\0')[0] === workspaceId && previous
      && previous.user.id === session.user.id
      && (previous.guestAccess?.invitationId ?? null) === (session.guestAccess?.invitationId ?? null)
      && (previous.guestAccess?.workspaceId ?? null) === (session.guestAccess?.workspaceId ?? null)
      && previous.documentId === session.documentId && previous.documentName === session.documentName
      && previous.lifecycleGeneration === session.lifecycleGeneration
      && previous.schemaVersion === session.schemaVersion && previous.richTextSchemaVersion === session.richTextSchemaVersion
      && previous.representation === session.representation;
  });
  if (!entry) return undefined;
  // Only an ownerless lifetime may move to a new open-request key. In-flight
  // cleanup checks refs again; old view handles no longer resolve this entry.
  registry.delete(entry.key);
  entry.key = key;
  registry.set(key, entry);
  return entry;
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
      ? `${input.workspaceId}\0${input.session.guestAccess?.invitationId || ''}\0${input.session.user.id}\0${input.documentKey ?? input.path}\0${input.session.documentId}\0${input.session.lifecycleGeneration}\0${input.representation}`
      : input.waitForSession ? state?.owner === owner ? state.key : null
        : `${input.workspaceId}\0${input.path}\0${input.representation}`
    : null;
  useEffect(() => {
    if (!key || !input.path || !input.workspaceId) {
      return;
    }
    let entry = registry.get(key) ?? (input.session
      ? takeRetainedEntry(key, input.workspaceId, input.session) : undefined);
    if (!entry) {
      entry = createEntry(key, input.path, input.representation, input.workspaceId, input.session);
      registry.set(key, entry);
    } else if (input.session) {
      try { adoptEntryLocation(entry, input.path, input.session); }
      catch (error) { transition(entry, { type: 'degraded', code: COLLABORATION_FAILURE_CODES.generationChanged,
        message: error instanceof Error ? error.message : 'Collaboration location changed.' }); }
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
  }, [input.path, input.representation, input.session, input.workspaceId, key, owner]);
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
