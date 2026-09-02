import type http from 'node:http';
import type net from 'node:net';
import crypto from 'node:crypto';

import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { auth } from '@/app/lib/auth';
import { setCollaborationRuntimeHealth } from '@/app/lib/collaboration/health';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import { replaceDocumentPresence } from '@/app/lib/collaboration/presence';
import { verifyCollaborationTicket } from '@/app/lib/collaboration/ticket';
import type { CollaborationTicketClaims, FilePresenceEntry } from '@/app/lib/collaboration/types';
import { validateExcalidrawAssetMetadata } from '@/app/lib/excalidraw-collaboration/assets';
import { materializeExcalidrawCheckpoint } from '@/app/lib/excalidraw-collaboration/checkpoint';
import {
  EXCALIDRAW_COLLABORATION_PATH,
  EXCALIDRAW_MAX_MESSAGE_BYTES,
  isExcalidrawClientEnvelope,
  type ExcalidrawAssetMetadata,
  type ExcalidrawPresencePayload,
  type ExcalidrawServerMessage,
} from '@/app/lib/excalidraw-collaboration/protocol';
import {
  applyExcalidrawScenePatch,
  ExcalidrawSceneResyncError,
  loadExcalidrawScene,
  markExcalidrawSceneDegraded,
  type PersistedExcalidrawScene,
} from '@/app/lib/excalidraw-collaboration/repository';
import { installExcalidrawCollaborationRuntime } from '@/app/lib/excalidraw-collaboration/runtime';
import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const AUTHENTICATION_TIMEOUT_MS = 7_500;
const HEARTBEAT_INTERVAL_MS = 25_000;
const CHECKPOINT_DEBOUNCE_MS = 500;
const MAX_SCENE_PATCHES_PER_MINUTE = 180;
const MAX_PRESENCE_MESSAGES_PER_MINUTE = 2_000;

type ConnectionContext = {
  socket: WebSocket;
  requestHeaders: Headers;
  connectionId: string;
  claims: CollaborationTicketClaims;
  workspace: WorkspaceContext;
  user: { id: string; name: string; color: string; colorLight: string };
  presence: ExcalidrawPresencePayload;
  acknowledgedSequence: number;
  sceneWindow: { startedAt: number; count: number };
  presenceWindow: { startedAt: number; count: number };
  authenticatedAt: number;
  isAlive: boolean;
  ticketTimer: ReturnType<typeof setTimeout>;
};

type Room = {
  documentId: string;
  workspace: WorkspaceContext;
  connections: Set<ConnectionContext>;
  checkpointTimer: ReturnType<typeof setTimeout> | null;
  checkpointPromise: Promise<void> | null;
  lastActor: {
    userId: string | null;
    sessionId: string | null;
    actorType: 'user' | 'agent';
    initiatedByUserId: string | null;
  };
};

const rooms = new Map<string, Room>();

function requestHeaders(request: http.IncomingMessage): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return headers;
}

function normalizedPath(requestUrl?: string): string | null {
  const requestPath = (requestUrl || '').split('?', 1)[0];
  if (requestPath === EXCALIDRAW_COLLABORATION_PATH) return EXCALIDRAW_COLLABORATION_PATH;
  if (/^\/[a-z]{2}(?:-[A-Z]{2})?\/ws\/collaboration\/excalidraw$/u.test(requestPath)) {
    return EXCALIDRAW_COLLABORATION_PATH;
  }
  return null;
}

export function isExcalidrawCollaborationWebSocketRequest(requestUrl?: string): boolean {
  return normalizedPath(requestUrl) !== null;
}

