import type http from 'node:http';
import type net from 'node:net';

import { Hocuspocus, type Connection, type onAwarenessUpdatePayload } from '@hocuspocus/server';
import { WebSocketServer } from 'ws';
import type { Doc as YDoc } from 'yjs';

import { collaborationUpdateStateProof } from '@/app/lib/collaboration/state-proof';
import { COLLABORATION_FAILURE_CODES } from '@/app/lib/collaboration/failure';
import { createCollaborationProjectionRuntime } from '@/app/lib/collaboration/projection-runtime';
import { logCollaborationDiagnostic } from '@/app/lib/collaboration/diagnostics';
import { auth } from '@/app/lib/auth';
import { fileGuestService } from '@/app/lib/file-guests/service';
import { fileGuestCookieName } from '@/app/lib/file-guests/types';
import { assertFileGuestUpdateAllowed } from '@/app/lib/file-guests/update-policy';
import { createCollaborationAccessMonitor } from '@/app/lib/collaboration/access-monitor';
import { assertCollaborationDocumentAccess, resolveCollaborationSessionAccess, revalidateCollaborationAccess } from '@/app/lib/collaboration/connection-access';
import {
  AgentDirectConnectionAuthorizationError,
  installCollaborationDirectConnection,
  type AgentDirectConnectionInput,
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
import { readFileCollaborationState } from '@/app/lib/files/collaboration-policy';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import {
  consumeMobileCollaborationTicket,
  hasMobileCollaborationProtocol,
  MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL,
} from '@/app/lib/mobile/collaboration-ticket';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';
import { resolveUserProfile } from '@/app/lib/user-profile/service';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
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
    stateProof: collaborationUpdateStateProof(state.yjsState, Y),
  };
}

type CollaborationPresenceProfile = ResolvedUserProfile;

function presenceProfileImageUrl(workspaceId: string, userId: string, revision: number): string {
  const params = new URLSearchParams({ workspaceId, userId, v: String(revision) });
  return `/api/files/presence/avatar?${params.toString()}`;
}

async function resolveCollaborationPresenceProfile(input: {
  workspaceId: string;
  userId: string;
  name: string;
  email: string | null;
}): Promise<CollaborationPresenceProfile | null> {
  try {
    const profile = await resolveUserProfile({
      userId: input.userId,
      name: input.name,
      email: input.email,
    });
    return {
      ...profile,
      imageUrl: profile.imageUrl
        ? presenceProfileImageUrl(input.workspaceId, input.userId, profile.revision)
        : null,
    };
  } catch (error) {
    console.warn('[Collaboration] Failed to resolve presence profile.', error);
    return null;
  }
}

type CollaborationContext = {
  claims: CollaborationTicketClaims;
  workspace: WorkspaceContext;
  user: { id: string; name: string; email: string | null; profile?: CollaborationPresenceProfile | null };
  actorType: 'user' | 'agent';
  initiatedByUserId: string | null;
  operationId: string | null;
  observedDocumentSequence: number | null;
  releaseRoomAdmission: (() => void) | null;
  stopAccessWatch?: () => void;
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
      profile: fallback.user.profile ?? null,
      color: canvas.color || '#2563eb',
      colorLight: canvas.colorLight || '#dbeafe',
      activity: canvas.activity === 'editing' || canvas.activity === 'agent_editing' ? canvas.activity : 'viewing',
      updatedAt: Date.now(),
    } satisfies FilePresenceEntry];
  });
}

let collaborationInstance: Hocuspocus<CollaborationContext> | null = null;

function rejectCollaborationUpdate(connection: Connection<CollaborationContext>, message: string): never {
  connection.readOnly = true;
  connection.sendStateless(JSON.stringify({ type: 'update_rejected', message }));
  connection.close({ code: 4403, reason: 'Collaboration update rejected' });
  throw new Error(message);
}

