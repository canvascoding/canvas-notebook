'use client';

import { useEffect, useRef, useState } from 'react';

import type { HocuspocusProvider } from '@hocuspocus/provider';
import type { IndexeddbPersistence } from 'y-indexeddb';
import * as Y from 'yjs';

import { collaborationStateProof, isCollaborationStateProof } from './state-proof';
import type { RichMigrationRequest } from './representation-migration-contract';
import { captureAgentStateSnapshot, persistedUpdateIncludesAgentSnapshot } from './agent-durability';
import type { CurrentFile } from '../files/types';
import { hasStoredLocalDocument } from './local-document';
import { installCodeMarkConflictPolicy } from './code-mark-policy';
import { fetchLiveDocument, findConnectedOpenedDocument, findOpenedLiveDocument, invalidateOpenedLiveDocument, isLocalOpenedDocumentSession,
  isOpenedDocumentAuthCurrent, LiveDocumentNetworkError, localOpenedDocumentReceipt, localOpenedDocumentSession,
  openedDocumentAuthScope, openedDocumentSessionScope, openedDocumentRequestRevision, rememberOpenedLiveDocument, sameOpenedDocumentSession, subscribeOpenedDocumentAuthInvalidation,
  validateOpenedLiveDocumentSession, hasCurrentOpenedDocumentSessionAuthorization, hasOpenedDocumentLocationSessionReceipt,
  type OpenedDocumentAuthScope } from './opened-document-registry';
import { createDocumentAwarenessLease } from './document-awareness';
import { openedDocumentRetentionLimits, planOpenedDocumentRetention, type OpenedDocumentRetentionTier } from './open-document-retention';
import { workspaceHeaders } from '@/app/lib/files/client';
import { fileGuestApi } from '@/app/lib/file-guests/types';
import { CollaborationCheckpointRequestError, COLLABORATION_CHECKPOINT_ERROR_CODES, isCollaborationCheckpointValidationErrorCode } from './checkpoint-errors';
import { COLLABORATION_FAILURE_CODES, isCollaborationProjectionErrorCode, NATIVE_PEER_ADMISSION_BUSY_REASON } from './failure';
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
  degraded?: boolean;
  projectionError?: { code: string; sequence: number; permanent: boolean };
  projectionFinalized?: boolean;
  schemaValidated?: boolean;
};

type LocationAuthorization = { scope: AbortController; session: CollaborationSessionResponse; path: string;
  authScope: OpenedDocumentAuthScope | null };

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
  authScope: OpenedDocumentAuthScope | null;
  requiresFreshSession: boolean;
  removeAuthListener?: () => void;
  tokenRetryTimer?: ReturnType<typeof setTimeout>;
  clientState: TextCollaborationClientState;
  listeners: Set<() => void>;
  cleanupTimer?: ReturnType<typeof setTimeout>;
  parkedAt?: number;
  tabOwned?: boolean;
  retentionTier?: OpenedDocumentRetentionTier;
  lastActivatedAt?: number;
  backgroundSince?: number;
  retentionEncodedBytes?: number;
  retentionConnectionReady?: boolean;
  retentionReauthenticating?: boolean;
  visibilityPaused?: boolean;
  cleanupPromise?: Promise<void>;
  startPromise: Promise<void>;
  startProvider?: () => void;
  checkpointPromise?: Promise<void>;
  locationRevalidationPromise?: Promise<void>;
  admissionRejoinAttempt?: { scope: AbortController; path: string; authScope: OpenedDocumentAuthScope | null;
    controller: AbortController; promise: Promise<void> };
  pendingAuthoritativeSnapshot?: CollaborationDurabilitySnapshot;
  locationAuthorization?: LocationAuthorization;
  /** Retired HTTP provenance can request authorization, never confirm persistence. */
  locationRevalidationCandidate?: LocationAuthorization;
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
  getMigrationCheckpoint?: () => Omit<RichMigrationRequest, 'requestId'>;
  requestLocationRevalidation?: () => Promise<void>;
  canRevalidateLocation?: boolean;
  revalidatingLocation?: boolean;
  /** A hint may request fresh authorization; it never supplies a ticket or a grant. */
  requestAdmissionRejoin?: () => Promise<void>;
};

const registry = new Map<string, RegistryEntry>();
const PARKED_TEXT_LIMIT = 3;
const PARKED_TEXT_BYTES = 1024 * 1024;
const PARKED_TEXT_MS = 15_000;
let tabOwnership: { workspaceId: string; activePath: string | null; scope: OpenedDocumentAuthScope | null;
  documents: Readonly<Record<string, string | null | undefined>> } | null = null;
let tabRetentionObserved = false, tabRetentionEnabled = true, tabRetentionConstrained = false;
let retentionQueued = false, retentionTimer: ReturnType<typeof setTimeout> | undefined;
let hiddenSince: number | undefined, stopRetentionObservation: (() => void) | undefined;
const retentionNow = () => performance.now();

/** Declares UI ownership only. It never opens a tab or authorizes a provider. */
export function updateOpenedCollaborationTabs(input: {
  workspaceId: string; activePath: string | null; paths: readonly string[]; documentIds?: Readonly<Record<string, string | null | undefined>>;
  constrained: boolean; enabled?: boolean;
}): void {
  tabRetentionObserved = true; tabRetentionEnabled = input.enabled !== false; tabRetentionConstrained = input.constrained;
  tabOwnership = { workspaceId: input.workspaceId, activePath: input.activePath, scope: openedDocumentAuthScope(),
    documents: Object.fromEntries(input.paths.map(path => [path, input.documentIds?.[path]])) };
  for (const entry of registry.values()) {
    if (entry.key.split('\0')[0] === input.workspaceId) entry.tabOwned = currentTabOwnsEntry(entry);
  }
  if (!stopRetentionObservation && typeof document !== 'undefined') {
    const visibility = () => { hiddenSince = document.hidden ? hiddenSince ?? retentionNow() : undefined; scheduleDocumentRetention(); };
    document.addEventListener('visibilitychange', visibility); visibility();
    const removeAuth = subscribeOpenedDocumentAuthInvalidation(() => {
      tabOwnership = null;
      for (const entry of registry.values()) {
        entry.tabOwned = false;
        if (entry.authScope && !isOpenedDocumentAuthCurrent(entry.authScope)) {
          detachEntryTransport(entry);
          if (entry.session) entry.session = { ...entry.session, permission: 'read' };
          transition(entry, { type: 'authentication_failed', message: 'The signed-in session changed. Local changes are preserved.' });
        }
      }
      scheduleDocumentRetention();
    });
    stopRetentionObservation = () => { document.removeEventListener('visibilitychange', visibility); removeAuth(); };
  }
  scheduleDocumentRetention();
}

export function clearOpenedCollaborationTabs(): void {
  tabOwnership = null;
  for (const entry of registry.values()) entry.tabOwned = false;
  stopRetentionObservation?.(); stopRetentionObservation = undefined;
  scheduleDocumentRetention();
}

function currentTabOwnsEntry(entry: RegistryEntry): boolean {
  return Boolean(tabOwnership && tabOwnership.workspaceId === entry.key.split('\0')[0]
    && tabOwnership.scope === entry.authScope && isOpenedDocumentAuthCurrent(entry.authScope)
    && entry.session && tabOwnership.documents[entry.path] === entry.session.documentId);
}

function currentTabActivatesEntry(entry: RegistryEntry): boolean {
  return currentTabOwnsEntry(entry) && tabOwnership?.activePath === entry.path;
}

