'use client';

import { useEffect, useState } from 'react';

import type { AppState, BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';
import type { OrderedExcalidrawElement } from '@excalidraw/excalidraw/element/types';

import { workspaceHeaders } from '@/app/lib/files/client';
import type { CollaborationConnectionStatus, CollaborationSessionResponse } from '@/app/lib/collaboration/types';
import {
  EXCALIDRAW_FULL_SYNC_INTERVAL_MS,
  EXCALIDRAW_PATCH_COALESCE_MS,
  EXCALIDRAW_PRESENCE_THROTTLE_MS,
  type ExcalidrawAssetMetadata,
  type ExcalidrawClientEnvelope,
  type ExcalidrawElementRecord,
  type ExcalidrawPresencePayload,
  type ExcalidrawServerMessage,
  type ExcalidrawSharedAppState,
} from './protocol';

type RemoteCollaborator = {
  connectionId: string;
  user: { id: string; name: string; color: string; colorLight: string };
  payload: ExcalidrawPresencePayload;
};

type RemoteSceneUpdate = {
  revision: number;
  kind: 'init' | 'patch';
  elements: ExcalidrawElementRecord[];
  appState: ExcalidrawSharedAppState;
  assets: ExcalidrawAssetMetadata[];
  sceneSequence: number;
};

type Entry = {
  key: string;
  path: string;
  refs: number;
  listeners: Set<() => void>;
  socket: WebSocket | null;
  session: CollaborationSessionResponse | null;
  status: CollaborationConnectionStatus;
  error: string | null;
  sceneSequence: number;
  lifecycleGeneration: number;
  initialized: boolean;
  initialSnapshot: RemoteSceneUpdate | null;
  remoteUpdate: RemoteSceneUpdate | null;
  remoteRevision: number;
  collaborators: Map<string, RemoteCollaborator>;
  acknowledgedElements: Map<string, string>;
  sentElements: Map<string, string>;
  acknowledgedAppState: string;
  sentAppState: string;
  latestElements: readonly OrderedExcalidrawElement[];
  latestAppState: AppState | null;
  latestFiles: BinaryFiles;
  assets: Map<string, ExcalidrawAssetMetadata>;
  pending: Map<string, string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
  pointerTimer: ReturnType<typeof setTimeout> | null;
  latestPointer: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' }; button: 'up' | 'down' } | null;
  selectionTimer: ReturnType<typeof setTimeout> | null;
  latestSelection: Record<string, true>;
  sentSelection: string;
  fullSyncTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
  cleanupTimer: ReturnType<typeof setTimeout> | null;
  connecting: Promise<void> | null;
  generation: number;
  stopped: boolean;
  assetSync: Promise<void>;
};

export type ExcalidrawCollaborationDocument = {
  prepareToLeave: () => Promise<void>;
  hasPendingChanges: () => boolean;
  registryKey: string;
  session: CollaborationSessionResponse | null;
  status: CollaborationConnectionStatus;
  error: string | null;
  sceneSequence: number;
  initialSnapshot: RemoteSceneUpdate | null;
  remoteUpdate: RemoteSceneUpdate | null;
  collaborators: RemoteCollaborator[];
  submitLocalScene: (
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => void;
  sendPointer: (payload: { pointer: { x: number; y: number; tool: 'pointer' | 'laser' }; button: 'up' | 'down' }) => void;
  sendSelection: (selectedElementIds: Record<string, true>) => void;
  loadAsset: (metadata: ExcalidrawAssetMetadata) => Promise<BinaryFileData>;
};

const registry = new Map<string, Entry>();

function emit(entry: Entry): void {
  for (const listener of entry.listeners) listener();
}

function websocketUrl(relative: string): string {
  const url = new URL(relative, window.location.href);
  url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function elementFingerprint(element: Pick<ExcalidrawElementRecord, 'version' | 'versionNonce' | 'isDeleted' | 'index'>): string {
  return `${element.version}:${element.versionNonce}:${element.isDeleted ? 1 : 0}:${element.index ?? ''}`;
}

function sharedAppState(appState: AppState | null): ExcalidrawSharedAppState {
  if (!appState) return {};
  return {
    viewBackgroundColor: appState.viewBackgroundColor,
    gridSize: appState.gridSize,
    gridStep: appState.gridStep,
    gridModeEnabled: appState.gridModeEnabled,
  };
}

function envelope(entry: Entry, type: ExcalidrawClientEnvelope['type'], payload: unknown): ExcalidrawClientEnvelope {
  return {
    schemaVersion: 1,
    type,
    messageId: crypto.randomUUID(),
    lifecycleGeneration: entry.lifecycleGeneration,
    baseSequence: entry.sceneSequence,
    payload,
  };
}

function sendEnvelope(entry: Entry, message: ExcalidrawClientEnvelope, durable = false): void {
  const serialized = JSON.stringify(message);
  if (durable) entry.pending.set(message.messageId, serialized);
  if (entry.socket?.readyState === WebSocket.OPEN && entry.initialized) entry.socket.send(serialized);
}

async function requestSession(path: string): Promise<CollaborationSessionResponse> {
  const response = await fetch('/api/files/collaboration/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...workspaceHeaders() },
    body: JSON.stringify({ path, provider: 'excalidraw', representation: 'excalidraw_scene' }),
  });
  const payload = await response.json().catch(() => ({})) as Partial<CollaborationSessionResponse> & { error?: string };
  if (!response.ok || payload.success !== true || payload.provider !== 'excalidraw') {
    throw new Error(payload.error || 'Excalidraw collaboration could not be started.');
  }
  return payload as CollaborationSessionResponse;
}

function dataUrlToBytes(dataUrl: string): { mimeType: string; data: Uint8Array } {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(dataUrl);
  if (!match) throw new Error('Excalidraw asset is not a base64 data URL.');
  const binary = window.atob(match[2]);
  const data = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) data[index] = binary.charCodeAt(index);
  return { mimeType: match[1], data };
}

async function uploadAsset(entry: Entry, file: BinaryFileData): Promise<void> {
  const current = entry.assets.get(file.id);
  if (current && current.version >= (file.version ?? 1)) return;
  const decoded = dataUrlToBytes(file.dataURL);
  const uploadBytes = new Uint8Array(decoded.data.byteLength);
  uploadBytes.set(decoded.data);
  const response = await fetch('/api/files/excalidraw-assets', {
    method: 'POST',
    headers: {
      ...workspaceHeaders(),
      'Content-Type': file.mimeType || decoded.mimeType,
      'X-Excalidraw-File-Id': file.id,
    },
    body: uploadBytes.buffer,
  });
  const payload = await response.json().catch(() => ({})) as { success?: boolean; asset?: ExcalidrawAssetMetadata; error?: string };
  if (!response.ok || !payload.success || !payload.asset) throw new Error(payload.error || `Could not upload Excalidraw asset ${file.id}.`);
  entry.assets.set(payload.asset.fileId, payload.asset);
}

function synchronizeAssets(entry: Entry, files: BinaryFiles): void {
  const next = async () => {
    for (const file of Object.values(files)) await uploadAsset(entry, file);
  };
  entry.assetSync = entry.assetSync.then(next, next).catch((error) => {
    entry.status = 'degraded';
    entry.error = error instanceof Error ? error.message : 'Excalidraw asset upload failed.';
    emit(entry);
  });
}

function scheduleFlush(entry: Entry): void {
  if (entry.flushTimer) clearTimeout(entry.flushTimer);
  entry.flushTimer = setTimeout(() => {
    entry.flushTimer = null;
    void flushLocalScene(entry);
  }, EXCALIDRAW_PATCH_COALESCE_MS);
}

async function flushLocalScene(entry: Entry): Promise<void> {
  await entry.assetSync;
  if (!entry.initialized || entry.session?.permission !== 'write' || !entry.latestAppState) return;
  const changed = entry.latestElements.filter((element) => {
    const fingerprint = elementFingerprint(element as ExcalidrawElementRecord);
    return entry.sentElements.get(element.id) !== fingerprint;
  });
  const appState = sharedAppState(entry.latestAppState);
  const appStateFingerprint = JSON.stringify(appState);
  if (changed.length === 0 && appStateFingerprint === entry.sentAppState) return;
  for (const element of changed) entry.sentElements.set(element.id, elementFingerprint(element as ExcalidrawElementRecord));
  entry.sentAppState = appStateFingerprint;
  const message = envelope(entry, 'scene:patch', {
    elements: changed,
    appState,
    assets: [...entry.assets.values()],
  });
  entry.status = 'persisting';
  entry.error = null;
  emit(entry);
  sendEnvelope(entry, message, true);
}

function updateRemote(entry: Entry, input: Omit<RemoteSceneUpdate, 'revision'>): void {
  entry.remoteRevision += 1;
  entry.remoteUpdate = { ...input, revision: entry.remoteRevision };
}

function scheduleFullSync(entry: Entry): void {
  if (entry.fullSyncTimer) clearTimeout(entry.fullSyncTimer);
  entry.fullSyncTimer = setTimeout(() => {
    entry.fullSyncTimer = null;
    if (!entry.initialized || entry.stopped || entry.refs === 0) return;
    sendEnvelope(entry, envelope(entry, 'scene:resync_request', { reason: 'periodic-consistency-check' }));
    scheduleFullSync(entry);
  }, EXCALIDRAW_FULL_SYNC_INTERVAL_MS);
}

function parseServerMessage(raw: string): ExcalidrawServerMessage {
  const parsed = JSON.parse(raw) as ExcalidrawServerMessage;
  if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== 1 || typeof parsed.type !== 'string') {
    throw new Error('Invalid Excalidraw collaboration server message.');
  }
  return parsed;
}