async function resolveDirectConnectionWorkspace(input: AgentDirectConnectionInput): Promise<WorkspaceContext> {
  if ((input.actorType ?? 'agent') === 'agent') {
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
    const workspace = workspaceFromAgentExecutionContext(executionContext);
    if (workspace.workspaceId !== input.workspace.workspaceId) {
      throw new AgentDirectConnectionAuthorizationError('The agent session no longer has access to this collaboration workspace.');
    }
    return workspace;
  }
  if (input.actorSessionId) {
    const access = await resolveCollaborationSessionAccess({
      schemaVersion: input.documentSchemaVersion, issuedAt: Date.now(), expiresAt: Date.now() + 60_000,
      userId: input.initiatedByUserId, sessionId: input.actorSessionId, workspaceId: input.workspace.workspaceId,
      organizationId: input.workspace.organizationId ?? null, documentId: input.documentId, path: input.documentPath,
      provider: 'yjs', representation: input.documentRepresentation, permission: 'write',
      lifecycleGeneration: input.documentLifecycleGeneration,
    });
    return access.workspace;
  }
  return input.workspace;
}

async function assertDirectConnectionDocument(input: AgentDirectConnectionInput, workspace: WorkspaceContext) {
  const state = await loadCollaborationState(input.documentId);
  const collaboration = input.requiresFileCheckpointIdentity
    ? await readFileCollaborationState({ workspace, path: input.documentPath })
    : null;
  if (!state || state.status !== 'active'
    || state.workspaceId !== workspace.workspaceId
    || state.path !== input.documentPath
    || state.representation !== input.documentRepresentation
    || state.lifecycleGeneration !== input.documentLifecycleGeneration
    || state.schemaVersion !== input.documentSchemaVersion
    || (input.requiresFileCheckpointIdentity && (!collaboration?.document
      || collaboration.document.id !== input.documentId
      || collaboration.document.status !== 'active'
      || collaboration.document.provider !== 'yjs'))) {
    throw new AgentDirectConnectionAuthorizationError('Collaboration document identity, lifecycle, or representation is unavailable or stale.');
  }
  return state;
}