function reject(socket: net.Socket, status = '403 Forbidden'): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function rawBuffer(data: RawData): Buffer {
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function send(socket: WebSocket, message: ExcalidrawServerMessage): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function messageId(): string {
  return crypto.randomUUID();
}

function broadcast(room: Room, message: ExcalidrawServerMessage, except?: WebSocket): void {
  for (const connection of room.connections) {
    if (connection.socket !== except) send(connection.socket, message);
  }
}

function presenceEntry(context: ConnectionContext): FilePresenceEntry {
  return {
    workspaceId: context.claims.workspaceId,
    documentId: context.claims.documentId,
    path: context.claims.path,
    userId: context.user.id,
    sessionId: context.claims.sessionId,
    actorType: 'user',
    initiatedByUserId: null,
    displayName: context.user.name,
    color: context.user.color,
    colorLight: context.user.colorLight,
    activity: context.claims.permission === 'write' ? 'editing' : 'viewing',
    updatedAt: Date.now(),
  };
}

function projectRoomPresence(room: Room): void {
  replaceDocumentPresence(
    room.workspace.workspaceId,
    room.documentId,
    [...room.connections].map(presenceEntry),
  );
}

function roomFor(context: ConnectionContext): Room {
  let room = rooms.get(context.claims.documentId);
  if (!room) {
    room = {
      documentId: context.claims.documentId,
      workspace: context.workspace,
      connections: new Set(),
      checkpointTimer: null,
      checkpointPromise: null,
      lastActor: { userId: null, sessionId: null, actorType: 'user', initiatedByUserId: null },
    };
    rooms.set(context.claims.documentId, room);
  }
  return room;
}

function snapshotMessage(state: PersistedExcalidrawScene, permission: 'read' | 'write'): ExcalidrawServerMessage {
  return {
    schemaVersion: 1,
    type: 'scene:init',
    messageId: messageId(),
    permission,
    snapshot: {
      elements: state.elements,
      appState: state.appState,
      assets: state.assets,
      sceneSequence: state.sceneSequence,
      lifecycleGeneration: state.lifecycleGeneration,
      canonicalHash: state.canonicalHash,
    },
  };
}

function consumeRate(window: { startedAt: number; count: number }, limit: number): boolean {
  const now = Date.now();
  if (now - window.startedAt >= 60_000) {
    window.startedAt = now;
    window.count = 0;
  }
  window.count += 1;
  return window.count <= limit;
}

function validatePresence(type: string, payload: unknown): ExcalidrawPresencePayload {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Invalid Excalidraw presence payload.');
  const input = payload as Record<string, unknown>;
  if (type === 'presence:pointer') {
    const pointer = input.pointer as Record<string, unknown> | undefined;
    if (!pointer || !Number.isFinite(pointer.x) || !Number.isFinite(pointer.y)
      || Math.abs(Number(pointer.x)) > 10_000_000 || Math.abs(Number(pointer.y)) > 10_000_000
      || (pointer.tool !== 'pointer' && pointer.tool !== 'laser')) throw new Error('Invalid Excalidraw pointer presence.');
    return {
      pointer: { x: Number(pointer.x), y: Number(pointer.y), tool: pointer.tool },
      button: input.button === 'down' ? 'down' : 'up',
    };
  }
  if (type === 'presence:selection') {
    if (!input.selectedElementIds || typeof input.selectedElementIds !== 'object' || Array.isArray(input.selectedElementIds)) {
      throw new Error('Invalid Excalidraw selection presence.');
    }
    const entries = Object.entries(input.selectedElementIds as Record<string, unknown>);
    if (entries.length > 500 || entries.some(([id, selected]) => !/^[A-Za-z0-9_-]{1,128}$/u.test(id) || selected !== true)) {
      throw new Error('Invalid Excalidraw selection presence.');
    }
    return { selectedElementIds: Object.fromEntries(entries) as Record<string, true> };
  }
  if (!['active', 'idle', 'away'].includes(String(input.idleState))) throw new Error('Invalid Excalidraw idle presence.');
  return { idleState: input.idleState as 'active' | 'idle' | 'away' };
}

async function revalidateWriteContext(context: ConnectionContext): Promise<void> {
  const session = await auth.api.getSession({ headers: context.requestHeaders });
  const sessionId = String((session?.session as { id?: string } | undefined)?.id || '');
  if (!session || session.user.id !== context.claims.userId || sessionId !== context.claims.sessionId) {
    throw new Error('Collaboration session is no longer authenticated.');
  }
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(session.user), context.claims.workspaceId);
  if (!workspace?.permissions.canRead || !workspace.permissions.canWrite) throw new Error('Workspace write access was revoked.');
  const metadata = await getFileCollaborationState({ workspace, path: context.claims.path, ensureDocument: false });
  const state = await loadExcalidrawScene(context.claims.documentId);
  if (
    !metadata.sceneCapable
    || metadata.document?.id !== context.claims.documentId
    || metadata.document.provider !== 'excalidraw'
    || !state
    || state.workspaceId !== context.claims.workspaceId
    || state.path !== context.claims.path
    || state.lifecycleGeneration !== context.claims.lifecycleGeneration
  ) throw new Error('Excalidraw collaboration document generation is stale.');
  context.workspace = workspace;
}