function handleServerMessage(entry: Entry, message: ExcalidrawServerMessage): void {
  if (message.type === 'scene:init') {
    entry.initialized = true;
    entry.sceneSequence = message.snapshot.sceneSequence;
    entry.lifecycleGeneration = message.snapshot.lifecycleGeneration;
    entry.acknowledgedElements = new Map(message.snapshot.elements.map((element) => [element.id, elementFingerprint(element)]));
    entry.sentElements = new Map(entry.acknowledgedElements);
    entry.acknowledgedAppState = JSON.stringify(message.snapshot.appState);
    entry.sentAppState = entry.acknowledgedAppState;
    entry.assets = new Map(message.snapshot.assets.map((asset) => [asset.fileId, asset]));
    updateRemote(entry, {
      kind: 'init',
      elements: message.snapshot.elements,
      appState: message.snapshot.appState,
      assets: message.snapshot.assets,
      sceneSequence: message.snapshot.sceneSequence,
    });
    entry.initialSnapshot = entry.remoteUpdate;
    entry.status = message.permission === 'write' ? 'live' : 'read_only';
    entry.error = null;
    entry.reconnectAttempt = 0;
    for (const pending of entry.pending.values()) entry.socket?.send(pending);
    scheduleFlush(entry);
    scheduleFullSync(entry);
    emit(entry);
    return;
  }
  if (message.type === 'scene:applied') {
    entry.pending.delete(message.replyTo);
    entry.sceneSequence = Math.max(entry.sceneSequence, message.sceneSequence);
    for (const element of message.elements) {
      const fingerprint = elementFingerprint(element);
      entry.acknowledgedElements.set(element.id, fingerprint);
      entry.sentElements.set(element.id, fingerprint);
    }
    entry.acknowledgedAppState = JSON.stringify({
      ...JSON.parse(entry.acknowledgedAppState || '{}') as ExcalidrawSharedAppState,
      ...message.appState,
    });
    entry.sentAppState = entry.acknowledgedAppState;
    entry.assets = new Map(message.assets.map((asset) => [asset.fileId, asset]));
    updateRemote(entry, {
      kind: 'patch',
      elements: message.elements,
      appState: message.appState,
      assets: message.assets,
      sceneSequence: message.sceneSequence,
    });
    entry.status = message.checkpointed ? 'saved' : 'live';
    sendEnvelope(entry, envelope(entry, 'scene:ack', { sceneSequence: message.sceneSequence }));
    scheduleFlush(entry);
    emit(entry);
    return;
  }
  if (message.type === 'scene:resync_required') {
    entry.sceneSequence = message.sceneSequence;
    sendEnvelope(entry, envelope(entry, 'scene:resync_request', { reason: message.reason }));
    return;
  }
  if (message.type === 'scene:status') {
    entry.status = message.status === 'persisting' ? 'persisting' : message.status === 'saved' ? 'saved' : 'degraded';
    entry.error = message.status === 'degraded' ? message.message || 'Excalidraw persistence failed.' : null;
    emit(entry);
    return;
  }
  if (message.type === 'presence:update') {
    entry.collaborators.set(message.connectionId, {
      connectionId: message.connectionId,
      user: message.user,
      payload: message.payload || {},
    });
    emit(entry);
    return;
  }
  if (message.type === 'presence:leave') {
    entry.collaborators.delete(message.connectionId);
    emit(entry);
    return;
  }
  if (message.type === 'asset:available') {
    entry.assets.set(message.asset.fileId, message.asset);
    emit(entry);
    return;
  }
  if (message.type === 'error') {
    entry.status = 'degraded';
    entry.error = message.message;
    if (message.replyTo) entry.pending.delete(message.replyTo);
    emit(entry);
  }
}