function detachEntryTransport(entry: RegistryEntry): void {
  entry.parkedAt ??= Date.now();
  entry.requests.abort();
  if (entry.tokenRetryTimer) clearTimeout(entry.tokenRetryTimer);
  entry.tokenRetryTimer = undefined;
  entry.retentionConnectionReady = false;
  entry.retentionReauthenticating = false;
  entry.visibilityPaused = false;
  entry.provider?.destroy(); entry.provider = null;
}

/** Retire the old request scope before the existing provider/token path obtains
 * fresh HTTP authority. Neither a retained Y.Doc nor this helper grants access. */
function startFreshEntryTransport(entry: RegistryEntry, retentionReauthenticating = false): void {
  detachEntryTransport(entry);
  entry.retentionReauthenticating = retentionReauthenticating;
  entry.parkedAt = undefined;
  entry.requests = new AbortController();
  entry.checkpointPromise = undefined;
  entry.requiresFreshSession = true;
  entry.startProvider?.();
}

function restoreEntryPresence(entry: RegistryEntry): void {
  const session = entry.session;
  if (!session || !entry.provider) return;
  entry.provider.setAwarenessField('canvas', { userId: session.user.id, displayName: session.user.name,
    color: session.user.color, colorLight: session.user.colorLight, activity: session.permission === 'write' ? 'editing' : 'viewing' });
}

function scheduleDocumentRetention(): void {
  if (!tabRetentionObserved || retentionQueued) return;
  retentionQueued = true;
  queueMicrotask(() => {
    try { reconcileDocumentRetention(); } finally { retentionQueued = false; }
  });
}

function reconcileDocumentRetention(): void {
  if (retentionTimer) clearTimeout(retentionTimer);
  retentionTimer = undefined;
  const entries = [...registry.values()].filter(entry => !entry.lifecycle.signal.aborted);
  const resumeVisibleEntry = (entry: RegistryEntry) => {
    if (!entry.visibilityPaused || entry.provider || !entry.session || !isOpenedDocumentAuthCurrent(entry.authScope)
      || entry.clientState.admissionBusy || entry.clientState.failure || entry.clientState.connection === 'denied') return;
    entry.visibilityPaused = false;
    // Old token/checkpoint callbacks were retired at pause. A new provider
    // obtains fresh HTTP authority while retaining the same local Yjs document.
    startFreshEntryTransport(entry);
  };
  if (!tabRetentionEnabled) {
    for (const entry of entries) if (entry.refs) resumeVisibleEntry(entry);
    for (const entry of entries) if (!entry.refs && !entry.cleanupTimer) {
      detachEntryTransport(entry); entry.retentionTier = 'warm';
      entry.cleanupTimer = setTimeout(() => { entry.cleanupTimer = undefined; disposeEntry(entry); }, parkTextEntry(entry) ? PARKED_TEXT_MS : 1000);
    }
    return;
  }
  const now = retentionNow(), limits = openedDocumentRetentionLimits(tabRetentionConstrained);
  const plan = planOpenedDocumentRetention({ now, hiddenSince, constrained: tabRetentionConstrained, candidates: entries.map(entry => {
    if (!entry.refs && entry.retentionEncodedBytes === undefined) {
      try { entry.retentionEncodedBytes = Y.encodeStateAsUpdate(entry.doc).byteLength; }
      catch { entry.retentionEncodedBytes = Infinity; }
    }
    return { key: entry.key, active: entry.refs > 0 || currentTabActivatesEntry(entry), open: entry.tabOwned === true,
      authCurrent: isOpenedDocumentAuthCurrent(entry.authScope),
      canKeepWarm: Boolean(entry.session && !entry.session.guestAccess && entry.persistence?.synced && entry.clientState.indexedDbHydrated),
      // Retention reserves resources during fresh authentication; it cannot
      // expose an old HTTP receipt or reuse a ticket for a new connection.
      canKeepLive: Boolean(entry.provider && !entry.requests.signal.aborted
        && !entry.clientState.admissionBusy && !entry.clientState.failure && entry.clientState.durability !== 'degraded'
        && entry.session && Number.isFinite(Date.parse(entry.session.expiresAt))),
      encodedBytes: entry.refs ? 0 : entry.retentionEncodedBytes!,
      lastActivatedAt: entry.lastActivatedAt ?? now, backgroundSince: entry.backgroundSince ?? now };
  }) });
  let nextDeadline = Infinity;
  for (const decision of plan.decisions) {
    const entry = registry.get(decision.key); if (!entry || entry.lifecycle.signal.aborted) continue;
    const previous = entry.retentionTier; entry.retentionTier = decision.tier;
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = undefined;
    if (decision.tier === 'active') {
      if (entry.tabOwned && entry.session && !entry.session.guestAccess) {
        if (hiddenSince === undefined) resumeVisibleEntry(entry);
        else if (now - hiddenSince < limits.hiddenLiveMs) nextDeadline = Math.min(nextDeadline, hiddenSince + limits.hiddenLiveMs);
        else if (entry.provider && !entry.visibilityPaused) {
          entry.provider.awareness?.setLocalState(null);
          entry.provider.configuration?.websocketProvider.cancelWebsocketRetry?.();
          detachEntryTransport(entry);
          entry.visibilityPaused = true;
          entry.requiresFreshSession = true;
          transition(entry, { type: 'provider_status', status: 'disconnected', permission: entry.session.permission });
        }
      }
      continue;
    }
    if (decision.tier === 'live') {
      if (previous !== 'live') entry.provider?.awareness?.setLocalState(null);
      if (!entry.retentionReauthenticating && (entry.requiresFreshSession || Date.parse(entry.session!.expiresAt) - Date.now() < 30_000)) {
        // A short handshake ticket must not silently shorten the five-minute
        // document budget. The ordinary token callback performs the actual
        // current-user/session/workspace check; stale callbacks are aborted.
        startFreshEntryTransport(entry, true);
        entry.provider?.awareness?.setLocalState(null);
      }
      nextDeadline = Math.min(nextDeadline, (entry.backgroundSince ?? now) + limits.backgroundLiveMs,
        entry.retentionReauthenticating ? Infinity : now + Math.max(1, Date.parse(entry.session!.expiresAt) - Date.now() - 29_999),
        hiddenSince === undefined ? Infinity : hiddenSince + limits.hiddenLiveMs);
    } else {
      // Network budgets apply immediately; the existing disposal fence may
      // retain RAM while an unconfirmed local recovery snapshot commits.
      if (entry.provider || !entry.requests.signal.aborted) detachEntryTransport(entry);
      if (decision.tier === 'release') disposeEntry(entry);
    }
  }
  if (Number.isFinite(nextDeadline)) retentionTimer = setTimeout(scheduleDocumentRetention, Math.max(1, nextDeadline - now + 1));
}
const guestSessionAuthorizations = new WeakMap<CollaborationSessionResponse,
  { workspaceId: string; path: string; invitationId: string; revision: number }>();
const guestAuthorizationRevisions = new Map<string, number>();
const guestAuthorizationKey = (workspaceId: string, invitationId: string) => JSON.stringify([workspaceId, invitationId]);
const reviewReadinessListeners = new Set<() => void>();

/** Observe an existing local session only; this never creates or joins a document. */
export function subscribeOpenCollaborationReviewReadiness(listener: () => void): () => void {
  reviewReadinessListeners.add(listener);
  return () => { reviewReadinessListeners.delete(listener); };
}

