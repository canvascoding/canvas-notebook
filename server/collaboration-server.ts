import type http from 'node:http';
import type net from 'node:net';

import { Hocuspocus, type onAwarenessUpdatePayload } from '@hocuspocus/server';
import { WebSocketServer } from 'ws';

import { auth } from '@/app/lib/auth';
import {
  CollaborationCheckpointSupersededError,
  materializeCollaborationCheckpoint,
} from '@/app/lib/collaboration/checkpoint';
import {
  AgentDirectConnectionAuthorizationError,
  installCollaborationDirectConnection,
} from '@/app/lib/collaboration/direct-connection';
import {
  resolveAgentExecutionContextForStoredSession,
  workspaceFromAgentExecutionContext,
} from '@/app/lib/pi/session-workspace-context';
import { installCollaborationDocumentReader } from '@/app/lib/collaboration/document-access';
import { setCollaborationRuntimeHealth } from '@/app/lib/collaboration/health';
import { collaborationUserColors } from '@/app/lib/collaboration/identity';
import {
  detectLateAgentSemanticConflicts,
  recoverCollaborationAgentOperations,
} from '@/app/lib/collaboration/agent-operations';
import {
  CollaborationStateInactiveError,
  CollaborationStateStaleError,
  loadCollaborationState,
  markCollaborationDegraded,
  persistCollaborationYDoc,
  type PersistedCollaborationState,
} from '@/app/lib/collaboration/persistence';
import { replaceDocumentPresence } from '@/app/lib/collaboration/presence';
import { verifyCollaborationTicket } from '@/app/lib/collaboration/ticket';
import {
  installCollaborationRoomInspector,
  reserveCollaborationRoomAdmission,
  withCollaborationRoomLifecycleLock,
} from '@/app/lib/collaboration/runtime-state';
import { liveCollaborationRuntimeAvailable } from '@/app/lib/collaboration/runtime-policy';
import { Y } from '@/app/lib/collaboration/server-runtime';
import type { CollaborationTicketClaims, FilePresenceEntry } from '@/app/lib/collaboration/types';
import { getFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import {
  consumeMobileCollaborationTicket,
  hasMobileCollaborationProtocol,
  MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL,
} from '@/app/lib/mobile/collaboration-ticket';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { resolvePostgresWorkspaceForActor } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

const COLLABORATION_PATH = '/ws/collaboration';
const MAX_UPDATE_BYTES = 1024 * 1024;

function durabilitySnapshotPayload(state: PersistedCollaborationState) {
  return {
    type: 'durability_snapshot' as const,
    documentId: state.documentId,
    lifecycleGeneration: state.lifecycleGeneration,
    documentSequence: state.documentSequence,
    checkpointSequence: state.checkpointSequence,
    stateVector: Buffer.from(state.stateVector).toString('base64'),
  };
}

type CollaborationContext = {
  claims: CollaborationTicketClaims;
  workspace: WorkspaceContext;
  user: { id: string; name: string; email: string | null };
  actorType: 'user' | 'agent';
  initiatedByUserId: string | null;
  operationId: string | null;
  observedDocumentSequence: number | null;
  releaseRoomAdmission: (() => void) | null;
};

function normalizedPath(requestUrl?: string): string | null {
  const [requestPath, query = ''] = (requestUrl || '').split('?', 2);
  if (requestPath === COLLABORATION_PATH) return query ? `${COLLABORATION_PATH}?${query}` : COLLABORATION_PATH;
  if (/^\/[a-z]{2}(?:-[A-Z]{2})?\/ws\/collaboration$/u.test(requestPath)) {
    return query ? `${COLLABORATION_PATH}?${query}` : COLLABORATION_PATH;
  }
  return null;
}

export function isCollaborationWebSocketRequest(requestUrl?: string): boolean {
  return normalizedPath(requestUrl) !== null;
}

function requestFromIncoming(request: http.IncomingMessage): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(`http://${request.headers.host || 'localhost'}${request.url || COLLABORATION_PATH}`, { headers });
}