function scheduleReconnect(entry: Entry): void {
  if (entry.stopped || entry.refs === 0 || entry.reconnectTimer) return;
  entry.reconnectAttempt += 1;
  const delay = Math.min(10_000, 300 * (2 ** Math.min(entry.reconnectAttempt, 5))) + Math.floor(Math.random() * 200);
  entry.reconnectTimer = setTimeout(() => {
    entry.reconnectTimer = null;
    void connect(entry);
  }, delay);
}

async function connect(entry: Entry): Promise<void> {
  if (entry.connecting || entry.stopped || entry.refs === 0) return entry.connecting ?? undefined;
  entry.connecting = (async () => {
    const generation = ++entry.generation;
    entry.status = entry.session ? 'reconnecting' : 'connecting';
    entry.initialized = false;
    emit(entry);
    try {
      const session = await requestSession(entry.path);
      if (entry.stopped || generation !== entry.generation) return;
      entry.session = session;
      entry.lifecycleGeneration = session.lifecycleGeneration;
      const socket = new WebSocket(websocketUrl(session.websocketUrl));
      entry.socket = socket;
      socket.addEventListener('open', () => {
        if (generation !== entry.generation) return socket.close();
        socket.send(JSON.stringify({ type: 'authenticate', token: session.token }));
      });
      socket.addEventListener('message', (event) => {
        if (generation !== entry.generation || typeof event.data !== 'string') return;
        try { handleServerMessage(entry, parseServerMessage(event.data)); }
        catch (error) {
          entry.status = 'degraded';
          entry.error = error instanceof Error ? error.message : 'Invalid Excalidraw collaboration response.';
          emit(entry);
        }
      });
      socket.addEventListener('close', () => {
        if (generation !== entry.generation || entry.stopped) return;
        entry.socket = null;
        entry.initialized = false;
        if (entry.fullSyncTimer) clearTimeout(entry.fullSyncTimer);
        entry.fullSyncTimer = null;
        entry.status = 'reconnecting';
        emit(entry);
        scheduleReconnect(entry);
      });
      socket.addEventListener('error', () => {
        if (generation !== entry.generation) return;
        entry.status = 'offline';
        emit(entry);
      });
    } catch (error) {
      entry.status = 'degraded';
      entry.error = error instanceof Error ? error.message : 'Excalidraw collaboration could not be started.';
      emit(entry);
      scheduleReconnect(entry);
    }
  })().finally(() => { entry.connecting = null; });
  return entry.connecting;
}