export function readOpenCollaborationReviewReadiness(input: {
  workspaceId: string | null | undefined; documentId: string | null | undefined; authScope: OpenedDocumentAuthScope | null;
}): 'absent' | 'pending' | 'persisted' {
  if (!input.workspaceId || !input.documentId || !input.authScope) return 'absent';
  let found = false;
  for (const entry of registry.values()) {
    if (entry.lifecycle.signal.aborted || entry.authScope !== input.authScope
      || entry.key.split('\0')[0] !== input.workspaceId || entry.session?.documentId !== input.documentId
      || entry.session.user.id !== input.authScope.userId) continue;
    found = true;
    if (!hasCurrentPersistedSnapshot(entry) || entry.clientState.connection === 'denied') return 'pending';
  }
  return found ? 'persisted' : 'absent';
}

function emitReviewReadiness(): void {
  for (const listener of reviewReadinessListeners) listener();
}

/** The host proves the current file lifetime; the registry proves the native
 * document, authenticated session and local hydration belong to that lifetime. */
export function rememberOpenedCollaborationDocument(document: CollaborationDocument, file: CurrentFile, workspaceId: string): void {
  const entry = registry.get(document.registryKey);
  if (!entry || entry.doc !== document.doc || entry.lifecycle.signal.aborted || !entry.session
    || !entry.clientState.ready || !entry.clientState.indexedDbHydrated || entry.clientState.connection === 'denied'
    || entry.clientState.failure?.kind === 'lifecycle' || entry.path !== file.path
    || entry.key.split('\0')[0] !== workspaceId || !isOpenedDocumentAuthCurrent(entry.authScope)) return;
  entry.tabOwned = currentTabOwnsEntry(entry);
  const stateProof = collaborationStateProof(entry.doc, Y);
  const snapshot = captureAgentStateSnapshot(entry.doc, Y);
  if (stateProof && snapshot) rememberOpenedLiveDocument({ scope: entry.authScope, workspaceId, path: entry.path,
    file, session: entry.session, stateProof, snapshot, connectedSession: () => {
      if (!tabRetentionEnabled || !tabRetentionObserved || !entry.tabOwned || !entry.provider || entry.visibilityPaused || !entry.retentionConnectionReady || entry.lifecycle.signal.aborted
        || registry.get(entry.key) !== entry || entry.requests.signal.aborted || entry.requiresFreshSession
        || !entry.clientState.ready || !entry.clientState.remoteSynced || entry.clientState.admissionBusy || entry.clientState.failure
        || !['live', 'read_only'].includes(entry.clientState.connection) || !isOpenedDocumentAuthCurrent(entry.authScope)) return null;
      if (!entry.refs && !currentTabActivatesEntry(entry) && (entry.retentionTier !== 'live' || retentionNow() - (entry.backgroundSince ?? 0) >= openedDocumentRetentionLimits(tabRetentionConstrained).backgroundLiveMs
        || hiddenSince !== undefined && retentionNow() - hiddenSince >= openedDocumentRetentionLimits(tabRetentionConstrained).hiddenLiveMs)) return null;
      return entry.session;
    } });
}

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
    entry.removeAuthListener?.();
    if (entry.tokenRetryTimer) clearTimeout(entry.tokenRetryTimer);
    entry.provider?.destroy();
    void Promise.resolve(entry.persistence?.destroy()).catch(() => undefined);
    entry.doc.destroy();
    if (registry.get(entry.key) === entry) { registry.delete(entry.key); emitReviewReadiness(); }
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

function parkTextEntry(entry: RegistryEntry): boolean {
  const session = entry.session;
  if (!session || session.guestAccess || !isRichTextCollaborationRepresentation(session.representation)
    || session.degraded || session.projectionError?.permanent
    || !isOpenedDocumentAuthCurrent(entry.authScope) || !entry.persistence?.synced
    || entry.clientState.admissionBusy || entry.clientState.failure
    || Y.encodeStateAsUpdate(entry.doc).byteLength > PARKED_TEXT_BYTES) return false;

  // Starting a provider sets its unsynced counter even without a local edit.
  // An exact session snapshot can remain in RAM while that handshake is pending.
  // This does not confirm saving or sync: adoption still requires fresh HTTP
  // authorization and a new full-state comparison before exposing local content.
  if (!hasCurrentPersistedSnapshot(entry) && (!isCollaborationStateProof(session.stateProof)
    || session.stateProof !== collaborationStateProof(entry.doc, Y))) return false;

  detachEntryTransport(entry);

  const parked = [...registry.values()].filter(candidate => candidate.parkedAt !== undefined && candidate !== entry)
    .sort((a, b) => a.parkedAt! - b.parkedAt!);
  for (const candidate of parked.slice(0, Math.max(0, parked.length - PARKED_TEXT_LIMIT + 1))) {
    disposeEntry(candidate);
  }
  return true;
}