async function authenticateConnection(
  socket: WebSocket,
  headers: Headers,
  value: unknown,
): Promise<{ context: ConnectionContext; state: PersistedExcalidrawScene }> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Excalidraw authentication message is required.');
  const authMessage = value as { type?: unknown; token?: unknown };
  if (authMessage.type !== 'authenticate' || typeof authMessage.token !== 'string' || authMessage.token.length > 8_192) {
    throw new Error('Invalid Excalidraw authentication message.');
  }
  if (!liveCollaborationRuntimeAvailable()) throw new Error('Excalidraw collaboration requires Postgres.');
  const claims = verifyCollaborationTicket(authMessage.token);
  if (claims.provider !== 'excalidraw' || claims.representation !== 'excalidraw_scene') throw new Error('Ticket is not valid for Excalidraw collaboration.');
  const session = await auth.api.getSession({ headers });
  const sessionId = String((session?.session as { id?: string } | undefined)?.id || '');
  if (!session || session.user.id !== claims.userId || sessionId !== claims.sessionId) throw new Error('Collaboration session is no longer authenticated.');
  const workspace = await resolvePostgresWorkspaceForActor(resolveWorkspaceActor(session.user), claims.workspaceId);
  if (!workspace?.permissions.canRead) throw new Error('Workspace access was revoked.');
  if (claims.permission === 'write' && !workspace.permissions.canWrite) throw new Error('Workspace write access was revoked.');
  const metadata = await getFileCollaborationState({ workspace, path: claims.path, ensureDocument: false });
  const state = await loadExcalidrawScene(claims.documentId);
  if (
    !metadata.sceneCapable
    || metadata.document?.id !== claims.documentId
    || metadata.document.provider !== 'excalidraw'
    || !state
    || state.workspaceId !== claims.workspaceId
    || state.path !== claims.path
    || state.lifecycleGeneration !== claims.lifecycleGeneration
  ) throw new Error('Excalidraw collaboration document generation is stale.');
  const colors = collaborationUserColors(session.user.id);
  const now = Date.now();
  const context: ConnectionContext = {
    socket,
    requestHeaders: headers,
    connectionId: crypto.randomUUID(),
    claims,
    workspace,
    user: {
      id: session.user.id,
      name: (session.user.name || session.user.email || 'User').slice(0, 120),
      ...colors,
    },
    presence: {},
    acknowledgedSequence: state.sceneSequence,
    sceneWindow: { startedAt: now, count: 0 },
    presenceWindow: { startedAt: now, count: 0 },
    authenticatedAt: now,
    isAlive: true,
    ticketTimer: setTimeout(() => socket.close(4401, 'Collaboration ticket renewal required.'), Math.max(1_000, claims.expiresAt - now)),
  };
  return { context, state };
}