function createEntry(key: string, path: string): Entry {
  return {
    key,
    path,
    refs: 0,
    listeners: new Set(),
    socket: null,
    session: null,
    status: 'connecting',
    error: null,
    sceneSequence: 0,
    lifecycleGeneration: 1,
    initialized: false,
    initialSnapshot: null,
    remoteUpdate: null,
    remoteRevision: 0,
    collaborators: new Map(),
    acknowledgedElements: new Map(),
    sentElements: new Map(),
    acknowledgedAppState: '{}',
    sentAppState: '{}',
    latestElements: [],
    latestAppState: null,
    latestFiles: {},
    assets: new Map(),
    pending: new Map(),
    flushTimer: null,
    pointerTimer: null,
    latestPointer: null,
    selectionTimer: null,
    latestSelection: {},
    sentSelection: '{}',
    fullSyncTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
    cleanupTimer: null,
    connecting: null,
    generation: 0,
    stopped: false,
    assetSync: Promise.resolve(),
  };
}

function hasPendingSceneChanges(entry: Entry): boolean {
  return entry.pending.size > 0 || Boolean(entry.latestAppState && (
    JSON.stringify(sharedAppState(entry.latestAppState)) !== entry.sentAppState
    || entry.latestElements.some((element) => (
      entry.sentElements.get(element.id) !== elementFingerprint(element as ExcalidrawElementRecord)
    ))
  ));
}

async function prepareSceneToLeave(entry: Entry): Promise<void> {
  const assertConnected = () => {
    if (!entry.initialized || entry.status === 'offline' || entry.status === 'connecting'
      || entry.status === 'degraded' || entry.stopped) {
      throw new Error(entry.error || 'The drawing is not saved. Reconnect before leaving.');
    }
  };
  assertConnected();
  let uploadTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
    (async () => {
      await flushLocalScene(entry);
      assertConnected();
      if (!hasPendingSceneChanges(entry)) return;
      await new Promise<void>((resolve, reject) => {
        const check = () => {
          try {
            assertConnected();
            if (hasPendingSceneChanges(entry)) return;
            cleanup();
            resolve();
          } catch (error) { cleanup(); reject(error); }
        };
        const timeout = setTimeout(() => {
          cleanup();
          reject(new Error('The drawing is still saving. Please retry.'));
        }, 10_000);
        const cleanup = () => { clearTimeout(timeout); entry.listeners.delete(check); };
        entry.listeners.add(check);
        check();
      });
    })(),
    // Asset uploads can also stall; leaving must remain recoverable.
    new Promise<never>((_, reject) => {
      uploadTimeout = setTimeout(() => reject(new Error('The drawing is still saving. Please retry.')), 15_000);
    }),
    ]);
  } finally {
    if (uploadTimeout) clearTimeout(uploadTimeout);
  }
}