function emit(entry: RegistryEntry): void {
  for (const listener of entry.listeners) listener();
  emitReviewReadiness();
  scheduleDocumentRetention();
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
    || (candidate.degraded !== undefined && typeof candidate.degraded !== 'boolean')
    || (candidate.projectionFinalized !== undefined && typeof candidate.projectionFinalized !== 'boolean')
    || (candidate.schemaValidated !== undefined && typeof candidate.schemaValidated !== 'boolean')
    || (candidate.projectionError !== undefined && (!candidate.projectionError || typeof candidate.projectionError !== 'object'
      || typeof candidate.projectionError.code !== 'string' || typeof candidate.projectionError.permanent !== 'boolean'
      || !Number.isSafeInteger(candidate.projectionError.sequence) || candidate.projectionError.sequence < 0
      || candidate.projectionError.sequence > (candidate.documentSequence ?? -1)))
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
  retryAuthorizationChange = true,
  startupRetriesRemaining = 2,
): Promise<CollaborationSessionResponse> {
  signal?.throwIfAborted();
  const authScope = guestInvitationId ? null : openedDocumentAuthScope();
  const authorizationRevision = openedDocumentRequestRevision();
  const guestKey = guestInvitationId ? guestAuthorizationKey(workspaceId, guestInvitationId) : null;
  const guestRevision = guestKey ? guestAuthorizationRevisions.get(guestKey) ?? 0 : 0;
  const body = JSON.stringify({ path, representation, ...COLLABORATION_CLIENT_CAPABILITIES });
  for (;;) {
    const response = await fetchLiveDocument(guestInvitationId ? `${fileGuestApi(guestInvitationId)}/session` : '/api/files/collaboration/session', {
      signal,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(guestInvitationId ? {} : workspaceHeaders(workspaceId)) },
      body,
    });
    const payload = await response.json().catch(() => ({})) as Partial<Omit<CollaborationSessionResponse, 'success'>>
      & { success?: boolean; error?: string; code?: string; retryable?: boolean };
    signal?.throwIfAborted();
    if (authScope && !isOpenedDocumentAuthCurrent(authScope)) throw new Error('The signed-in session changed.');
    if (!response.ok || payload.success !== true) {
      // Only the server's completed, pre-mutation read boundary may request a
      // fresh startup attempt. A Busy code alone (including Guest) is insufficient.
      const retryableStartup = !guestInvitationId && Boolean(authScope) && response.status === 409 && payload.success === false
        && (payload.code === 'PRINCIPAL_BUSY' || payload.code === 'NATIVE_SESSION_BUSY') && payload.retryable === true
        && openedDocumentRequestRevision() === authorizationRevision;
      if (retryableStartup && authScope && startupRetriesRemaining > 0
        && openedDocumentRequestRevision() === authorizationRevision) {
        startupRetriesRemaining--;
        await new Promise<void>((resolve, reject) => {
          const aborted = () => {
            clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener('abort', aborted); resolve();
          }, (2 - startupRetriesRemaining) * 150);
          signal?.addEventListener('abort', aborted, { once: true });
          if (signal?.aborted) aborted();
        });
        signal?.throwIfAborted();
        if (!isOpenedDocumentAuthCurrent(authScope)) throw new Error('The signed-in session changed.');
        if (openedDocumentRequestRevision() !== authorizationRevision) throw new Error('The document access changed while loading.');
        continue;
      }
      if (!guestInvitationId) invalidateOpenedLiveDocument(workspaceId, { path }, authScope);
      throw Object.assign(new Error(payload.error || 'Collaboration could not be started.'), {
        status: response.status,
        code: typeof payload.code === 'string' ? payload.code : null,
        retryable: retryableStartup,
      });
    }
    if (authScope && payload.user?.id !== authScope.userId) throw new Error('The signed-in user changed.');
    if (authScope && !validateOpenedLiveDocumentSession(workspaceId, path,
      payload as CollaborationSessionResponse, authScope, authorizationRevision)) {
      // A concurrent location check can retire the old path while this request
      // resolves the new one. Require a new authoritative response after that fence.
      if (retryAuthorizationChange) return requestSession(path, representation, workspaceId, signal, guestInvitationId, false, startupRetriesRemaining);
      throw new Error('The document access changed while loading.');
    }
    if (guestKey && guestRevision !== (guestAuthorizationRevisions.get(guestKey) ?? 0)) {
      if (retryAuthorizationChange) return requestSession(path, representation, workspaceId, signal, guestInvitationId, false, startupRetriesRemaining);
      throw new Error('The guest document access changed while loading.');
    }
    if (guestInvitationId) guestSessionAuthorizations.set(payload as CollaborationSessionResponse,
      { workspaceId, path, invitationId: guestInvitationId, revision: guestRevision });
    return payload as CollaborationSessionResponse;
  }
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
  if (entry.clientState.admissionBusy) throw new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
    entry.clientState.error || 'Collaboration is busy. Local changes are preserved.');
  const previous = entry.session;
  if (!previous) throw new Error('Collaboration is not ready.');
  const refreshed = requireTextSession(await requestSession(entry.path, 'auto', entry.key.split('\0')[0], scope.signal, previous.guestAccess?.invitationId),
    previous.representation as TextCollaborationRepresentation);
  assertRequestActive(entry, scope);
  if (entry.clientState.admissionBusy) throw new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
    entry.clientState.error || 'Collaboration is busy. Local changes are preserved.');
  if (!sameOpenedDocumentSession(refreshed, previous)) {
    throw new CollaborationCheckpointRequestError(COLLABORATION_FAILURE_CODES.generationChanged,
      'The collaboration document generation changed. Reload to use the current document state.');
  }
  entry.session = refreshed;
  entry.authScope = refreshed.guestAccess ? null : openedDocumentAuthScope();
  const candidate = entry.locationRevalidationCandidate;
  if (candidate && candidate.scope === scope && candidate.path === entry.path && candidate.authScope === entry.authScope
    && sameOpenedDocumentSession(candidate.session, refreshed) && hasFreshLocationSession(entry, entry.path, refreshed)) {
    entry.locationAuthorization = { ...candidate, session: refreshed };
    entry.locationRevalidationCandidate = undefined;
  }
  entry.requiresFreshSession = false;
  if (refreshed.degraded || refreshed.projectionError?.permanent) transition(entry, { type: 'degraded',
    code: refreshed.projectionError?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.quarantined,
    sequence: refreshed.documentSequence, message: 'The saved document is quarantined. Recovery is required.' });
  entry.pendingAuthoritativeSnapshot = durabilitySnapshot(refreshed) ?? entry.pendingAuthoritativeSnapshot;
  transition(entry, { type: 'provider_status', status: 'connecting', permission: refreshed.permission });
}

function hasFreshLocationSession(entry: RegistryEntry, path: string, session: CollaborationSessionResponse): boolean {
  const workspaceId = entry.key.split('\0')[0];
  if (!session.guestAccess) return hasCurrentOpenedDocumentSessionAuthorization(workspaceId, path, session, entry.authScope);
  const authorization = guestSessionAuthorizations.get(session);
  return Boolean(authorization && authorization.workspaceId === workspaceId && authorization.path === path
    && authorization.invitationId === session.guestAccess.invitationId && session.guestAccess.workspaceId === workspaceId
    && authorization.revision === (guestAuthorizationRevisions.get(guestAuthorizationKey(workspaceId, authorization.invitationId)) ?? 0));
}

function canRejoinEntryAfterAdmission(entry: RegistryEntry): boolean {
  return Boolean(registry.get(entry.key) === entry && !entry.lifecycle.signal.aborted && !entry.requests.signal.aborted
    && entry.refs > 0 && entry.provider && entry.session && !entry.session.guestAccess
    && entry.clientState.admissionBusy && entry.clientState.connection !== 'denied'
    && entry.clientState.durability !== 'degraded' && !entry.clientState.failure
    && isOpenedDocumentAuthCurrent(entry.authScope));
}

/** Each attempt obtains one fresh session. The identity-bound location watcher
 * owns the finite retry window, so normal startup retries must not multiply it. */
function rejoinEntryAfterAdmission(entry: RegistryEntry, scope: AbortController): Promise<void> {
  try { assertRequestActive(entry, scope); } catch (error) { return Promise.reject(error); }
  const existing = entry.admissionRejoinAttempt;
  if (!canRejoinEntryAfterAdmission(entry)) {
    existing?.controller.abort(new Error('Collaboration rejoin is no longer available.'));
    return Promise.resolve();
  }
  const previous = entry.session!, path = entry.path, authScope = entry.authScope;
  if (existing && existing.scope === scope && existing.path === path && existing.authScope === authScope
    && !existing.controller.signal.aborted) return existing.promise;
  existing?.controller.abort(new Error('Collaboration rejoin was superseded by the current location.'));
  const controller = new AbortController();
  const attempt: NonNullable<RegistryEntry['admissionRejoinAttempt']> = {
    scope, path, authScope, controller, promise: Promise.resolve(),
  };
  let rejectCancellation!: (reason: unknown) => void;
  const cancellation = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
  // Retiring before the request microtask runs must not leave an unobserved
  // cancellation rejection. The race below still receives the actual error.
  void cancellation.catch(() => undefined);
  const onAttemptAbort = () => rejectCancellation(controller.signal.reason ?? new Error('Collaboration rejoin was aborted.'));
  const onScopeAbort = () => controller.abort(scope.signal.reason);
  controller.signal.addEventListener('abort', onAttemptAbort, { once: true });
  scope.signal.addEventListener('abort', onScopeAbort, { once: true });
  const timeout = setTimeout(() => controller.abort(new Error('Collaboration rejoin timed out.')), 10_000);
  if (scope.signal.aborted) onScopeAbort();
  const promise = Promise.resolve().then(async () => {
    assertRequestActive(entry, scope);
    controller.signal.throwIfAborted();
    const refreshed = requireTextSession(await Promise.race([
      requestSession(path, 'auto', entry.key.split('\0')[0], controller.signal, undefined, true, 0), cancellation,
    ]),
      previous.representation as TextCollaborationRepresentation);
    controller.signal.throwIfAborted();
    assertRequestActive(entry, scope);
    if (entry.admissionRejoinAttempt !== attempt || !canRejoinEntryAfterAdmission(entry) || entry.path !== path || entry.authScope !== authScope
      || !sameOpenedDocumentSession(entry.session!, previous) || !sameOpenedDocumentSession(refreshed, previous)
      || !hasFreshLocationSession(entry, path, refreshed)
      || !['read', 'write'].includes(refreshed.permission) || typeof refreshed.token !== 'string' || !refreshed.token
      || !Number.isFinite(Date.parse(refreshed.expiresAt)) || Date.parse(refreshed.expiresAt) <= Date.now()) {
      throw new Error('The document or signed-in session changed during collaboration rejoin.');
    }
    if (refreshed.degraded || refreshed.projectionError?.permanent) {
      transition(entry, { type: 'degraded', code: refreshed.projectionError?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.quarantined,
        sequence: refreshed.documentSequence, message: 'The saved document is quarantined. Recovery is required.' });
      throw new Error('The saved document is quarantined. Recovery is required.');
    }
    // Retire every old provider/token/checkpoint callback before the pause can
    // clear. The Y.Doc and its committed IndexedDB lifetime remain unchanged.
    entry.requests.abort();
    entry.requests = new AbortController();
    entry.checkpointPromise = undefined;
    entry.provider?.destroy();
    entry.provider = null;
    entry.session = refreshed;
    entry.requiresFreshSession = false;
    entry.locationAuthorization = { scope: entry.requests, session: refreshed, path, authScope };
    entry.locationRevalidationCandidate = undefined;
    entry.pendingAuthoritativeSnapshot = durabilitySnapshot(refreshed) ?? undefined;
    transition(entry, { type: 'admission_reauthorized', permission: refreshed.permission });
    entry.startProvider?.();
    emit(entry);
  }).catch(error => {
    if (entry.admissionRejoinAttempt === attempt && !controller.signal.aborted
      && scope === entry.requests && !scope.signal.aborted && !entry.lifecycle.signal.aborted) {
      const status = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'status')?.value : undefined;
      if (status === 401 || status === 403) {
        if (entry.session) entry.session = { ...entry.session, permission: 'read' };
        entry.provider?.disconnect();
        transition(entry, { type: 'authentication_failed', message: 'Collaboration access was revoked. Local changes are preserved.' });
      }
    }
    throw error;
  }).finally(() => {
    clearTimeout(timeout);
    scope.signal.removeEventListener('abort', onScopeAbort);
    controller.signal.removeEventListener('abort', onAttemptAbort);
    if (entry.admissionRejoinAttempt === attempt) {
      entry.admissionRejoinAttempt = undefined;
      if (!entry.lifecycle.signal.aborted) emit(entry);
    }
  });
  attempt.promise = promise;
  entry.admissionRejoinAttempt = attempt;
  return promise;
}