async function runCheckpoint(room: Room): Promise<void> {
  if (room.checkpointPromise) return room.checkpointPromise;
  room.checkpointPromise = (async () => {
    const state = await loadExcalidrawScene(room.documentId);
    if (!state || state.status !== 'active' || state.checkpointSequence >= state.sceneSequence) return;
    try {
      await materializeExcalidrawCheckpoint({
        state,
        workspace: room.workspace,
        actorUserId: room.lastActor.userId,
        sourceSessionId: room.lastActor.sessionId,
        actorType: room.lastActor.actorType,
      });
      broadcast(room, {
        schemaVersion: 1,
        type: 'scene:status',
        messageId: messageId(),
        status: 'saved',
        sceneSequence: state.sceneSequence,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'Excalidraw checkpoint failed.';
      await markExcalidrawSceneDegraded(room.documentId, reason).catch(() => undefined);
      broadcast(room, {
        schemaVersion: 1,
        type: 'scene:status',
        messageId: messageId(),
        status: 'degraded',
        sceneSequence: state.sceneSequence,
        message: reason,
      });
    }
  })().finally(() => {
    room.checkpointPromise = null;
    if (room.connections.size === 0 && !room.checkpointTimer) rooms.delete(room.documentId);
  });
  return room.checkpointPromise;
}

function scheduleCheckpoint(room: Room): void {
  if (room.checkpointTimer) clearTimeout(room.checkpointTimer);
  room.checkpointTimer = setTimeout(() => {
    room.checkpointTimer = null;
    void runCheckpoint(room);
  }, CHECKPOINT_DEBOUNCE_MS);
}

async function handleAuthenticatedMessage(context: ConnectionContext, value: unknown): Promise<void> {
  if (!isExcalidrawClientEnvelope(value)) throw new Error('Unsupported Excalidraw collaboration message.');
  if (value.lifecycleGeneration !== context.claims.lifecycleGeneration) {
    const state = await loadExcalidrawScene(context.claims.documentId);
    throw new ExcalidrawSceneResyncError(state?.sceneSequence ?? 0, 'The Excalidraw lifecycle generation changed.');
  }
  const room = roomFor(context);
  if (value.type.startsWith('presence:')) {
    if (!consumeRate(context.presenceWindow, MAX_PRESENCE_MESSAGES_PER_MINUTE)) throw new Error('Excalidraw presence rate limit exceeded.');
    const presence = validatePresence(value.type, value.payload);
    context.presence = { ...context.presence, ...presence };
    broadcast(room, {
      schemaVersion: 1,
      type: 'presence:update',
      messageId: messageId(),
      connectionId: context.connectionId,
      user: context.user,
      payload: context.presence,
    }, context.socket);
    projectRoomPresence(room);
    return;
  }
  if (value.type === 'scene:resync_request') {
    const state = await loadExcalidrawScene(context.claims.documentId);
    if (!state) throw new Error('Excalidraw scene is unavailable.');
    send(context.socket, snapshotMessage(state, context.claims.permission));
    return;
  }
  if (value.type === 'scene:ack') {
    const sequence = (value.payload as { sceneSequence?: unknown } | null)?.sceneSequence;
    const state = await loadExcalidrawScene(context.claims.documentId);
    if (!state || !Number.isSafeInteger(sequence) || Number(sequence) < 0 || Number(sequence) > state.sceneSequence) return;
    context.acknowledgedSequence = Math.max(context.acknowledgedSequence, Number(sequence));
    send(context.socket, {
      schemaVersion: 1,
      type: 'scene:ack',
      messageId: messageId(),
      replyTo: value.messageId,
      sceneSequence: context.acknowledgedSequence,
    });
    return;
  }
  if (!consumeRate(context.sceneWindow, MAX_SCENE_PATCHES_PER_MINUTE)) throw new Error('Excalidraw scene patch rate limit exceeded.');
  if (context.claims.permission !== 'write') throw new Error('This Excalidraw session is read-only.');
  await revalidateWriteContext(context);
  const payload = value.payload as { elements?: unknown; appState?: unknown; assets?: unknown } | null;
  if (!payload || !Array.isArray(payload.elements)) throw new Error('Excalidraw scene patch elements are required.');
  let assets: ExcalidrawAssetMetadata[] | undefined;
  if (payload.assets !== undefined) {
    if (!Array.isArray(payload.assets)) throw new Error('Excalidraw asset references must be an array.');
    assets = await validateExcalidrawAssetMetadata(context.claims.workspaceId, payload.assets as ExcalidrawAssetMetadata[]);
  }
  broadcast(room, {
    schemaVersion: 1,
    type: 'scene:status',
    messageId: messageId(),
    status: 'persisting',
    sceneSequence: value.baseSequence,
  });
  const result = await applyExcalidrawScenePatch({
    documentId: context.claims.documentId,
    lifecycleGeneration: context.claims.lifecycleGeneration,
    baseSequence: value.baseSequence,
    messageId: value.messageId,
    elements: payload.elements,
    appState: payload.appState,
    assets,
    actorType: 'user',
    actorId: context.user.id,
  });
  const applied: ExcalidrawServerMessage = {
    schemaVersion: 1,
    type: 'scene:applied',
    messageId: messageId(),
    replyTo: value.messageId,
    elements: result.acceptedElements,
    appState: result.acceptedAppState,
    assets: result.state.assets,
    sceneSequence: result.state.sceneSequence,
    canonicalHash: result.state.canonicalHash,
    persisted: true,
    checkpointed: result.state.checkpointSequence >= result.state.sceneSequence,
  };
  if (result.duplicate) send(context.socket, applied);
  else broadcast(room, applied);
  context.acknowledgedSequence = result.state.sceneSequence;
  room.workspace = context.workspace;
  room.lastActor = {
    userId: context.user.id,
    sessionId: context.claims.sessionId,
    actorType: 'user',
    initiatedByUserId: null,
  };
  scheduleCheckpoint(room);
}

function removeConnection(context: ConnectionContext): void {
  clearTimeout(context.ticketTimer);
  const room = rooms.get(context.claims.documentId);
  if (!room) return;
  room.connections.delete(context);
  broadcast(room, {
    schemaVersion: 1,
    type: 'presence:leave',
    messageId: messageId(),
    connectionId: context.connectionId,
    user: context.user,
  });
  projectRoomPresence(room);
  if (room.connections.size === 0) scheduleCheckpoint(room);
}

export function createExcalidrawCollaborationServer(server: http.Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: EXCALIDRAW_MAX_MESSAGE_BYTES });
  const heartbeat = setInterval(() => {
    for (const socket of wss.clients) {
      const context = (socket as WebSocket & { canvasContext?: ConnectionContext }).canvasContext;
      if (context && !context.isAlive) {
        socket.terminate();
        continue;
      }
      if (context) context.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  wss.on('close', () => clearInterval(heartbeat));
  wss.on('connection', (socket, request) => {
    const peer = socket as WebSocket & { canvasContext?: ConnectionContext };
    const headers = requestHeaders(request);
    const authenticationTimer = setTimeout(() => socket.close(4401, 'Authentication timeout.'), AUTHENTICATION_TIMEOUT_MS);
    socket.on('pong', () => { if (peer.canvasContext) peer.canvasContext.isAlive = true; });
    socket.on('message', async (raw) => {
      try {
        const data = rawBuffer(raw);
        if (data.byteLength > EXCALIDRAW_MAX_MESSAGE_BYTES) throw new Error('Excalidraw collaboration message exceeds 1 MiB.');
        const value = JSON.parse(data.toString('utf8')) as unknown;
        if (!peer.canvasContext) {
          const authenticated = await authenticateConnection(socket, headers, value);
          clearTimeout(authenticationTimer);
          peer.canvasContext = authenticated.context;
          const room = roomFor(authenticated.context);
          room.connections.add(authenticated.context);
          send(socket, snapshotMessage(authenticated.state, authenticated.context.claims.permission));
          for (const other of room.connections) {
            if (other === authenticated.context) continue;
            send(socket, {
              schemaVersion: 1,
              type: 'presence:update',
              messageId: messageId(),
              connectionId: other.connectionId,
              user: other.user,
              payload: other.presence,
            });
          }
          broadcast(room, {
            schemaVersion: 1,
            type: 'presence:update',
            messageId: messageId(),
            connectionId: authenticated.context.connectionId,
            user: authenticated.context.user,
            payload: authenticated.context.presence,
          }, socket);
          projectRoomPresence(room);
          return;
        }
        await handleAuthenticatedMessage(peer.canvasContext, value);
      } catch (error) {
        const currentSequence = error instanceof ExcalidrawSceneResyncError ? error.currentSequence : undefined;
        if (currentSequence !== undefined) {
          send(socket, {
            schemaVersion: 1,
            type: 'scene:resync_required',
            messageId: messageId(),
            reason: error instanceof Error ? error.message : 'Excalidraw scene resynchronization is required.',
            sceneSequence: currentSequence,
          });
          return;
        }
        send(socket, {
          schemaVersion: 1,
          type: 'error',
          messageId: messageId(),
          code: 'EXCALIDRAW_MESSAGE_REJECTED',
          message: error instanceof Error ? error.message : 'Excalidraw collaboration message was rejected.',
        });
        if (!peer.canvasContext) socket.close(4403, 'Authentication failed.');
      }
    });
    socket.on('close', () => {
      clearTimeout(authenticationTimer);
      if (peer.canvasContext) removeConnection(peer.canvasContext);
    });
    socket.on('error', (error) => console.error('[ExcalidrawCollaboration] WebSocket peer error:', error));
  });
  server.on('upgrade', (request, socket, head) => {
    if (!normalizedPath(request.url)) return;
    if (!isConfiguredTrustedOrigin(request.headers.origin)) return reject(socket as net.Socket);
    request.url = EXCALIDRAW_COLLABORATION_PATH;
    wss.handleUpgrade(request, socket, head, (websocket) => wss.emit('connection', websocket, request));
  });
  setCollaborationRuntimeHealth({
    excalidrawWebsocketReady: true,
    scenePersistenceReady: true,
    assetStoreReady: true,
  });
  installExcalidrawCollaborationRuntime({
    connectionCount: (documentId) => rooms.get(documentId)?.connections.size ?? 0,
    publishApplied: (documentId, operationId, result, attribution) => {
      const room = rooms.get(documentId);
      if (!room) return;
      broadcast(room, {
        schemaVersion: 1,
        type: 'scene:applied',
        messageId: messageId(),
        replyTo: operationId,
        elements: result.acceptedElements,
        appState: result.acceptedAppState,
        assets: result.state.assets,
        sceneSequence: result.state.sceneSequence,
        canonicalHash: result.state.canonicalHash,
        persisted: true,
        checkpointed: result.state.checkpointSequence >= result.state.sceneSequence,
      });
      room.lastActor = {
        userId: attribution.actorId,
        sessionId: operationId,
        actorType: 'agent',
        initiatedByUserId: attribution.initiatedByUserId,
      };
      scheduleCheckpoint(room);
    },
  });
  return wss;
}

export async function flushExcalidrawCollaborationDocuments(): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const room of rooms.values()) {
    if (room.checkpointTimer) {
      clearTimeout(room.checkpointTimer);
      room.checkpointTimer = null;
    }
    pending.push(runCheckpoint(room));
  }
  await Promise.all(pending);
}