function snapshot(entry: Entry): ExcalidrawCollaborationDocument {
  return {
    prepareToLeave: () => prepareSceneToLeave(entry),
    hasPendingChanges: () => hasPendingSceneChanges(entry),
    registryKey: entry.key,
    session: entry.session,
    status: entry.status,
    error: entry.error,
    sceneSequence: entry.sceneSequence,
    initialSnapshot: entry.initialSnapshot,
    remoteUpdate: entry.remoteUpdate,
    collaborators: [...entry.collaborators.values()],
    submitLocalScene(elements, appState, files) {
      entry.latestElements = elements;
      entry.latestAppState = appState;
      entry.latestFiles = files;
      synchronizeAssets(entry, files);
      scheduleFlush(entry);
    },
    sendPointer(payload) {
      entry.latestPointer = payload;
      if (entry.pointerTimer) return;
      entry.pointerTimer = setTimeout(() => {
        entry.pointerTimer = null;
        if (!entry.latestPointer) return;
        sendEnvelope(entry, envelope(entry, 'presence:pointer', entry.latestPointer));
      }, EXCALIDRAW_PRESENCE_THROTTLE_MS);
    },
    sendSelection(selectedElementIds) {
      entry.latestSelection = selectedElementIds;
      if (entry.selectionTimer) return;
      entry.selectionTimer = setTimeout(() => {
        entry.selectionTimer = null;
        const selected = JSON.stringify(entry.latestSelection);
        if (selected === entry.sentSelection) return;
        entry.sentSelection = selected;
        sendEnvelope(entry, envelope(entry, 'presence:selection', { selectedElementIds: entry.latestSelection }));
      }, EXCALIDRAW_PRESENCE_THROTTLE_MS);
    },
    async loadAsset(metadata) {
      const response = await fetch(`/api/files/excalidraw-assets/${encodeURIComponent(metadata.fileId)}`, {
        headers: workspaceHeaders(),
      });
      if (!response.ok) throw new Error(`Could not load Excalidraw asset ${metadata.fileId}.`);
      const data = new Uint8Array(await response.arrayBuffer());
      let binary = '';
      for (let offset = 0; offset < data.length; offset += 0x8000) {
        binary += String.fromCharCode(...data.subarray(offset, offset + 0x8000));
      }
      return {
        id: metadata.fileId as BinaryFileData['id'],
        mimeType: metadata.mimeType as BinaryFileData['mimeType'],
        dataURL: `data:${metadata.mimeType};base64,${window.btoa(binary)}` as BinaryFileData['dataURL'],
        created: metadata.createdAt,
        lastRetrieved: Date.now(),
        version: metadata.version,
      };
    },
  };
}

export function useExcalidrawCollaboration(input: {
  enabled: boolean;
  workspaceId: string | null;
  path: string;
}): ExcalidrawCollaborationDocument | null {
  const key = input.enabled && input.workspaceId ? `${input.workspaceId}\0${input.path}\0excalidraw` : null;
  const [state, setState] = useState<ExcalidrawCollaborationDocument | null>(null);
  useEffect(() => {
    if (!key) return;
    let entry = registry.get(key);
    if (!entry) {
      entry = createEntry(key, input.path);
      registry.set(key, entry);
    }
    entry.stopped = false;
    if (entry.cleanupTimer) clearTimeout(entry.cleanupTimer);
    entry.refs += 1;
    const update = () => setState(snapshot(entry));
    entry.listeners.add(update);
    update();
    void connect(entry);
    return () => {
      entry.listeners.delete(update);
      entry.refs -= 1;
      if (entry.refs === 0) {
        entry.cleanupTimer = setTimeout(() => {
          if (entry.refs !== 0) return;
          entry.stopped = true;
          entry.generation += 1;
          if (entry.flushTimer) clearTimeout(entry.flushTimer);
          if (entry.pointerTimer) clearTimeout(entry.pointerTimer);
          if (entry.selectionTimer) clearTimeout(entry.selectionTimer);
          if (entry.fullSyncTimer) clearTimeout(entry.fullSyncTimer);
          if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
          entry.socket?.close(1000, 'Editor closed.');
          registry.delete(key);
        }, 1_000);
      }
    };
  }, [input.path, key]);
  return key && state?.registryKey === key ? state : null;
}