function hasHistoricalLocationSession(entry: RegistryEntry, path: string, session: CollaborationSessionResponse): boolean {
  const workspaceId = entry.key.split('\0')[0];
  if (!session.guestAccess) return hasOpenedDocumentLocationSessionReceipt(workspaceId, path, session, entry.authScope);
  const authorization = guestSessionAuthorizations.get(session);
  return Boolean(authorization && authorization.workspaceId === workspaceId && authorization.path === path
    && authorization.invitationId === session.guestAccess.invitationId && session.guestAccess.workspaceId === workspaceId);
}

function hasCurrentLocationAuthorization(entry: RegistryEntry): boolean {
  const authorization = entry.locationAuthorization;
  return Boolean(authorization && authorization.scope === entry.requests && !authorization.scope.signal.aborted
    && authorization.path === entry.path && authorization.authScope === entry.authScope && entry.session
    && sameOpenedDocumentSession(authorization.session, entry.session)
    && hasFreshLocationSession(entry, entry.path, entry.session));
}

/** A validated session may move the open document, never replace its Yjs state. */
function adoptEntryLocation(entry: RegistryEntry, path: string, session: CollaborationSessionResponse, revalidate = false): void {
  const previous = entry.session;
  requireTextSession(session, previous?.representation as TextCollaborationRepresentation | undefined);
  if (!previous || !sameOpenedDocumentSession(session, previous)) throw new Error('Collaboration document identity changed.');
  if (revalidate && (!canRevalidateEntryLocation(entry) || !hasFreshLocationSession(entry, path, session))) {
    throw new Error('The current document location could not be revalidated.');
  }
  if (session.degraded || session.projectionError?.permanent) transition(entry, { type: 'degraded',
    code: session.projectionError?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.quarantined,
    sequence: session.documentSequence, message: 'The saved document is quarantined. Recovery is required.' });
  // Reusing the same open path must still observe a server permission downgrade.
  // An old view snapshot can never restore write access after a denial.
  if (!revalidate && entry.parkedAt === undefined && entry.path === path
    && !(previous.permission === 'write' && session.permission === 'read')) return;
  if (entry.clientState.admissionBusy && entry.parkedAt === undefined) {
    // Location metadata may advance, but cannot restart this exhausted join.
    // Retain the disconnected provider so local update counts keep observing
    // the same Y.Doc; no fresh request/provider lifetime is created here.
    entry.path = path;
    entry.session = previous.permission === 'read' && session.permission === 'write'
      ? { ...session, permission: 'read' } : session;
    emit(entry);
    return;
  }
  const fresh = hasFreshLocationSession(entry, path, session);
  const wasParked = entry.parkedAt !== undefined;
  if (wasParked && !fresh) throw new Error('The parked document requires current authorization.');
  if (wasParked && fresh && entry.clientState.admissionBusy) {
    transition(entry, { type: 'admission_reauthorized', permission: session.permission });
  }
  const parkedStateIsCurrent = wasParked && !session.degraded && !session.projectionError?.permanent
    && isCollaborationStateProof(session.stateProof)
    && session.stateProof === collaborationStateProof(entry.doc, Y);
  entry.parkedAt = undefined;
  const candidate = entry.path !== path && !fresh && hasHistoricalLocationSession(entry, path, session);
  entry.requests.abort();
  entry.requests = new AbortController();
  entry.checkpointPromise = undefined;
  entry.provider?.destroy();
  entry.provider = null;
  entry.path = path;
  entry.session = session;
  entry.locationAuthorization = fresh
    ? { scope: entry.requests, session, path, authScope: entry.authScope } : undefined;
  entry.locationRevalidationCandidate = candidate
    ? { scope: entry.requests, session, path, authScope: entry.authScope } : undefined;
  entry.requiresFreshSession = !fresh;
  entry.pendingAuthoritativeSnapshot = durabilitySnapshot(session) ?? undefined;
  const locationRecovered = entry.clientState.failure?.kind === 'lifecycle';
  entry.clientState = { ...entry.clientState, remoteSynced: false, ready: false,
    locallyUsable: wasParked ? false : entry.clientState.locallyUsable,
    checkpointStateVector: null, checkpointStateProof: null, persistedStateProof: null,
    connection: session.permission === 'read' ? 'read_only' : 'reconnecting',
    error: locationRecovered ? null : entry.clientState.error,
    failure: locationRecovered ? null : entry.clientState.failure,
    durability: entry.clientState.durability === 'degraded' && !locationRecovered ? 'degraded'
      : entry.clientState.unsyncedChanges > 0 ? 'local_pending' : 'server_received' };
  if (parkedStateIsCurrent) transition(entry, { type: 'local_document_restored' });
  entry.startProvider?.();
  emit(entry);
}

function canRevalidateEntryLocation(entry: RegistryEntry): boolean {
  const authorization = entry.locationAuthorization ?? entry.locationRevalidationCandidate;
  return Boolean(!entry.lifecycle.signal.aborted && !entry.clientState.admissionBusy && registry.get(entry.key) === entry && entry.refs > 0
    && entry.clientState.failure?.kind === 'authentication' && entry.clientState.authorizationRecoveryEligible === true
    && authorization && authorization.scope === entry.requests && !authorization.scope.signal.aborted
    && authorization.path === entry.path && authorization.authScope === entry.authScope
    && (entry.session?.guestAccess || isOpenedDocumentAuthCurrent(entry.authScope))
    && entry.session && sameOpenedDocumentSession(authorization.session, entry.session));
}