function reject(socket: net.Socket, status = '403 Forbidden'): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function presenceFromAwareness(
  context: CollaborationContext | undefined,
  payload: onAwarenessUpdatePayload<CollaborationContext>,
): FilePresenceEntry[] {
  const fallback = context;
  return payload.states.flatMap((state) => {
    const canvas = state.canvas as Partial<FilePresenceEntry> | undefined;
    if (!canvas?.userId || !canvas.displayName || !fallback) return [];
    return [{
      workspaceId: fallback.claims.workspaceId,
      documentId: fallback.claims.documentId,
      path: fallback.claims.path,
      userId: canvas.userId,
      sessionId: canvas.sessionId || fallback.claims.sessionId,
      actorType: canvas.actorType === 'agent' ? 'agent' : 'user',
      initiatedByUserId: canvas.initiatedByUserId || null,
      displayName: canvas.displayName,
      color: canvas.color || '#2563eb',
      colorLight: canvas.colorLight || '#dbeafe',
      activity: canvas.activity === 'editing' || canvas.activity === 'agent_editing' ? canvas.activity : 'viewing',
      updatedAt: Date.now(),
    } satisfies FilePresenceEntry];
  });
}

let collaborationInstance: Hocuspocus<CollaborationContext> | null = null;

export function createCollaborationServer(server: http.Server): WebSocketServer {
  const hocuspocus = new Hocuspocus<CollaborationContext>({
    debounce: 350,
    maxDebounce: 2_000,
    timeout: 30_000,
    async onAuthenticate({ token, documentName, requestHeaders, connectionConfig }) {
      if (!liveCollaborationRuntimeAvailable()) throw new Error('Collaboration requires Postgres.');
      const protocols = requestHeaders.get('sec-websocket-protocol')
        ?.split(',')
        .map((value) => value.trim()) ?? [];
      const mobileIdentity = protocols.includes(MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL)
        ? consumeMobileCollaborationTicket(token)
        : null;
      const claims = mobileIdentity?.claims ?? verifyCollaborationTicket(token);
      if (claims.documentId !== documentName) throw new Error('Collaboration document scope mismatch.');
      let authenticatedUser: {
        id: string;
        name: string;
        email: string | null;
        role?: string | null;
      };
      if (mobileIdentity) {
        authenticatedUser = mobileIdentity.user;
      } else {
        const session = await auth.api.getSession({ headers: requestHeaders });
        const sessionId = String((session?.session as { id?: string } | undefined)?.id || '');
        if (!session || session.user.id !== claims.userId || sessionId !== claims.sessionId) {
          throw new Error('Collaboration session is no longer authenticated.');
        }
        authenticatedUser = {
          id: session.user.id,
          name: session.user.name || session.user.email || 'User',
          email: session.user.email,
          role: session.user.role,
        };
      }
      if (authenticatedUser.id !== claims.userId) {
        throw new Error('Collaboration ticket user scope mismatch.');
      }
      const actor = resolveWorkspaceActor(authenticatedUser);
      const workspace = await resolvePostgresWorkspaceForActor(actor, claims.workspaceId);
      if (!workspace || !workspace.permissions.canRead) throw new Error('Workspace access was revoked.');
      if (claims.permission === 'write' && !workspace.permissions.canWrite) throw new Error('Workspace write access was revoked.');
      const releaseRoomAdmission = await withCollaborationRoomLifecycleLock(
        claims.documentId,
        async () => {
          const metadata = getFileCollaborationState({ workspace, path: claims.path, ensureDocument: false });
          const state = await loadCollaborationState(claims.documentId);
          if (
            !metadata.document
            || metadata.document.id !== claims.documentId
            || !state
            || state.workspaceId !== claims.workspaceId
            || state.path !== claims.path
            || state.representation !== claims.representation
            || state.lifecycleGeneration !== claims.lifecycleGeneration
          ) throw new Error('Collaboration document generation is stale.');
          return reserveCollaborationRoomAdmission(claims.documentId);
        },
      );
      connectionConfig.readOnly = claims.permission !== 'write';
      return {
        claims,
        workspace,
        user: {
          id: authenticatedUser.id,
          name: authenticatedUser.name,
          email: authenticatedUser.email,
        },
        actorType: 'user',
        initiatedByUserId: null,
        operationId: null,
        observedDocumentSequence: null,
        releaseRoomAdmission,
      };
    },
    async connected({ context, connection }) {
      context.releaseRoomAdmission?.();
      context.releaseRoomAdmission = null;
      const state = await loadCollaborationState(context.claims.documentId);
      if (
        !state
        || state.workspaceId !== context.claims.workspaceId
        || state.path !== context.claims.path
        || state.lifecycleGeneration !== context.claims.lifecycleGeneration
        || state.representation !== context.claims.representation
      ) {
        connection.sendStateless(JSON.stringify({
          type: 'degraded',
          message: 'The collaboration document generation changed. Reload to use the current document state.',
        }));
        connection.close();
        return;
      }
      connection.sendStateless(JSON.stringify(durabilitySnapshotPayload(state)));
    },
    async onLoadDocument({ documentName }) {
      const state = await loadCollaborationState(documentName);
      if (!state) throw new Error('Collaboration document was not initialized.');
      return state.yjsState;
    },
    async beforeHandleMessage({ update }) {
      if (update.byteLength > MAX_UPDATE_BYTES) throw new Error('Collaboration update exceeds the 1 MiB message limit.');
    },
    async beforeHandleAwareness({ context, states }) {
      if (!context) return;
      const colors = collaborationUserColors(context.user.id);
      for (const [clientId, state] of states) {
        const requested = state.canvas as Partial<FilePresenceEntry> | undefined;
        const requestedComposition = (state.canvas as {
          composition?: { textName?: unknown; from?: unknown; to?: unknown } | null;
        } | undefined)?.composition;
        const composition = requestedComposition
          && (requestedComposition.textName === 'content' || requestedComposition.textName === 'body')
          && Number.isInteger(requestedComposition.from)
          && Number.isInteger(requestedComposition.to)
          && Number(requestedComposition.from) >= 0
          && Number(requestedComposition.to) >= Number(requestedComposition.from)
          && Number(requestedComposition.to) <= 5 * 1024 * 1024
          ? {
              textName: requestedComposition.textName,
              from: Number(requestedComposition.from),
              to: Number(requestedComposition.to),
            }
          : null;
        states.set(clientId, {
          ...state,
          canvas: {
            userId: context.user.id,
            sessionId: context.claims.sessionId,
            actorType: 'user',
            initiatedByUserId: null,
            displayName: context.user.name.slice(0, 120),
            color: colors.color,
            colorLight: colors.colorLight,
            activity: requested?.activity === 'editing' ? 'editing' : 'viewing',
            composition,
          },
        });
      }
    },
    async onChange({ documentName, document, context }) {
      if (context.actorType !== 'user') return;
      await detectLateAgentSemanticConflicts({
        documentId: documentName,
        doc: document,
        observedDocumentSequence: context.observedDocumentSequence,
      });
    },
    async onStateless({ connection, documentName, payload }) {
      let acknowledgement: {
        type?: unknown;
        documentId?: unknown;
        lifecycleGeneration?: unknown;
        sequence?: unknown;
      };
      try {
        acknowledgement = JSON.parse(payload) as typeof acknowledgement;
      } catch {
        return;
      }
      if (
        acknowledgement.type !== 'checkpoint_ack'
        || acknowledgement.documentId !== documentName
        || acknowledgement.lifecycleGeneration !== connection.context.claims.lifecycleGeneration
        || !Number.isSafeInteger(acknowledgement.sequence)
        || Number(acknowledgement.sequence) < 0
      ) return;
      const state = await loadCollaborationState(documentName);
      if (!state || Number(acknowledgement.sequence) > state.checkpointSequence) return;
      connection.context.observedDocumentSequence = Math.max(
        connection.context.observedDocumentSequence || 0,
        Number(acknowledgement.sequence),
      );
    },
    async onAwarenessUpdate(payload) {
      const context = payload.connection?.context;
      if (!context) return;
      replaceDocumentPresence(
        context.claims.workspaceId,
        context.claims.documentId,
        presenceFromAwareness(context, payload),
      );
    },
    async onDisconnect({ context, document }) {
      context?.releaseRoomAdmission?.();
      if (context) context.releaseRoomAdmission = null;
      if (!context || document.getConnectionsCount() > 0) return;
      replaceDocumentPresence(context.claims.workspaceId, context.claims.documentId, []);
    },
    async onStoreDocument({ document, documentName, lastContext }) {
      let state: Awaited<ReturnType<typeof persistCollaborationYDoc>>;
      try {
        state = await persistCollaborationYDoc(
          documentName,
          lastContext.claims.lifecycleGeneration,
          document,
        );
      } catch (error) {
        // Delete/archive increments the lifecycle generation and invalidates
        // the room. A previously scheduled debounce may still run once; it
        // must not resurrect the file or report a false durability incident.
        if (error instanceof CollaborationStateInactiveError) return;
        if (error instanceof CollaborationStateStaleError) {
          document.broadcastStateless(JSON.stringify({
            type: 'degraded',
            message: 'The collaboration document generation changed. Reload to use the current document state.',
          }));
          hocuspocus.closeConnections(documentName);
          return;
        }
        await markCollaborationDegraded(
          documentName,
          lastContext.claims.lifecycleGeneration,
        ).catch(() => undefined);
        document.broadcastStateless(JSON.stringify({
          type: 'degraded',
          message: error instanceof Error ? error.message : 'Yjs persistence failed.',
        }));
        throw error;
      }
      document.broadcastStateless(JSON.stringify(durabilitySnapshotPayload(state)));
      try {
        const result = await materializeCollaborationCheckpoint({
          state,
          workspace: lastContext.workspace,
          actorUserId: lastContext.actorType === 'agent' ? lastContext.initiatedByUserId : lastContext.user.id,
          actorType: lastContext.actorType,
          sourceSessionId: lastContext.operationId || lastContext.claims.sessionId,
        });
        document.broadcastStateless(JSON.stringify({
          ...durabilitySnapshotPayload(result.state),
          type: 'checkpointed',
          sequence: result.state.documentSequence,
          revisionId: result.revisionId,
        }));
      } catch (error) {
        if (error instanceof CollaborationCheckpointSupersededError) {
          const currentState = await loadCollaborationState(documentName);
          document.broadcastStateless(JSON.stringify({
            ...(currentState ? durabilitySnapshotPayload(currentState) : {}),
            type: 'checkpoint_superseded',
            sequence: error.sequence,
          }));
          return;
        }
        await markCollaborationDegraded(documentName, state.lifecycleGeneration);
        document.broadcastStateless(JSON.stringify({
          type: 'degraded',
          message: error instanceof Error ? error.message : 'Checkpoint failed.',
        }));
      }
    },
  });
  collaborationInstance = hocuspocus;
  installCollaborationRoomInspector((documentId) => (
    hocuspocus.documents.get(documentId)?.getConnectionsCount() || 0
  ));
  installCollaborationDocumentReader(async (documentId, workspaceId, read) => {
    const state = await loadCollaborationState(documentId);
    if (!state || state.status !== 'active' || state.workspaceId !== workspaceId) {
      throw new Error('Collaboration document is unavailable or stale.');
    }
    const activeDocument = hocuspocus.documents.get(documentId);
    if (activeDocument) return read(activeDocument);

    const doc = new Y.Doc({ gc: true });
    try {
      Y.applyUpdate(doc, state.yjsState);
      return read(doc);
    } finally {
      doc.destroy();
    }
  });
  void recoverCollaborationAgentOperations().catch((error) => {
    console.error('[Collaboration] Agent operation recovery failed:', error);
  });
  setCollaborationRuntimeHealth({ websocketReady: true, persistenceReady: true });
  installCollaborationDirectConnection(async (input, apply, onApplied) => {
    const actorType = input.actorType ?? 'agent';
    let workspace = input.workspace;
    if (actorType === 'agent') {
      if (!input.actorSessionId) {
        throw new AgentDirectConnectionAuthorizationError('Agent collaboration operations require their originating session.');
      }
      let executionContext: Awaited<ReturnType<typeof resolveAgentExecutionContextForStoredSession>>;
      try {
        executionContext = await resolveAgentExecutionContextForStoredSession({
          sessionId: input.actorSessionId,
          userId: input.initiatedByUserId,
          agentId: input.actorId,
          permissions: ['canRead', 'canRunAgent', 'canWrite'],
        });
      } catch {
        throw new AgentDirectConnectionAuthorizationError('The agent session no longer has write access to this collaboration workspace.');
      }
      workspace = workspaceFromAgentExecutionContext(executionContext);
      if (workspace.workspaceId !== input.workspace.workspaceId) {
        throw new AgentDirectConnectionAuthorizationError('The agent session no longer has access to this collaboration workspace.');
      }
    }
    const { state, releaseRoomAdmission } = await withCollaborationRoomLifecycleLock(
      input.documentId,
      async () => {
        const state = await loadCollaborationState(input.documentId);
        const collaboration = input.requiresFileCheckpointIdentity
          ? getFileCollaborationState({
              workspace,
              path: input.documentPath,
              ensureDocument: false,
            })
          : null;
        if (
          !state
          || state.workspaceId !== workspace.workspaceId
          || state.path !== input.documentPath
          || state.representation !== input.documentRepresentation
          || state.lifecycleGeneration !== input.documentLifecycleGeneration
          || state.schemaVersion !== input.documentSchemaVersion
          || (input.requiresFileCheckpointIdentity && (
            !collaboration?.document
            || collaboration.document.id !== input.documentId
            || collaboration.document.status !== 'active'
            || collaboration.document.provider !== 'yjs'
          ))
        ) {
          throw new Error('Collaboration document identity, lifecycle, or representation is unavailable or stale.');
        }
        return {
          state,
          releaseRoomAdmission: reserveCollaborationRoomAdmission(input.documentId),
        };
      },
    );
    const context: CollaborationContext = {
      claims: {
        schemaVersion: state.schemaVersion,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 60_000,
        userId: input.initiatedByUserId,
        sessionId: input.actorSessionId || input.operationId,
        workspaceId: state.workspaceId,
        organizationId: state.organizationId,
        documentId: state.documentId,
        path: state.path,
        provider: 'yjs',
        representation: state.representation,
        permission: 'write',
        lifecycleGeneration: state.lifecycleGeneration,
      },
      workspace,
      user: { id: input.actorId, name: input.actorDisplayName, email: null },
      actorType,
      initiatedByUserId: actorType === 'agent' ? input.initiatedByUserId : null,
      operationId: actorType === 'agent' ? input.operationId : null,
      observedDocumentSequence: state.documentSequence,
      releaseRoomAdmission,
    };
    const connection = await hocuspocus.openDirectConnection(input.documentId, context).then(
      (openedConnection) => {
        context.releaseRoomAdmission?.();
        context.releaseRoomAdmission = null;
        return openedConnection;
      },
      (error) => {
        context.releaseRoomAdmission?.();
        context.releaseRoomAdmission = null;
        throw error;
      },
    );
    let result: unknown;
    try {
      await connection.transact((document) => { result = apply(document); });
      if (onApplied) await onApplied(result as never);
      await connection.disconnect({ unloadImmediately: true });
    } catch (error) {
      await connection.disconnect({ unloadImmediately: true }).catch(() => undefined);
      throw error;
    }
    return result as never;
  });
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    const nextUrl = normalizedPath(request.url);
    if (!nextUrl) return;
    if (
      !isConfiguredTrustedOrigin(request.headers.origin)
      && !hasMobileCollaborationProtocol(request.headers)
    ) return reject(socket as net.Socket);
    request.url = nextUrl;
    wss.handleUpgrade(request, socket, head, (websocket) => {
      const connection = hocuspocus.handleConnection(websocket, requestFromIncoming(request));
      websocket.on('message', (data) => {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        connection.handleMessage(bytes);
      });
      websocket.on('close', (code, reason) => {
        connection.handleClose({ code, reason: reason.toString() } as CloseEvent);
      });
      websocket.on('error', (error) => {
        console.error('[Collaboration] WebSocket peer error:', error);
      });
    });
  });
  return wss;
}

export async function flushCollaborationDocuments(): Promise<void> {
  const instance = collaborationInstance;
  if (!instance) return;
  instance.flushPendingStores();
  const deadline = Date.now() + 7_500;
  while (Date.now() < deadline) {
    const pending = [...instance.documents.values()].some((document) => (
      document.saveMutex.isLocked()
      || instance.debouncer.isDebounced(`onStoreDocument-${document.name}`)
      || instance.debouncer.isCurrentlyExecuting(`onStoreDocument-${document.name}`)
    ));
    if (!pending) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out while flushing collaboration documents.');
}