export function createCollaborationServer(server: http.Server): WebSocketServer {
  type RoomIdentity = Pick<CollaborationTicketClaims,
    'documentId' | 'workspaceId' | 'lifecycleGeneration' | 'representation' | 'schemaVersion'>;
  // Hocuspocus caches by document ID, while restore/migration reuse that ID
  // with a new generation. The room keeps the identity of the bytes it loaded.
  const roomIdentities = new WeakMap<YDoc, RoomIdentity>();
  const matchesRoomIdentity = (document: YDoc, expected: RoomIdentity) => {
    const identity = roomIdentities.get(document);
    return identity?.documentId === expected.documentId && identity.workspaceId === expected.workspaceId
      && identity.lifecycleGeneration === expected.lifecycleGeneration
      && identity.representation === expected.representation && identity.schemaVersion === expected.schemaVersion;
  };
  const assertRoomIdentity = (document: YDoc, expected: RoomIdentity) => {
    if (!matchesRoomIdentity(document, expected)) {
      hocuspocus.closeConnections(expected.documentId);
      throw new AgentDirectConnectionAuthorizationError('The live collaboration room belongs to an earlier document generation. Reload the document.');
    }
  };
  const projections = createCollaborationProjectionRuntime({
    onProjected(result) {
      const room = hocuspocus.documents.get(result.state.documentId);
      if (!room || !matchesRoomIdentity(room, result.state)) return;
      room.broadcastStateless(JSON.stringify({
        ...durabilitySnapshotPayload(result.state),
        // Older clients must not infer that a newer binary state was exported.
        type: result.state.checkpointSequence >= result.state.documentSequence ? 'checkpointed' : 'durability_snapshot',
        sequence: result.state.checkpointSequence,
        revisionId: result.revisionId,
      }));
    },
    onFailure({ state, code, blocksEditing }) {
      const room = hocuspocus.documents.get(state.documentId);
      if (!room || !matchesRoomIdentity(room, state)) return;
      room.broadcastStateless(JSON.stringify({
        ...durabilitySnapshotPayload(state),
        type: blocksEditing ? 'degraded' : 'projection_failed', code,
        ...(blocksEditing ? { message: 'The document structure could not be validated.' } : {}),
      }));
    },
  });
  server.once('close', () => projections.dispose());
  const accessMonitor = createCollaborationAccessMonitor<Connection<CollaborationContext>>({
    validate: async (connection) => {
      const access = await revalidateCollaborationAccess(connection.context.claims);
      if (!connection.document.hasConnection(connection)) throw new Error('Collaboration connection is closed.');
      connection.context.workspace = access.workspace;
    },
    deny: (connection) => {
      connection.readOnly = true;
      connection.sendStateless(JSON.stringify({
        type: 'access_revoked',
        message: 'Your session or file access is no longer valid. Reload to sign in or request access. Local changes are preserved.',
      }));
      connection.close({ code: 4403, reason: 'Collaboration access revoked' });
    },
  });
  server.once('close', () => accessMonitor.dispose());
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
      if (claims.guestInvitationId) {
        if (mobileIdentity) throw new Error('Guest sessions cannot use mobile authentication.');
        const cookieName = fileGuestCookieName(claims.guestInvitationId);
        const guestToken = requestHeaders.get('cookie')?.split(';').map((value) => value.trim())
          .find((value) => value.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1) || '';
        const guest = await fileGuestService.access(claims.guestInvitationId, { token: guestToken });
        if (guest.guestSession.id !== claims.sessionId) throw new Error('Guest session scope mismatch.');
        authenticatedUser = guest.user;
      } else if (mobileIdentity) {
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
      const access = await resolveCollaborationSessionAccess(claims);
      const workspace = access.workspace;
      authenticatedUser = { ...access.user, name: access.user.name || access.user.email || 'User' };
      const releaseRoomAdmission = await withCollaborationRoomLifecycleLock(
        claims.documentId,
        async () => {
          await assertCollaborationDocumentAccess(claims, workspace);
          const room = hocuspocus.documents.get(claims.documentId);
          if (room) assertRoomIdentity(room, claims);
          return reserveCollaborationRoomAdmission(claims.documentId);
        },
      );
      connectionConfig.readOnly = claims.permission !== 'write';
      const presenceProfile = claims.guestInvitationId ? null : await resolveCollaborationPresenceProfile({
        workspaceId: claims.workspaceId,
        userId: authenticatedUser.id,
        name: authenticatedUser.name,
        email: authenticatedUser.email,
      });
      return {
        claims,
        workspace,
        user: {
          id: authenticatedUser.id,
          name: authenticatedUser.name,
          email: authenticatedUser.email,
          profile: presenceProfile,
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
      context.stopAccessWatch = accessMonitor.add(connection);
      await accessMonitor.check(connection);
      const state = await loadCollaborationState(context.claims.documentId);
      if (
        !state
        || state.workspaceId !== context.claims.workspaceId
        || state.path !== context.claims.path
        || state.lifecycleGeneration !== context.claims.lifecycleGeneration
        || state.representation !== context.claims.representation
        || state.schemaVersion !== context.claims.schemaVersion
        || !matchesRoomIdentity(connection.document, context.claims)
      ) {
        connection.sendStateless(JSON.stringify({
          type: 'degraded',
          code: COLLABORATION_FAILURE_CODES.generationChanged,
          message: 'The collaboration document generation changed. Reload to use the current document state.',
        }));
        connection.close();
        return;
      }
      connection.sendStateless(JSON.stringify(durabilitySnapshotPayload(state)));
    },
    async onLoadDocument({ documentName, document }) {
      const state = await loadCollaborationState(documentName);
      if (!state) throw new Error('Collaboration document was not initialized.');
      roomIdentities.set(document, { documentId: state.documentId, workspaceId: state.workspaceId,
        lifecycleGeneration: state.lifecycleGeneration, representation: state.representation, schemaVersion: state.schemaVersion });
      return state.yjsState;
    },
    async beforeUnloadDocument({ documentName, document }) {
      if (hocuspocus.documents.get(documentName) !== document) {
        logCollaborationDiagnostic('debug', { event: 'room_generation_rejected', documentId: documentName,
          generation: roomIdentities.get(document)?.lifecycleGeneration, code: 'COLLABORATION_ROOM_REPLACED' });
        // Hocuspocus catches a rejected beforeUnloadDocument hook and returns
        // without deleting the map entry. No rejection escapes its timer callback.
        // The private diagnostic above carries the reason, not a public error.
        throw new Error();
      }
    },
    async beforeHandleMessage({ update, connection }) {
      if (update.byteLength > MAX_UPDATE_BYTES) rejectCollaborationUpdate(connection, 'Diese Änderung überschreitet die Nachrichtengröße von 1 MiB. Lade eine lokale Kopie herunter und öffne die Datei erneut.');
      await accessMonitor.check(connection);
    },
    async beforeSync({ context, connection, document, type, payload }) {
      assertRoomIdentity(document, context.claims);
      if (context.claims.guestInvitationId && context.claims.permission === 'write' && (type === 1 || type === 2)) {
        if (context.claims.representation === 'excalidraw_scene') throw new Error('Guest documents must be Markdown.');
        try { assertFileGuestUpdateAllowed(document, payload, context.claims.representation); }
        catch { rejectCollaborationUpdate(connection, 'Diese Änderung konnte nicht übernommen werden: Die Datei ist zu groß oder enthält nicht unterstützte Dokumentdaten. Lade eine lokale Kopie herunter und öffne die Datei erneut.'); }
      }
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
          user: { name: context.user.name.slice(0, 120), color: colors.color, colorLight: colors.colorLight },
          canvas: {
            userId: context.user.id,
            sessionId: context.claims.sessionId,
            actorType: 'user',
            initiatedByUserId: null,
            displayName: context.user.name.slice(0, 120),
            color: colors.color,
            colorLight: colors.colorLight,
            activity: context.claims.permission === 'write' && requested?.activity === 'editing' ? 'editing' : 'viewing',
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
      const context = connection.context;
      if (
        !acknowledgement || typeof acknowledgement !== 'object'
        || (acknowledgement.type !== 'checkpoint_ack' && acknowledgement.type !== 'durability_ack')
        || acknowledgement.documentId !== documentName
        || acknowledgement.documentId !== context.claims.documentId
        || acknowledgement.lifecycleGeneration !== context.claims.lifecycleGeneration
        || !Number.isSafeInteger(acknowledgement.sequence)
        || Number(acknowledgement.sequence) < 0
        || Number(acknowledgement.sequence) <= (context.observedDocumentSequence ?? -1)
      ) return;
      const state = await loadCollaborationState(documentName);
      if (!state || connection.context !== context || state.status !== 'active'
        || state.documentId !== acknowledgement.documentId
        || state.documentId !== context.claims.documentId
        || state.workspaceId !== context.claims.workspaceId
        || state.organizationId !== context.claims.organizationId
        || state.path !== context.claims.path
        || state.representation !== context.claims.representation
        || state.lifecycleGeneration !== acknowledgement.lifecycleGeneration
        || state.lifecycleGeneration !== context.claims.lifecycleGeneration
        || context.claims.provider !== 'yjs'
        || Number(acknowledgement.sequence) > (acknowledgement.type === 'durability_ack'
          ? state.documentSequence : state.checkpointSequence)) return;
      // Informational only: an acknowledgement never persists an update or grants
      // write access. It scopes late semantic-conflict detection to what this peer saw.
      context.observedDocumentSequence = Math.max(
        context.observedDocumentSequence ?? 0,
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
      context?.stopAccessWatch?.();
      if (context) context.releaseRoomAdmission = null;
      if (!context || document.getConnectionsCount() > 0) return;
      replaceDocumentPresence(context.claims.workspaceId, context.claims.documentId, []);
    },
    async onStoreDocument({ document, documentName, lastContext }) {
      if (!matchesRoomIdentity(document, lastContext.claims)) {
        logCollaborationDiagnostic('info', { event: 'room_generation_rejected', documentId: documentName,
          workspaceId: lastContext.claims.workspaceId, generation: roomIdentities.get(document)?.lifecycleGeneration,
          code: COLLABORATION_FAILURE_CODES.generationChanged });
        hocuspocus.closeConnections(documentName);
        return;
      }
      const startedAt = performance.now();
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
            code: COLLABORATION_FAILURE_CODES.generationChanged,
            message: 'The collaboration document generation changed. Reload to use the current document state.',
          }));
          hocuspocus.closeConnections(documentName);
          return;
        }
        await markCollaborationDegraded(
          documentName,
          lastContext.claims.lifecycleGeneration,
        ).catch(() => undefined);
        logCollaborationDiagnostic('error', { event: 'yjs_persistence_failed', documentId: documentName,
          workspaceId: lastContext.workspace.workspaceId, generation: lastContext.claims.lifecycleGeneration,
          durationMs: Math.round(performance.now() - startedAt), code: COLLABORATION_FAILURE_CODES.persistenceFailed });
        document.broadcastStateless(JSON.stringify({
          type: 'degraded',
          code: COLLABORATION_FAILURE_CODES.persistenceFailed,
          message: error instanceof Error ? error.message : 'Yjs persistence failed.',
        }));
        throw error;
      }
      document.broadcastStateless(JSON.stringify(durabilitySnapshotPayload(state)));
      logCollaborationDiagnostic('debug', { event: 'yjs_persisted', documentId: state.documentId,
        workspaceId: state.workspaceId, generation: state.lifecycleGeneration,
        documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
        durationMs: Math.round(performance.now() - startedAt) });
      projections.enqueue(state);
    },
  });
  collaborationInstance = hocuspocus;
  installCollaborationRoomInspector((documentId) => {
    const room = hocuspocus.documents.get(documentId);
    // A disconnected room may still be storing or unloading. Do not migrate
    // until it is gone, or a new client can receive its previous representation.
    return room ? Math.max(1, room.getConnectionsCount()) : 0;
  });
  installCollaborationDocumentReader(async (documentId, workspaceId, read) => {
    const state = await loadCollaborationState(documentId);
    if (!state || state.status !== 'active' || state.workspaceId !== workspaceId) {
      throw new Error('Collaboration document is unavailable or stale.');
    }
    const activeDocument = hocuspocus.documents.get(documentId);
    if (activeDocument) {
      assertRoomIdentity(activeDocument, state);
      return read(activeDocument);
    }

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
    let workspace = await resolveDirectConnectionWorkspace(input);
    const { state, releaseRoomAdmission } = await withCollaborationRoomLifecycleLock(
      input.documentId,
      async () => {
        const state = await assertDirectConnectionDocument(input, workspace);
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
      await withWorkspaceMutationLock(workspace.workspaceId, async () => {
        // Opening a room and waiting for the workspace fence can both yield.
        // Revalidate inside that fence; a rename/delete/restore must either
        // precede this check or wait until this edit has persisted on disconnect.
        await assertDirectConnectionDocument(input, workspace);
        workspace = await resolveDirectConnectionWorkspace(input);
        context.workspace = workspace;
        await connection.transact((document) => {
          assertRoomIdentity(document, context.claims);
          result = apply(document);
        });
        if (onApplied) await onApplied(result as never);
        await connection.disconnect({ unloadImmediately: true });
      });
    } catch (error) {
      await connection.disconnect({ unloadImmediately: true }).catch(() => undefined);
      throw error;
    }
    return result as never;
  });
  const wss = new WebSocketServer({ noServer: true });
  wss.once('close', () => accessMonitor.dispose());
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