function hasRevalidatedLocationState(entry: RegistryEntry): boolean {
  return entry.clientState.remoteSynced && hasCurrentLocationAuthorization(entry) && hasCurrentPersistedSnapshot(entry)
    && (entry.clientState.connection === 'live' || entry.clientState.connection === 'read_only');
}

/** Retry the authorized moved location while retaining the document and local history. */
function revalidateEntryLocation(entry: RegistryEntry, scope: AbortController): Promise<void> {
  if (scope !== entry.requests || scope.signal.aborted) return Promise.reject(new Error('Collaboration location changed.'));
  if (entry.locationRevalidationPromise) return entry.locationRevalidationPromise;
  if (!canRevalidateEntryLocation(entry)) {
    return Promise.reject(new Error('This document location cannot be revalidated.'));
  }
  const path = entry.path;
  const previous = entry.session!;
  const authScope = entry.authScope;
  const authorization = entry.locationAuthorization ?? entry.locationRevalidationCandidate;
  const promise = Promise.resolve().then(async () => {
    assertRequestActive(entry, scope);
    const session = requireTextSession(await requestSession(path, 'auto', entry.key.split('\0')[0],
      scope.signal, previous.guestAccess?.invitationId), previous.representation as TextCollaborationRepresentation);
    assertRequestActive(entry, scope);
    if (entry.path !== path || entry.authScope !== authScope || !sameOpenedDocumentSession(session, previous)
      || !hasFreshLocationSession(entry, path, session)) {
      throw new Error('The document changed while its location was being revalidated.');
    }
    if (session.degraded || session.projectionError?.permanent) {
      transition(entry, { type: 'degraded', code: session.projectionError?.code ?? COLLABORATION_CHECKPOINT_ERROR_CODES.quarantined,
        sequence: session.documentSequence, message: 'The saved document is quarantined. Recovery is required.' });
      throw new Error('The saved document is quarantined. Recovery is required.');
    }
    const stillPaused = canRevalidateEntryLocation(entry);
    // Validating a read downgrade retires remembered write receipts. Keep the
    // successful proof observed during this same location lifetime usable for
    // that downgrade; the fresh HTTP receipt itself remains mandatory above.
    const currentAuthorization = entry.locationAuthorization ?? entry.locationRevalidationCandidate;
    const sameLocationLifetime = authorization && currentAuthorization
      && currentAuthorization.scope === authorization.scope && currentAuthorization.path === authorization.path
      && currentAuthorization.authScope === authorization.authScope
      && sameOpenedDocumentSession(currentAuthorization.session, authorization.session);
    const completedWhilePending = sameLocationLifetime && entry.clientState.remoteSynced
      && entry.clientState.failure === null && hasCurrentPersistedSnapshot(entry)
      && (entry.clientState.connection === 'live' || entry.clientState.connection === 'read_only');
    if (!stillPaused && !completedWhilePending) {
      throw new Error('The current document could not be revalidated.');
    }
    // Automatic proof confirmation may finish while HTTP is pending. Its
    // success is current, but a fresh permission downgrade must still apply.
    if (!stillPaused && !(entry.session?.permission === 'write' && session.permission === 'read')) return;
    adoptEntryLocation(entry, path, session, stillPaused);
    const adoptedScope = entry.requests;
    await waitForEntryState(entry, () => hasRevalidatedLocationState(entry),
      10_000, adoptedScope.signal);
    assertRequestActive(entry, adoptedScope);
  }).finally(() => {
    if (entry.locationRevalidationPromise === promise) {
      entry.locationRevalidationPromise = undefined;
      if (!entry.lifecycle.signal.aborted) emit(entry);
    }
  });
  entry.locationRevalidationPromise = promise;
  emit(entry);
  return promise;
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
    authScope: guestInvitationId ? null : openedDocumentAuthScope(),
    requiresFreshSession: Boolean(initialSession && isLocalOpenedDocumentSession(initialSession)),
    clientState: createInitialTextCollaborationClientState({
      permission: initialSession?.permission,
      documentSequence: initialSession?.documentSequence,
      checkpointSequence: initialSession?.checkpointSequence,
      stateVector: initialSession?.stateVector,
      degraded: initialSession?.degraded,
      projectionError: initialSession?.projectionError,
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
      const localReceipt = isLocalOpenedDocumentSession(session) ? localOpenedDocumentReceipt(session) : null;
      if (isLocalOpenedDocumentSession(session) && !localReceipt) throw new Error('The local document identity changed.');
      const knownReceipt = localReceipt ?? findOpenedLiveDocument(workspaceId, entry.path, session.documentId, entry.authScope);
      const minimumSnapshot = knownReceipt && sameOpenedDocumentSession(knownReceipt.session, session) ? knownReceipt.snapshot : null;
      assertEntryActive(entry);
      entry.session = session;
      entry.tabOwned = currentTabOwnsEntry(entry);
      entry.clientState = createInitialTextCollaborationClientState({
        permission: session.permission,
        documentSequence: session.documentSequence,
        checkpointSequence: session.checkpointSequence,
        stateVector: session.stateVector,
        degraded: session.degraded,
        projectionError: session.projectionError,
      });
      entry.pendingAuthoritativeSnapshot = durabilitySnapshot({
        documentId: session.documentId,
        lifecycleGeneration: session.lifecycleGeneration,
        documentSequence: session.documentSequence,
        checkpointSequence: session.checkpointSequence,
        stateVector: session.stateVector,
        stateProof: session.stateProof,
        degraded: session.degraded,
        projectionError: session.projectionError,
        projectionFinalized: session.projectionFinalized,
      }) ?? undefined;
      const persistence = new IndexeddbPersistence(
        `canvas:${guestInvitationId ? `guest:${guestInvitationId}:` : ''}${session.documentId}:${session.lifecycleGeneration}:${representation}`,
        entry.doc,
      );
      entry.persistence = persistence;
      await persistence.whenSynced;
      const markPolicy = isRichTextCollaborationRepresentation(session.representation)
        ? installCodeMarkConflictPolicy(entry.doc, { signal: entry.lifecycle.signal,
          canNormalize: () => entry.clientState.remoteSynced && entry.clientState.durability !== 'degraded'
            && entry.session?.permission === 'write' }) : null;
      assertEntryActive(entry);
      if (entry.authScope && !isOpenedDocumentAuthCurrent(entry.authScope)) throw new Error('The signed-in session changed.');
      transition(entry, { type: 'indexeddb_hydrated' });
      const locallyUsable = hasStoredLocalDocument(entry.doc, session);
      const includesKnownChanges = !minimumSnapshot || persistedUpdateIncludesAgentSnapshot(
        Y.encodeStateAsUpdate(entry.doc), minimumSnapshot, Y);
      if (localReceipt && (!locallyUsable || !includesKnownChanges)) {
        throw new Error('The complete local document is unavailable. Reconnect to reopen it.');
      }
      // Fresh HTTP authorization cannot prove local bytes include a known deletion.
      // Keep the provider available to fill that gap before exposing the editor.
      if (locallyUsable && includesKnownChanges) transition(entry, { type: 'local_document_restored' });
      const reconcileAuthoritativeSnapshot = (snapshot: CollaborationDurabilitySnapshot) => {
        if (
          entry.lifecycle.signal.aborted
          || entry.clientState.admissionBusy
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
          degraded: snapshot.degraded,
          projectionError: snapshot.projectionError,
          projectionFinalized: snapshot.projectionFinalized,
          schemaValidated: snapshot.schemaValidated,
          authorizationRevalidated: hasCurrentLocationAuthorization(entry),
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
        entry.retentionEncodedBytes = undefined;
        // Invalidate immediately, before the provider batches/sends the change.
        transition(entry, { type: 'document_changed' });
        if (entry.pendingAuthoritativeSnapshot) reconcileAuthoritativeSnapshot(entry.pendingAuthoritativeSnapshot);
      });
      const denyAccess = (message: string) => {
        if (!guestInvitationId) invalidateOpenedLiveDocument(workspaceId,
          { path: entry.path, documentId: entry.session?.documentId }, entry.authScope);
        else {
          const key = guestAuthorizationKey(workspaceId, guestInvitationId);
          guestAuthorizationRevisions.set(key, (guestAuthorizationRevisions.get(key) ?? 0) + 1);
        }
        if (entry.session) entry.session = { ...entry.session, permission: 'read' };
        entry.provider?.disconnect();
        transition(entry, { type: 'authentication_failed', message });
      };
      if (entry.authScope) entry.removeAuthListener = subscribeOpenedDocumentAuthInvalidation(() => {
        const current = openedDocumentAuthScope();
        entry.requiresFreshSession = true;
        if (!current || current.userId !== entry.authScope?.userId || current.sessionId !== entry.authScope?.sessionId) {
          denyAccess('The signed-in session changed. Local changes are preserved.');
        }
      });
      entry.startProvider = () => {
        if (entry.tokenRetryTimer) clearTimeout(entry.tokenRetryTimer);
        entry.tokenRetryTimer = undefined;
        if (entry.clientState.admissionBusy || entry.requests.signal.aborted) return;
        if (tabRetentionObserved && tabRetentionEnabled && (entry.refs > 0 || currentTabActivatesEntry(entry))) reconcileDocumentRetention();
        const scope = entry.requests;
        const active = () => !entry.lifecycle.signal.aborted && scope === entry.requests && !scope.signal.aborted;
        const session = entry.session!;
        let tokenNetworkFailure = false;
        let tokenAdmissionFailureReason: string | null = null;
        let tokenRetryDelay = 1000;
        const provider = new HocuspocusProvider({
          url: websocketUrl(session.websocketUrl),
          preserveTrailingSlash: true,
          name: session.documentName,
          document: entry.doc!,
          awareness: createDocumentAwarenessLease(entry.doc!),
          token: async () => {
            assertRequestActive(entry, scope);
            tokenNetworkFailure = false;
            tokenAdmissionFailureReason = null;
            if (entry.clientState.connection === 'denied') throw new Error('Collaboration access was revoked.');
            try {
              if (entry.clientState.admissionBusy) throw new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
                entry.clientState.error || 'Collaboration is busy. Local changes are preserved.');
              if (entry.requiresFreshSession || Date.parse(entry.session!.expiresAt) - Date.now() < 30_000) {
                await refreshEntrySession(entry, scope);
              }
              if (entry.clientState.admissionBusy) throw new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
                entry.clientState.error || 'Collaboration is busy. Local changes are preserved.');
            } catch (error) {
              tokenNetworkFailure = error instanceof LiveDocumentNetworkError;
              if (entry.clientState.admissionBusy && error instanceof CollaborationCheckpointRequestError
                && error.code === NATIVE_PEER_ADMISSION_BUSY_REASON) {
                // The provider wraps its own token-callback rejection. This is
                // not another server AuthDenied and cannot turn busy into revoke.
                tokenAdmissionFailureReason = `Failed to get token during sendToken(): ${error}`;
              }
              throw error;
            }
            assertRequestActive(entry, scope);
            tokenRetryDelay = 1000;
            return entry.session!.token;
          },
          flushDelay: 75,
          onStatus: ({ status }) => {
            if (!active()) return;
            if (status !== 'connected') entry.retentionConnectionReady = false;
            if (entry.visibilityPaused && status === 'connected') return;
            transition(entry, {
              type: 'provider_status',
              status: status === 'connected' ? 'connected' : status === 'connecting' ? 'connecting' : 'disconnected',
              permission: entry.session!.permission,
            });
          },
          onClose: ({ event }) => {
            if (active()) { entry.retentionConnectionReady = false; entry.requiresFreshSession = true; }
            // Hocuspocus's document CLOSE frame retains this exact reason but
            // reconstructs code 1000; a whole-socket close can retain 1013.
            if (!active() || event.reason !== 'Collaboration document transition' || ![1000, 1013].includes(event.code)) return;
            if (entry.tokenRetryTimer) clearTimeout(entry.tokenRetryTimer);
            entry.tokenRetryTimer = undefined;
            entry.requiresFreshSession = true;
            transition(entry, { type: 'admission_busy', message: 'Collaboration is busy. Local changes are preserved.' });
            provider.configuration?.websocketProvider.cancelWebsocketRetry?.();
            provider.disconnect();
          },
          onSynced: ({ state } = { state: true }) => {
            if (!active() || entry.clientState.admissionBusy || entry.visibilityPaused) return;
            entry.retentionConnectionReady = state;
            if (state) entry.retentionReauthenticating = false;
            if (!state) { scheduleDocumentRetention(); return; }
            transition(entry, { type: 'remote_synced', permission: entry.session!.permission });
            if (entry.refs) restoreEntryPresence(entry);
            markPolicy?.activate();
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
            entry.retentionConnectionReady = false;
            if (reason === NATIVE_PEER_ADMISSION_BUSY_REASON) {
              tokenNetworkFailure = false;
              tokenAdmissionFailureReason = null;
              if (entry.tokenRetryTimer) clearTimeout(entry.tokenRetryTimer);
              entry.tokenRetryTimer = undefined;
              transition(entry, { type: 'admission_busy', message: 'Collaboration is busy. Local changes are preserved.' });
              provider.configuration?.websocketProvider.cancelWebsocketRetry?.();
              provider.disconnect();
              return;
            }
            if (entry.clientState.admissionBusy && reason === tokenAdmissionFailureReason) {
              tokenAdmissionFailureReason = null;
              provider.disconnect();
              return;
            }
            // Hocuspocus emits authenticationFailed even when its token callback
            // only failed to reach HTTP. Never send an old token or turn that
            // network failure into a permanent access denial.
            if (tokenNetworkFailure) {
              tokenNetworkFailure = false;
              provider.disconnect();
              if (entry.clientState.admissionBusy || entry.visibilityPaused) return;
              transition(entry, { type: 'provider_status', status: 'disconnected', permission: entry.session!.permission });
              entry.tokenRetryTimer = setTimeout(() => {
                if (active() && !entry.visibilityPaused && !entry.clientState.admissionBusy && entry.clientState.connection !== 'denied') void provider.connect();
              }, tokenRetryDelay);
              tokenRetryDelay = Math.min(tokenRetryDelay * 2, 15_000);
              return;
            }
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
                degraded?: boolean;
                projectionError?: CollaborationDurabilitySnapshot['projectionError'];
                projectionFinalized?: boolean;
                schemaValidated?: boolean;
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
                transition(entry, { type: 'degraded', message: message.message || 'Checkpoint failed.', code: message.code,
                  sequence: message.documentSequence });
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
                  degraded: message.degraded,
                  projectionError: message.projectionError,
                  projectionFinalized: message.projectionFinalized ?? true,
                  schemaValidated: message.schemaValidated,
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
        const websocketProvider = provider.configuration?.websocketProvider;
        if (websocketProvider) {
          const connect = websocketProvider.connect.bind(websocketProvider);
          // Hocuspocus's already queued onClose retry calls this owned method
          // without checking shouldConnect again. Do not create another origin.
          websocketProvider.connect = () => active() && !entry.visibilityPaused && !entry.clientState.admissionBusy ? connect() : Promise.resolve();
        }
        entry.provider = provider;
        restoreEntryPresence(entry);
      };
      entry.requestCheckpoint = () => {
        if (entry.lifecycle.signal.aborted) return Promise.reject(new Error('Collaboration document was closed.'));
        if (entry.clientState.admissionBusy) return Promise.reject(new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
          entry.clientState.error || 'Collaboration is busy. Local changes are preserved.'));
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
          if (entry.clientState.admissionBusy) throw new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
            entry.clientState.error || 'Collaboration is busy. Local changes are preserved.');
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
            if (entry.clientState.admissionBusy) throw new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
              entry.clientState.error || 'Collaboration is busy. Local changes are preserved.');
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
            if (entry.clientState.admissionBusy) throw new CollaborationCheckpointRequestError(NATIVE_PEER_ADMISSION_BUSY_REASON,
              entry.clientState.error || 'Collaboration is busy. Local changes are preserved.');
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
  const requestScope = entry.requests;
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
    getMigrationCheckpoint: () => {
      assertRequestActive(entry, requestScope);
      const proof = collaborationStateProof(entry.doc, Y);
      const state = entry.clientState;
      if (!entry.session || !state.ready || state.unsyncedChanges !== 0 || state.durability !== 'checkpointed_file'
        || state.documentSequence === null || state.documentSequence !== state.checkpointSequence
        || !proof || proof !== state.checkpointStateProof) throw new Error('The exact document checkpoint is not finalized.');
      return { expectedDocumentId: entry.session.documentId, expectedLifecycleGeneration: entry.session.lifecycleGeneration,
        documentSequence: state.documentSequence, stateProof: proof };
    },
    requestLocationRevalidation: () => revalidateEntryLocation(entry, requestScope),
    canRevalidateLocation: canRevalidateEntryLocation(entry),
    revalidatingLocation: Boolean(entry.locationRevalidationPromise),
    requestAdmissionRejoin: () => rejoinEntryAfterAdmission(entry, requestScope),
  };
}

function takeRetainedEntry(key: string, workspaceId: string, path: string, session: CollaborationSessionResponse): RegistryEntry | undefined {
  const entry = [...registry.values()].find((candidate) => {
    const previous = candidate.session;
    return candidate.refs === 0 && !candidate.lifecycle.signal.aborted && !candidate.doc.isDestroyed
      && (previous?.guestAccess || candidate.authScope?.userId === openedDocumentAuthScope()?.userId
        && candidate.authScope?.sessionId === openedDocumentAuthScope()?.sessionId)
      && candidate.key.split('\0')[0] === workspaceId && previous
      && (candidate.parkedAt === undefined || hasFreshLocationSession(candidate, path, session))
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
  emitReviewReadiness();
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
    owner: string | null; key: string; path: string; document: CollaborationDocument | null; authPartition: string;
  } | null>(null);
  const sessionScope = input.session ? openedDocumentSessionScope(input.session) : null;
  const authPartition = input.session?.guestAccess ? 'guest' : sessionScope?.sessionId
    ?? (state?.owner === owner ? state.authPartition : 'unverified');
  const key = input.enabled && input.workspaceId && input.path
    ? input.session
      ? `${input.workspaceId}\0${input.session.guestAccess?.invitationId || ''}\0${input.session.user.id}\0${input.documentKey ?? input.path}\0${input.session.documentId}\0${input.session.lifecycleGeneration}\0${input.representation}\0${authPartition}`
      : input.waitForSession ? state?.owner === owner ? state.key : null
        : `${input.workspaceId}\0${input.path}\0${input.representation}\0${authPartition}`
    : null;
  useEffect(() => {
    if (!key || !input.path || !input.workspaceId) {
      return;
    }
    let entry = registry.get(key);
    if (entry?.parkedAt !== undefined && (!input.session || !hasFreshLocationSession(entry, input.path, input.session))) {
      disposeEntry(entry);
      entry = undefined;
    }
    entry ??= input.session ? takeRetainedEntry(key, input.workspaceId, input.path, input.session) : undefined;
    if (!entry) {
      entry = createEntry(key, input.path, input.representation, input.workspaceId, input.session);
      registry.set(key, entry);
      emitReviewReadiness();
    } else if (input.session) {
      try { adoptEntryLocation(entry, input.path, input.session); }
      catch (error) { transition(entry, { type: 'degraded', code: COLLABORATION_FAILURE_CODES.generationChanged,
        message: error instanceof Error ? error.message : 'Collaboration location changed.' }); }
    }
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.cleanupTimer = undefined;
    const wasInactive = entry.refs === 0;
    entry.refs += 1;
    entry.lastActivatedAt = retentionNow(); entry.backgroundSince = undefined; entry.retentionTier = 'active';
    entry.tabOwned = currentTabOwnsEntry(entry);
    if (wasInactive) restoreEntryPresence(entry);
    scheduleDocumentRetention();
    const update = () => setState({ owner, key, path: entry.path, document: entry.doc ? snapshot(entry) : null, authPartition });
    entry.listeners.add(update);
    update();
    return () => {
      entry.listeners.delete(update);
      entry.refs -= 1;
      if (entry.refs === 0) {
        // A React effect refresh can release and immediately reacquire the
        // same entry. Wait until its replacement has had a chance to attach.
        queueMicrotask(() => {
          if (entry.refs !== 0 || entry.lifecycle.signal.aborted || entry.cleanupTimer) return;
          entry.backgroundSince = retentionNow();
          if (tabRetentionObserved) { scheduleDocumentRetention(); return; }
          const delay = parkTextEntry(entry) ? PARKED_TEXT_MS : 1_000;
          entry.cleanupTimer = setTimeout(() => {
            entry.cleanupTimer = undefined;
            if (entry.refs === 0) disposeEntry(entry);
          }, delay);
        });
      }
    };
  }, [authPartition, input.path, input.representation, input.session, input.waitForSession, input.workspaceId, key, owner]);
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
  const forceFreshKey = useRef<string | null>(null);
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
    const authScope = openedDocumentAuthScope();
    const connected = forceFreshKey.current === key ? null
      : findConnectedOpenedDocument(input.workspaceId, input.path, input.expectedDocumentId, authScope);
    forceFreshKey.current = null;
    void (connected ? Promise.resolve(connected.session) : requestSession(input.path, 'auto', input.workspaceId, controller.signal))
      .then((session) => requireTextSession(session))
      .then((session) => {
        if (input.expectedDocumentId && session.documentId !== input.expectedDocumentId) {
          throw new Error('This file path now belongs to another document. Waiting for the original document location.');
        }
        if (!cancelled) setState({ key, attempt, session, error: null });
      })
      .catch((error) => {
        if (!cancelled) {
          const local = error instanceof LiveDocumentNetworkError && !controller.signal.aborted
            ? findOpenedLiveDocument(input.workspaceId!, input.path!, input.expectedDocumentId, authScope) : null;
          if (local) {
            setState({ key, attempt, session: localOpenedDocumentSession(local), error: null });
            return;
          }
          if (!(error instanceof LiveDocumentNetworkError) && !controller.signal.aborted) {
            invalidateOpenedLiveDocument(input.workspaceId!, { path: input.path!, documentId: input.expectedDocumentId ?? undefined }, authScope);
          }
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
    retry: () => { forceFreshKey.current = key; setAttempt((currentAttempt) => currentAttempt + 1); },
  };
}
