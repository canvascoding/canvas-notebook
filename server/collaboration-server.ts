import { assertCollaborationAdmissionOpen, tryLockCollaborationAdmissionWorkspace } from '@/app/lib/collaboration/room-admission';
import { readRepresentationDrainRequest, refuseRepresentationAdmissionDrain } from '@/app/lib/collaboration/representation-drain-refusal';
import { installRichMigrationRuntime, noteRichMigrationWorkerSuccess, noteRichMigrationWorkerFailure } from '@/app/lib/collaboration/representation-migration-runtime';
import type http from 'node:http';
import type net from 'node:net';
import { randomUUID } from 'node:crypto';

import { Hocuspocus, MessageType, type Connection, type Document, type onAwarenessUpdatePayload } from '@hocuspocus/server';
import { AuthMessageType } from '@hocuspocus/common';
import * as decoding from 'lib0/decoding';
import { WebSocketServer } from 'ws';
import type { Doc as YDoc } from 'yjs';

import { openDb } from '@/app/lib/db';
import { collaborationUpdateStateProof } from '@/app/lib/collaboration/state-proof';
import { COLLABORATION_FAILURE_CODES, isCollaborationStateQuarantined } from '@/app/lib/collaboration/failure';
import { createCollaborationProjectionRuntime } from '@/app/lib/collaboration/projection-runtime';
import { loadCollaborationProjectionStatus } from '@/app/lib/collaboration/projection-repository';
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
  recoverProposalGraphActions,
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
import { acquireCollaborationRoomMutationLock, withCollaborationRoomMutationLock } from '@/app/lib/collaboration/room-mutation-lock';
import {
  CollaborationRoomOwnerError,
  type CollaborationRoomOwnerFence,
  type CollaborationRoomOwnerScope,
} from '@/app/lib/collaboration/room-owner';
import { createCollaborationRoomOwnerRuntime, type CollaborationRoomOwnerRuntimeOptions } from '@/app/lib/collaboration/room-owner-runtime';
import { createOwnedRoomUnloadCoordinator } from '@/app/lib/collaboration/owned-room-unload';
import type { CollaborationRoomReleaseSnapshot } from '@/app/lib/collaboration/room-owner-release';
import {
  matchesCollaborationAdmissionDrainFence,
  sameCollaborationAdmissionDrainTicket,
  type CollaborationAdmissionDrainTicket,
} from '@/app/lib/collaboration/room-admission-drain';
import { createCollaborationRoomAdmissionWorker } from '@/app/lib/collaboration/room-admission-worker';
import { createCollaborationRoomStartupActivity } from '@/app/lib/collaboration/room-startup-activity';
import { installLocalCollaborationRoomDrainer } from '@/app/lib/collaboration/local-room-drain';
import {
  consumeMobileCollaborationTicket,
  hasMobileCollaborationProtocol,
  MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL,
} from '@/app/lib/mobile/collaboration-ticket';
import { isConfiguredTrustedOrigin } from '@/app/lib/security/trusted-origins';
import { resolveUserProfile } from '@/app/lib/user-profile/service';
import type { ResolvedUserProfile } from '@/app/lib/user-profile/types';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { fileVersionHistoryService } from '@/app/lib/file-version-center/history-service';
import { agentTurnHistoryService } from '@/app/lib/file-version-center/agent-turn-history';

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
    degraded: state.degraded,
    projectionError: state.projectionError,
    projectionFinalized: state.projectionFinalized,
    schemaValidated: state.projectionFinalized === true && state.checkpointSequence === state.documentSequence && !state.degraded,
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
  versionSource: 'automatic_checkpoint' | 'agent_apply' | 'restore';
  versionBaseRevisionId: string | null;
  versionSourceSessionId: string | null;
  agentTurnId?: string;
  exactOperationHistoryOwned: boolean;
  operationHistoryOwnership?: Promise<boolean>;
  initiatedByUserId: string | null;
  operationId: string | null;
  observedDocumentSequence: number | null;
  releaseRoomAdmission: (() => void) | null;
  startupActivity?: ReturnType<typeof createCollaborationRoomStartupActivity>;
  stopAccessWatch?: () => void;
};

/** Only the stored standalone direct-apply path owns exact immutable bytes. */
async function standaloneOperationHistoryOwned(
  input: AgentDirectConnectionInput,
  appliedTargetIds?: string[],
): Promise<boolean> {
  if (!input.actorSessionId || input.agentTurnId || input.mcpAuthority || (input.actorType ?? 'agent') !== 'agent') return false;
  let connection: Awaited<ReturnType<typeof openDb>> | undefined;
  try {
    connection = await openDb();
    await connection.run('BEGIN READ ONLY');
    const row = await connection.get(`SELECT status,
      (applied_at IS NOT NULL AND octet_length(resulting_state_snapshot)>0) AS has_state_snapshot,
      (octet_length(version_content_snapshot)>0) AS has_version_snapshot, result_json
      FROM collaboration_agent_operations
      WHERE operation_id=$1 AND document_id=$2 AND workspace_id=$3
        AND actor_id=$4 AND initiated_by_user_id=$5 AND actor_session_id=$6
        AND document_path=$7 AND document_representation=$8
        AND document_lifecycle_generation=$9 AND schema_version=$10
        AND organization_id IS NOT DISTINCT FROM $11
        AND requested_mode='direct_apply' AND operation_type='apply' AND agent_run_id IS NULL`,
    [input.operationId, input.documentId, input.workspace.workspaceId, input.actorId,
      input.initiatedByUserId, input.actorSessionId, input.documentPath, input.documentRepresentation,
      input.documentLifecycleGeneration, input.documentSchemaVersion, input.workspace.organizationId ?? null]) as {
        status: string; has_state_snapshot: boolean; has_version_snapshot: boolean; result_json: string | null;
      } | undefined;
    if (!appliedTargetIds) return row?.status === 'applying';
    if (!row || !['applied_to_ydoc', 'persisted_yjs', 'checkpointed_file'].includes(row.status)
      || row.has_state_snapshot !== true || row.has_version_snapshot !== true
      || appliedTargetIds.length === 0 || appliedTargetIds.some(id => typeof id !== 'string' || !id)
      || new Set(appliedTargetIds).size !== appliedTargetIds.length) return false;
    const result = JSON.parse(row.result_json ?? '{}') as { appliedTargetIds?: unknown };
    const committedTargetIds = result.appliedTargetIds;
    return Array.isArray(committedTargetIds)
      && committedTargetIds.every(id => typeof id === 'string' && id.length > 0)
      && appliedTargetIds.every(id => committedTargetIds.includes(id));
  } catch {
    // Missing/unknown evidence retains ordinary capture; it never grants history ownership.
    return false;
  } finally {
    if (connection) {
      let discard: Error | undefined;
      try { await connection.run('ROLLBACK'); }
      catch (error) { discard = error instanceof Error ? error : new Error('Standalone history proof rollback failed.'); }
      await connection.close(discard);
    }
  }
}

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

function requestFromIncoming(request: http.IncomingMessage, signal?: AbortSignal): Request {
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) for (const item of value) headers.append(key, item);
    else if (value !== undefined) headers.set(key, value);
  }
  return new Request(`http://${request.headers.host || 'localhost'}${request.url || COLLABORATION_PATH}`, { headers, signal });
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
  if (input.mcpAuthority) {
    const { isDirectMcpEditAuthority } = await import('../app/lib/mcp/server/direct-edit-authority');
    if ((input.actorType ?? 'agent') !== 'agent' || !isDirectMcpEditAuthority(input.mcpAuthority)
      || !input.mcpPolicyFence) {
      throw new AgentDirectConnectionAuthorizationError('MCP editing authority is unavailable.');
    }
    const scope = input.mcpAuthority.scope;
    if (scope.userId !== input.initiatedByUserId
      || scope.actorId !== input.actorId || scope.sessionId !== input.actorSessionId
      || scope.workspaceId !== input.workspace.workspaceId || scope.documentId !== input.documentId
      || scope.path !== input.documentPath || scope.lifecycleGeneration !== input.documentLifecycleGeneration) {
      throw new AgentDirectConnectionAuthorizationError('MCP editing authority does not match this document operation.');
    }
    const workspace = await input.mcpAuthority.verifyCurrent();
    await input.mcpPolicyFence(workspace);
    return workspace;
  }
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

/** Caller retains the workspace kernel fence through local admission or mutation. */
async function assertCurrentCollaborationAdmissionOpen(scope: Pick<CollaborationRoomOwnerScope, 'workspaceId' | 'path' | 'documentId'>): Promise<void> {
  const database = await openDb();
  try {
    await database.run('BEGIN');
    await database.run("SET LOCAL statement_timeout = '5s'");
    await database.run("SET LOCAL lock_timeout = '4s'");
    const query = async (sql: string, values?: unknown[]) => await database.all(sql, values) as Array<Record<string, unknown>>;
    await tryLockCollaborationAdmissionWorkspace(query, scope.workspaceId);
    await assertCollaborationAdmissionOpen(query, scope);
    await database.run('COMMIT');
  } finally { await database.close(new Error('Discarding admission join check session.')); }
}

export function createCollaborationServer(server: http.Server, options: {
  // Deliberately opt-in at construction, not an environment rollout switch.
  // Lifecycle writers and mixed-version servers must be fenced before the
  // application bootstrap may supply this dependency in production.
  roomOwner?: CollaborationRoomOwnerRuntimeOptions & {
    admission?: {
      pendingDrains: (
        fences: readonly CollaborationRoomOwnerFence[],
      ) => Promise<readonly CollaborationAdmissionDrainTicket[]>;
      readDrain: (ticket: CollaborationAdmissionDrainTicket) => Promise<Readonly<{
        ticket: CollaborationAdmissionDrainTicket;
        status: 'draining' | 'released';
        blockActiveClients?: boolean;
      }>>;
      pollMs?: number;
    };
  };
  } = {}): WebSocketServer {
  type RoomIdentity = Pick<CollaborationTicketClaims,
    'documentId' | 'workspaceId' | 'organizationId' | 'path' | 'lifecycleGeneration' | 'representation' | 'schemaVersion'>;
  const roomAdmission = options.roomOwner?.admission;
  let retryOwnedRoomUnload = (_documentId: string) => undefined;
  const configuredActivityIdle = options.roomOwner?.onActivityIdle;
  const roomOwners = options.roomOwner && createCollaborationRoomOwnerRuntime({
    ...options.roomOwner,
    onActivityIdle(documentId) {
      retryOwnedRoomUnload(documentId);
      if (configuredActivityIdle) setImmediate(() => {
        try { configuredActivityIdle(documentId); }
        catch { console.error('[Collaboration] Configured room-idle observer failed.'); }
      });
    },
    onLost(document) {
      const room = document as Document;
      noteRichMigrationWorkerFailure(true);
      // Do not discard unacknowledged data or write it under a fresh token.
      // beforeUnloadDocument quarantines this exact room until recovery.
      for (const connection of room.getConnections()) connection.readOnly = true;
      room.broadcastStateless(JSON.stringify({ type: 'degraded', code: 'COLLABORATION_ROOM_OWNER_LOST',
        message: 'The document connection lost its write authority. Local changes are preserved; reconnect after recovery.' }));
      for (const connection of room.getConnections()) {
        connection.close({ code: 1013, reason: 'Collaboration room ownership lost' });
      }
    },
  });
  server.once('close', () => { void roomOwners?.dispose().catch(() => undefined); });
  const withRoomActivity = async <T>(documentId: string, operation: () => Promise<T>): Promise<T> => {
    const activity = roomOwners?.admitActivity(documentId);
    try { return await operation(); }
    finally { activity?.release(); }
  };
  const pendingStartups = new WeakMap<Request, Map<string, Set<ReturnType<typeof createCollaborationRoomStartupActivity>>>>();
  const startupPhases = new WeakMap<ReturnType<typeof createCollaborationRoomStartupActivity>, 'auth' | 'authenticated' | 'loading' | 'loaded'>();
  const admittedDirectCreates = new WeakSet<CollaborationContext>();
  const lastRoomContexts = new WeakMap<Document, { context: CollaborationContext; origin: unknown }>();
  // Hocuspocus caches by document ID, while restore/migration reuse that ID
  // with a new generation. The room keeps the identity of the bytes it loaded.
  const roomIdentities = new WeakMap<YDoc, RoomIdentity>();
  // Hocuspocus serializes each socket, not all sockets of a room. For mutating
  // sync frames hold the lease beyond beforeSync, through MessageReceiver.apply.
  const messageMutationLeases = new WeakMap<Connection<CollaborationContext>, () => void>();
  const matchesRoomIdentity = (document: YDoc, expected: RoomIdentity) => {
    const identity = roomIdentities.get(document);
    return identity?.documentId === expected.documentId && identity.workspaceId === expected.workspaceId
      && (!roomOwners || (identity.organizationId === expected.organizationId && identity.path === expected.path))
      && identity.lifecycleGeneration === expected.lifecycleGeneration
      && identity.representation === expected.representation && identity.schemaVersion === expected.schemaVersion;
  };
  const assertRoomIdentity = (document: YDoc, expected: RoomIdentity) => {
    roomOwners?.fence(document);
    if (!matchesRoomIdentity(document, expected)) {
      hocuspocus.closeConnections(expected.documentId);
      throw new AgentDirectConnectionAuthorizationError('The live collaboration room belongs to an earlier document generation. Reload the document.');
    }
  };
  const reconciliationJobs = new WeakMap<Document, { context: CollaborationContext; requested: boolean }>();
  const queuePersistedRoomReconciliation = (document: Document, context: CollaborationContext) => {
    const existing = reconciliationJobs.get(document);
    if (existing) {
      existing.context = context;
      existing.requested = true;
      return;
    }
    const job = { context, requested: true };
    reconciliationJobs.set(document, job);
    // Never await this from onStoreDocument: direct disconnect owns the room
    // lease and awaits saveMutex. Reconcile only after that lease is released.
    setImmediate(() => {
      void (async () => {
        try {
          while (job.requested) {
            job.requested = false;
            await withRoomActivity(document.name, () => withCollaborationRoomMutationLock(document, async () => {
              const claims = job.context.claims;
              if (document.isDestroyed || hocuspocus.documents.get(claims.documentId) !== document) return;
              const latest = await loadCollaborationState(claims.documentId);
              if (document.isDestroyed || hocuspocus.documents.get(claims.documentId) !== document) return;
              if (!latest || latest.status !== 'active' || !matchesRoomIdentity(document, latest)
                || latest.path !== claims.path || latest.organizationId !== claims.organizationId) {
                throw new CollaborationStateStaleError(claims.documentId, claims.lifecycleGeneration);
              }
              roomOwners?.fence(document);
              // This only adds already durable state. Local, not-yet-stored
              // edits stay intact; their own store remains scheduled. The
              // reconciliation itself must not mint another revision/store.
              Y.applyUpdate(document, latest.yjsState, { source: 'local', skipStoreHooks: true });
              document.broadcastStateless(JSON.stringify(durabilitySnapshotPayload(latest)));
            }));
          }
        } catch (error) {
          if (roomOwners?.isDraining(document.name)) return;
          if (!document.isDestroyed && hocuspocus.documents.get(document.name) === document) {
            const code = error instanceof CollaborationStateStaleError
              ? COLLABORATION_FAILURE_CODES.generationChanged : COLLABORATION_FAILURE_CODES.persistenceFailed;
            logCollaborationDiagnostic('error', { event: 'yjs_persistence_failed', documentId: document.name,
              workspaceId: job.context.claims.workspaceId, code });
            document.broadcastStateless(JSON.stringify({ type: 'degraded', code,
              message: 'The saved document could not be synchronized. Reload to use the current document state.' }));
            hocuspocus.closeConnections(document.name);
          }
        } finally {
          reconciliationJobs.delete(document);
        }
      })();
    });
  };
  const projections = createCollaborationProjectionRuntime({
    onProjected(result) {
      const room = hocuspocus.documents.get(result.state.documentId);
      if (!room || !matchesRoomIdentity(room, result.state)) return;
      if (roomOwners) { try { roomOwners.fence(room); } catch { return; } }
      room.broadcastStateless(JSON.stringify({
        ...durabilitySnapshotPayload(result.state),
        // Older clients must not infer that a newer binary state was exported.
        type: result.state.checkpointSequence >= result.state.documentSequence ? 'checkpointed' : 'durability_snapshot',
        sequence: result.state.checkpointSequence,
        revisionId: result.revisionId,
      }));
    },
    onFailure({ state, code, blocksEditing, phase }) {
      const room = hocuspocus.documents.get(state.documentId);
      if (!room || !matchesRoomIdentity(room, state)) return;
      if (roomOwners) { try { roomOwners.fence(room); } catch { return; } }
      if (blocksEditing) for (const connection of room.getConnections()) connection.readOnly = true;
      room.broadcastStateless(JSON.stringify({
        ...durabilitySnapshotPayload({ ...state, degraded: state.degraded || blocksEditing, projectionFinalized: false,
          projectionError: { code, sequence: state.documentSequence, permanent: blocksEditing, phase } }),
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
      if (isCollaborationStateQuarantined(access.state)) connection.readOnly = true;
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
    async onAuthenticate({ token, documentName, request, requestHeaders, connectionConfig }) {
      if (!liveCollaborationRuntimeAvailable()) throw new Error('Collaboration requires Postgres.');
      const protocols = requestHeaders.get('sec-websocket-protocol')
        ?.split(',')
        .map((value) => value.trim()) ?? [];
      const mobileIdentity = protocols.includes(MOBILE_COLLABORATION_WEBSOCKET_PROTOCOL)
        ? consumeMobileCollaborationTicket(token)
        : null;
      const claims = mobileIdentity?.claims ?? verifyCollaborationTicket(token);
      if (claims.documentId !== documentName) throw new Error('Collaboration document scope mismatch.');
      request.signal.throwIfAborted();
      let releaseRoomAdmission: (() => void) | null = null;
      const releaseAdmission = () => { releaseRoomAdmission?.(); };
      const activity = roomOwners?.admitActivity(documentName);
      const startupActivity = activity && createCollaborationRoomStartupActivity({
        activity,
        onFinished() {
          request.signal.removeEventListener('abort', cancelStartup);
          releaseRoomAdmission?.();
          const documents = pendingStartups.get(request);
          const startups = documents?.get(documentName);
          if (startupActivity) startups?.delete(startupActivity);
          if (!startups?.size) documents?.delete(documentName);
        },
      });
      const cancelStartup = () => { startupActivity?.cancel(); };
      if (startupActivity) {
        const documents = pendingStartups.get(request) ?? new Map();
        const startups = documents.get(documentName) ?? new Set();
        startups.add(startupActivity);
        documents.set(documentName, startups);
        pendingStartups.set(request, documents);
        startupPhases.set(startupActivity, 'auth');
        request.signal.addEventListener('abort', cancelStartup, { once: true });
      }
      const authenticate = async (): Promise<CollaborationContext> => {
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
        releaseRoomAdmission = await withWorkspaceMutationLock(
          claims.workspaceId,
          async () => {
            const state = await assertCollaborationDocumentAccess(claims, workspace);
            await assertCurrentCollaborationAdmissionOpen(claims);
            if (isCollaborationStateQuarantined(state)) connectionConfig.readOnly = true;
            const room = hocuspocus.documents.get(claims.documentId);
            if (room) assertRoomIdentity(room, claims);
            return reserveCollaborationRoomAdmission(claims.documentId);
          },
        );
        connectionConfig.readOnly = connectionConfig.readOnly || claims.permission !== 'write';
        const presenceProfile = claims.guestInvitationId ? null : await resolveCollaborationPresenceProfile({
          workspaceId: claims.workspaceId,
          userId: authenticatedUser.id,
          name: authenticatedUser.name,
          email: authenticatedUser.email,
        });
        if (startupActivity) startupPhases.set(startupActivity, 'authenticated');
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
          versionSource: 'automatic_checkpoint',
          versionBaseRevisionId: null,
          versionSourceSessionId: null,
          exactOperationHistoryOwned: false,
          initiatedByUserId: null,
          operationId: null,
          observedDocumentSequence: null,
          releaseRoomAdmission,
          startupActivity,
        };
      };
      try { return startupActivity ? await startupActivity.run(authenticate) : await authenticate(); }
      catch (error) { startupActivity?.finish(); releaseAdmission(); throw error; }
      finally { if (!startupActivity) request.signal.removeEventListener('abort', cancelStartup); }
    },
    async connected({ context, connection }) {
      const connect = async () => {
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
        context.startupActivity?.assertOpen();
        roomOwners?.fence(connection.document);
        const projectionStatus = await loadCollaborationProjectionStatus(state);
        if (isCollaborationStateQuarantined(projectionStatus)) connection.readOnly = true;
        connection.sendStateless(JSON.stringify(durabilitySnapshotPayload({ ...state, ...projectionStatus })));
      };
      try {
        if (context.startupActivity) await context.startupActivity.run(connect);
        else await connect();
      } catch (error) {
        connection.readOnly = true;
        connection.close();
        throw error;
      } finally {
        context.startupActivity?.finish();
        context.releaseRoomAdmission?.();
        context.releaseRoomAdmission = null;
      }
    },
    async onLoadDocument({ documentName, document, context }) {
      try {
        const state = await loadCollaborationState(documentName);
        if (!state) throw new Error('Collaboration document was not initialized.');
        roomIdentities.set(document, { documentId: state.documentId, workspaceId: state.workspaceId,
          organizationId: state.organizationId, path: state.path, lifecycleGeneration: state.lifecycleGeneration,
          representation: state.representation, schemaVersion: state.schemaVersion });
        if (context?.claims) lastRoomContexts.set(document, { context, origin: null });
        if (roomOwners) {
          await roomOwners.claim(document, state);
          // A previous owner's last row-locked store can finish while this
          // claim waits. Never load the pre-claim snapshot into the new room.
          const latest = await loadCollaborationState(documentName);
          if (!latest || latest.status !== 'active' || !matchesRoomIdentity(document, latest)) {
            throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
          }
          roomOwners.fence(document);
          // Apply inside our cleanup boundary: Hocuspocus's returned-update
          // callback otherwise runs after the hook and can throw/leak a claim.
          Y.applyUpdate(document, latest.yjsState);
          return;
        }
        return state.yjsState;
      } catch (error) {
        // A failed load is not in Hocuspocus.documents yet: its normal unload
        // is a no-op, so explicitly destroy even a pre-claim failure's Doc.
        await roomOwners?.release(document).catch(() => undefined);
        document.destroy();
        throw error;
      }
    },
    async beforeUnloadDocument({ documentName, document }) {
      if (roomOwners && !roomOwners.canUnload(document)) throw new Error();
      if (hocuspocus.documents.get(documentName) !== document) {
        logCollaborationDiagnostic('debug', { event: 'room_generation_rejected', documentId: documentName,
          generation: roomIdentities.get(document)?.lifecycleGeneration, code: 'COLLABORATION_ROOM_REPLACED' });
        // Hocuspocus catches a rejected beforeUnloadDocument hook and returns
        // without deleting the map entry. No rejection escapes its timer callback.
        // The private diagnostic above carries the reason, not a public error.
        throw new Error();
      }
    },
    async afterUnloadDocument({ documentName }) {
      // destroy has already released this exact instance. A replacement load
      // waits for that release too; never look up and release the new room.
      await roomOwners?.waitForRelease(documentName);
    },
    async beforeHandleMessage({ update, connection }) {
      if (update.byteLength > MAX_UPDATE_BYTES) rejectCollaborationUpdate(connection, 'Diese Änderung überschreitet die Nachrichtengröße von 1 MiB. Lade eine lokale Kopie herunter und öffne die Datei erneut.');
      await accessMonitor.check(connection);
    },
    async afterHandleMessage({ connection }) {
      const release = messageMutationLeases.get(connection);
      messageMutationLeases.delete(connection);
      release?.();
    },
    async beforeSync({ context, connection, document, type, payload }) {
      // SyncStep1, awareness and stateless traffic must not queue behind a
      // slow store. Only writer SyncStep2 (1) and Update (2) can change data;
      // Hocuspocus only acknowledges (never applies) read-only sync frames.
      const mutating = !connection.readOnly && (type === 1 || type === 2);
      const activity = mutating ? roomOwners?.admitActivity(context.claims.documentId) : undefined;
      let release: (() => void) | null = null;
      try {
        release = mutating ? await acquireCollaborationRoomMutationLock(document) : null;
        activity?.assertOpen();
        assertRoomIdentity(document, context.claims);
        // Access can be revoked while queued behind another connection.
        if (release) await accessMonitor.check(connection);
        activity?.assertOpen();
        roomOwners?.fence(document);
        if (context.claims.guestInvitationId && context.claims.permission === 'write' && release) {
          if (context.claims.representation === 'excalidraw_scene') throw new Error('Guest documents must be Markdown.');
          try { assertFileGuestUpdateAllowed(document, payload, context.claims.representation); }
          catch { rejectCollaborationUpdate(connection, 'Diese Änderung konnte nicht übernommen werden: Die Datei ist zu groß oder enthält nicht unterstützte Dokumentdaten. Lade eine lokale Kopie herunter und öffne die Datei erneut.'); }
        }
        if (release) {
          const releaseMutation = release;
          messageMutationLeases.set(connection, () => {
            releaseMutation();
            activity?.release();
          });
        }
      } catch (error) {
        release?.();
        activity?.release();
        throw error;
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
    async onChange({ documentName, document, context, transactionOrigin }) {
      if (context?.claims) lastRoomContexts.set(document, { context, origin: transactionOrigin });
      if (context.actorType !== 'user') return;
      try {
        await agentTurnHistoryService.boundary({ workspaceId: context.workspace.workspaceId, path: context.claims.path }).catch(error => {
          // The mutable snapshot remains durable for recovery. Hocuspocus does
          // not await this hook, so history failures must not kill the process.
          console.error('[Collaboration] Agent history boundary failed:', error);
        });
        await withRoomActivity(documentName, async () => {
          roomOwners?.fence(document);
          await detectLateAgentSemanticConflicts({
            documentId: documentName,
            doc: document,
            observedDocumentSequence: context.observedDocumentSequence,
            ...(roomOwners ? { assertRoomActive: () => { roomOwners.fence(document); } } : {}),
          });
        });
      } catch (error) {
        // Hocuspocus fires onChange without awaiting its promise. A known
        // owner invalidation must stop this background task, not escape as
        // an unhandled rejection and terminate unrelated document rooms.
        if (roomOwners && error instanceof CollaborationRoomOwnerError) return;
        throw error;
      }
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
      context?.startupActivity?.finish();
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
        if (roomOwners) {
          void roomOwners.dispose().catch(() => undefined);
          throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
        }
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
          lastContext.claims,
          roomOwners?.fence(document),
        );
        const exactOperationHistoryOwned = lastContext.exactOperationHistoryOwned
          || (!state.incomingNeedsReconcile && state.persistenceDisposition !== 'unchanged'
            && await lastContext.operationHistoryOwnership === true);
        if (state.persistenceDisposition !== 'unchanged'
          && !(lastContext.actorType === 'agent' && !state.incomingNeedsReconcile
            && (lastContext.agentTurnId || exactOperationHistoryOwned))) try {
          await fileVersionHistoryService.capturePersistedCollaboration({
            workspace: lastContext.workspace,
            state,
            // A reconciled union is not wholly authored by this last writer.
            // No-op/ancestor saves do not claim history for somebody else's
            // earlier commit. Agent completion owns its strict capture retry.
            source: state.incomingNeedsReconcile ? 'automatic_checkpoint' : lastContext.versionSource,
            actorUserId: state.incomingNeedsReconcile ? null : lastContext.initiatedByUserId ?? lastContext.user.id,
            actorType: state.incomingNeedsReconcile ? 'system' : lastContext.actorType,
            sourceSessionId: state.incomingNeedsReconcile ? null : lastContext.versionSourceSessionId ?? lastContext.claims.sessionId,
            baseRevisionId: state.incomingNeedsReconcile ? null : lastContext.versionBaseRevisionId,
          });
        } catch {
          // FVRC shadow/history failures never invalidate the already durable
          // Yjs state. Agent completion performs its own strict capture fence.
          console.warn('[Collaboration] File version capture failed.', {
            documentId: state.documentId,
            workspaceId: state.workspaceId,
            operationId: lastContext.operationId,
          });
        }
      } catch (error) {
        if (roomOwners) {
          // The owner runtime closes peers and keeps the old room quarantined.
          // Never mark the replacement owner's shared state degraded or send
          // a successful durability acknowledgement for this failed store.
          // Quarantine ordinary SQL/scope failures too: DirectConnection would
          // otherwise unload after Hocuspocus swallows the failed final store.
          logCollaborationDiagnostic('error', { event: 'yjs_persistence_failed', documentId: documentName,
            workspaceId: lastContext.claims.workspaceId, code: error instanceof CollaborationRoomOwnerError
              ? error.code : COLLABORATION_FAILURE_CODES.persistenceFailed });
          void roomOwners.dispose().catch(() => undefined);
          throw error;
        }
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
          COLLABORATION_FAILURE_CODES.persistenceFailed,
        ).catch(() => undefined);
        logCollaborationDiagnostic('error', { event: 'yjs_persistence_failed', documentId: documentName,
          workspaceId: lastContext.workspace.workspaceId, generation: lastContext.claims.lifecycleGeneration,
          durationMs: Math.round(performance.now() - startedAt), code: COLLABORATION_FAILURE_CODES.persistenceFailed });
        document.broadcastStateless(JSON.stringify({
          type: 'degraded',
          code: COLLABORATION_FAILURE_CODES.persistenceFailed,
          message: 'Yjs persistence failed. Local changes are preserved until a confirmed storage retry.',
        }));
        throw error;
      }
      // The DB write may have committed just before loss. It remains durable,
      // but an invalidated room must not broadcast/projection-ack newer state.
      roomOwners?.fence(document);
      if (state.incomingNeedsReconcile) queuePersistedRoomReconciliation(document, lastContext);
      else document.broadcastStateless(JSON.stringify(durabilitySnapshotPayload(state)));
      logCollaborationDiagnostic('debug', { event: 'yjs_persisted', documentId: state.documentId,
        workspaceId: state.workspaceId, generation: state.lifecycleGeneration,
        documentSequence: state.documentSequence, checkpointSequence: state.checkpointSequence,
        durationMs: Math.round(performance.now() - startedAt) });
      // A retry of the same binary state can still have an unfinished projection.
      // The projection runtime deduplicates by persisted sequence.
      if (state.persistenceDisposition !== 'unchanged' || state.checkpointSequence < state.documentSequence) {
        projections.enqueue(state);
      }
    },
  });
  if (roomOwners) {
    const rawUnloadDocument = hocuspocus.unloadDocument.bind(hocuspocus);
    let ownerUnloadClosing = false;
    const retryAttempts = new WeakMap<Document, number>();
    const retryTimers = new WeakMap<Document, NodeJS.Timeout>();
    const activeRetryTimers = new Set<NodeJS.Timeout>();
    const scheduleOwnedRoomUnloadRetry = (document: Document) => {
      if (retryTimers.has(document) || document.isDestroyed || ownerUnloadClosing
        || hocuspocus.documents.get(document.name) !== document) return;
      const attempt = (retryAttempts.get(document) ?? 0) + 1;
      retryAttempts.set(document, attempt);
      if (attempt > 3) return;
      const timer = setTimeout(() => {
        retryTimers.delete(document);
        activeRetryTimers.delete(timer);
        void runOwnedRoomUnload(document, true);
      }, 50 * (2 ** (attempt - 1)));
      retryTimers.set(document, timer);
      activeRetryTimers.add(timer);
      timer.unref();
    };
    const normalUnload = createOwnedRoomUnloadCoordinator<Document, CollaborationRoomReleaseSnapshot>({
      isCurrent: (document) => !document.isDestroyed
        && hocuspocus.documents.get(document.name) === document,
      shouldUnload: (document) => !document.isLoading && hocuspocus.shouldUnloadDocument(document),
      beforeUnload: (document) => hocuspocus.hooks('beforeUnloadDocument', {
        instance: hocuspocus, documentName: document.name, document,
      }),
      beginIdleDrain: (document) => roomOwners.tryBeginIdleTerminalDrain(document),
      withMutationLock: (document, operation) => withCollaborationRoomMutationLock(document, operation),
      async storeAndCapture(document) {
        if (document.isLoading || document.getConnectionsCount() !== 0
          || hocuspocus.documents.get(document.name) !== document) {
          throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
        }
        const last = lastRoomContexts.get(document);
        if (!last) throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
        const payload = {
          instance: hocuspocus, document, documentName: document.name, clientsCount: 0,
          lastContext: last.context, lastTransactionOrigin: last.origin,
        };
        await document.saveMutex.runExclusive(async () => {
          roomOwners.fence(document);
          await hocuspocus.hooks('onStoreDocument', payload);
          await hocuspocus.hooks('afterStoreDocument', payload);
          roomOwners.fence(document);
        });
        return Object.freeze({
          releaseId: randomUUID(),
          yjsState: Y.encodeStateAsUpdate(document),
          stateVector: Y.encodeStateVector(document),
        });
      },
      destroyCurrent(document) {
        if (hocuspocus.documents.get(document.name) !== document) {
          throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
        }
        try { document.destroy(); }
        catch (error) {
          // Y.Doc marks itself destroyed before notifying listeners. A faulty
          // listener must not strand an already proven release indefinitely.
          if (!document.isDestroyed) throw error;
          console.warn('[Collaboration] Owned room destroy listener failed after document destruction.', {
            documentId: document.name,
            code: 'OWNED_ROOM_DESTROY_LISTENER_FAILED',
          });
        }
        // A re-entrant observer may have installed a replacement. Never
        // delete anything but the exact old object whose bytes were proven.
        if (hocuspocus.documents.get(document.name) === document) {
          hocuspocus.documents.delete(document.name);
        }
      },
      afterUnload: (document) => hocuspocus.hooks('afterUnloadDocument', {
        instance: hocuspocus, documentName: document.name,
      }),
      onCancelled(document, error, phase) {
        if (phase !== 'after') return;
        console.warn('[Collaboration] Owned room unloaded, but its after-unload hook failed.', {
          documentId: document.name,
          code: error instanceof CollaborationRoomOwnerError ? error.code : 'OWNED_ROOM_AFTER_UNLOAD_FAILED',
        });
      },
      onFailure(document, error, phase) {
        console.warn('[Collaboration] Durable owned-room unload failed; the live document remains retained.', {
          documentId: document.name,
          phase,
          code: error instanceof CollaborationRoomOwnerError ? error.code : 'OWNED_ROOM_UNLOAD_FAILED',
        });
        // A product persistence failure invalidates the shared owner session.
        // Once exact bytes were captured, retries can only re-read their
        // receipt or finish the already proven local destroy.
        if (phase === 'begin' || phase === 'gated') {
          try { roomOwners.assertAvailable(); }
          catch { return; }
        }
        scheduleOwnedRoomUnloadRetry(document);
      },
    });
    function runOwnedRoomUnload(document: Document, automatic = false): Promise<void> {
      const existing = hocuspocus.unloadingDocuments.get(document.name);
      if (existing) return existing;
      if (!automatic) retryAttempts.delete(document);
      const tracked = normalUnload.unload(document).finally(() => {
        if (hocuspocus.unloadingDocuments.get(document.name) === tracked) {
          hocuspocus.unloadingDocuments.delete(document.name);
        }
        if (!normalUnload.isGated(document)) retryAttempts.delete(document);
      });
      hocuspocus.unloadingDocuments.set(document.name, tracked);
      return tracked;
    }
    hocuspocus.unloadDocument = (document) => runOwnedRoomUnload(document);
    retryOwnedRoomUnload = (documentId) => {
      setImmediate(() => {
        if (ownerUnloadClosing) return;
        const document = hocuspocus.documents.get(documentId);
        if (document) void runOwnedRoomUnload(document, true);
      });
    };
    server.once('close', () => {
      ownerUnloadClosing = true;
      retryOwnedRoomUnload = () => undefined;
      for (const timer of activeRetryTimers) clearTimeout(timer);
      activeRetryTimers.clear();
    });
    const createDocument = hocuspocus.createDocument.bind(hocuspocus);
    hocuspocus.createDocument = async (...args) => {
      const current = hocuspocus.documents.get(args[0]);
      const admitted = Boolean(args[4]?.startupActivity)
        || Boolean(args[4] && admittedDirectCreates.has(args[4]));
      if (current && !admitted
        && (normalUnload.isGated(current) || roomOwners.isDraining(args[0]))) {
        throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
      }
      const startup = args[4]?.startupActivity;
      if (!startup) return createDocument(...args);
      startupPhases.set(startup, 'loading');
      let loaded: Document | undefined;
      try {
        const document = await startup.run(async () => { loaded = await createDocument(...args); return loaded; });
        startupPhases.set(startup, 'loaded');
        return document;
      } catch (error) {
        // No disconnect hook exists when setup fails before Connection exists.
        // A shared load is awaited above before releasing its startup activity.
        try { if (loaded) await hocuspocus.unloadDocument(loaded); }
        finally { startup.finish(); }
        throw error;
      }
    };
    const drainOwnedRoom = async (scope: CollaborationRoomOwnerScope,
      ticket?: CollaborationAdmissionDrainTicket, status?: 'draining' | 'released') => {
      let terminal = ticket && roomOwners.resumeTerminalDrain(ticket);
      if (status === 'released' && terminal && !terminal.released) {
        throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
      }
      if (!terminal) {
        // A repeated positive notification after the old object finished is a
        // no-op. Never interpret the current replacement room as that ticket.
        if (status === 'released') return;
        terminal = await withCollaborationRoomLifecycleLock(scope.documentId, async () => {
          const document = hocuspocus.documents.get(scope.documentId);
          // Empty/loading rooms remain reserved and will be retried by durable
          // polling. Local absence is not a cross-process vacancy proof.
          if (!document || document.isLoading || hocuspocus.unloadingDocuments.has(scope.documentId)) {
            throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
          }
          assertRoomIdentity(document, scope);
          const drain = roomOwners.beginTerminalDrain(document, ticket);
          for (const connection of document.getConnections()) connection.readOnly = true;
          for (const connection of document.getConnections()) {
            connection.close({ code: 1013, reason: 'Collaboration document transition' });
          }
          return { document, drain, released: false };
        });
      }
      if (!terminal) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
      const document = terminal.document as Document;
      const { drain } = terminal;
      // In particular, do not retain workspace/lifecycle/room/save locks while
      // an already-admitted Direct operation is finishing its final store.
      if (status !== 'released') {
        await drain.idle;
        await withCollaborationRoomMutationLock(document, async () => {
          if (hocuspocus.documents.get(scope.documentId) !== document || document.isDestroyed) {
            throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
          }
          assertRoomIdentity(document, scope);
          const last = lastRoomContexts.get(document);
          if (!last || document.getConnectionsCount() !== 0) throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
          await hocuspocus.storeDocumentHooks(document, {
            instance: hocuspocus, document, documentName: scope.documentId, clientsCount: 0,
            lastContext: last.context, lastTransactionOrigin: last.origin,
          }, true);
          // The library swallows store errors. Only SQL receipt validation of
          // these exact frozen bytes can establish a successful durable release.
          await drain.releaseDurably({ releaseId: ticket?.releaseId ?? randomUUID(),
            ...(ticket ? { admission: ticket } : {}),
            yjsState: Y.encodeStateAsUpdate(document), stateVector: Y.encodeStateVector(document) });
        });
      }
      // A previous, rejected normal unload may still occupy Hocuspocus's map.
      await hocuspocus.unloadingDocuments.get(scope.documentId);
      if (!document.isDestroyed && hocuspocus.documents.get(scope.documentId) === document) {
        const unloading = rawUnloadDocument(document);
        const capturedUnload = hocuspocus.unloadingDocuments.get(scope.documentId);
        try { await unloading; }
        catch (error) {
          // Hocuspocus removes the exact map entry before destroy and does not
          // clear unloadingDocuments when a destroy listener/after hook throws.
          // Once destruction is irreversible, finish this proven old handle;
          // never reinterpret a pre-destroy hook failure as successful unload.
          if (!document.isDestroyed || hocuspocus.documents.get(scope.documentId) === document) throw error;
          if (capturedUnload && hocuspocus.unloadingDocuments.get(scope.documentId) === capturedUnload) {
            hocuspocus.unloadingDocuments.delete(scope.documentId);
          }
          console.warn('[Collaboration] Ticket-bound room destroyed with a local unload cleanup failure.', {
            documentId: scope.documentId,
            code: 'OWNED_ROOM_AFTER_DESTROY_CLEANUP_FAILED',
          });
        }
      }
      if (!document.isDestroyed || hocuspocus.documents.get(scope.documentId) === document) {
        throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
      }
      drain.finish();
    };
    const ticketDrains = new Map<string, {
      ticket: CollaborationAdmissionDrainTicket;
      promise: Promise<void>;
    }>();
    const drainTicket = (ticket: CollaborationAdmissionDrainTicket): Promise<void> => {
      if (!roomAdmission) return Promise.reject(new CollaborationRoomOwnerError('ROOM_OWNER_UNAVAILABLE'));
      const existing = ticketDrains.get(ticket.releaseId);
      if (existing) {
        if (!sameCollaborationAdmissionDrainTicket(existing.ticket, ticket)) {
          return Promise.reject(new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED'));
        }
        return existing.promise;
      }
      const promise = Promise.resolve().then(async () => {
        const verified = await roomAdmission.readDrain(ticket);
        if (!sameCollaborationAdmissionDrainTicket(verified.ticket, ticket)) {
          throw new CollaborationRoomOwnerError('ROOM_OWNER_SCOPE_CHANGED');
        }
        const retained = roomOwners.resumeTerminalDrain(ticket);
        const exactFence = roomOwners.listOwnedFences()
          .some((fence) => matchesCollaborationAdmissionDrainFence(ticket, fence));
        if (!exactFence) {
          // A retained handle whose local release proof never completed may
          // not be upgraded merely from target status. Full receipt/state
          // recovery belongs to the owner release path.
          if (retained) throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
          if (verified.status === 'released') return;
          throw new CollaborationRoomOwnerError('ROOM_OWNER_LOST');
        }
        // Classify the immutable intent centrally, including local acceptance hooks.
        const representationRequest = await readRepresentationDrainRequest(ticket);
        if (representationRequest && !retained) {
          const refused = await withCollaborationRoomLifecycleLock(ticket.fence.scope.documentId, async () => {
            const document = hocuspocus.documents.get(ticket.fence.scope.documentId);
            if (!document?.getConnectionsCount()) return false;
            assertRoomIdentity(document, ticket.fence.scope);
            if (roomOwners.resumeTerminalDrain(ticket)) throw new CollaborationRoomOwnerError('ROOM_OWNER_BUSY');
            await refuseRepresentationAdmissionDrain(representationRequest, ticket);
            return true;
          });
          if (refused) return;
        }
        await drainOwnedRoom(ticket.fence.scope, ticket, verified.status);
      }).finally(() => { ticketDrains.delete(ticket.releaseId); });
      ticketDrains.set(ticket.releaseId, { ticket, promise });
      return promise;
    };
    const uninstallDrainer = installLocalCollaborationRoomDrainer({
      drain: drainTicket,
      drainLegacy: (scope) => drainOwnedRoom(scope),
    });
    const admissionWorker = roomAdmission && createCollaborationRoomAdmissionWorker({
      getOwnedFences: roomOwners.listOwnedFences,
      pendingDrains: roomAdmission.pendingDrains,
      drain: drainTicket,
      ...(roomAdmission.pollMs === undefined ? {} : { pollMs: roomAdmission.pollMs }),
      onPollSuccess: noteRichMigrationWorkerSuccess,
      onError(error) {
        if (error instanceof CollaborationRoomOwnerError && error.code === 'ROOM_OWNER_BUSY') return;
        const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
        noteRichMigrationWorkerFailure(['ROOM_OWNER_LOST', 'ADMISSION_INVALID_REQUEST', 'ADMISSION_REQUEST_CHANGED',
          'ADMISSION_RECOVERY_REQUIRED', '42P01', '42703', '42883', '0A000'].includes(code));
        console.warn('[Collaboration] Durable room drain attempt failed.', error);
      },
    });
    server.once('close', uninstallDrainer);
    server.once('close', () => admissionWorker?.dispose());
    if (admissionWorker) server.once('close', installRichMigrationRuntime(documentId => hocuspocus.documents.get(documentId)?.getConnectionsCount() ?? 0));
  }
  collaborationInstance = hocuspocus;
  installCollaborationRoomInspector((documentId) => {
    const room = hocuspocus.documents.get(documentId);
    // A disconnected room may still be storing or unloading. Do not migrate
    // until it is gone, or a new client can receive its previous representation.
    return room ? Math.max(1, room.getConnectionsCount()) : 0;
  });
  installCollaborationDocumentReader((documentId, workspaceId, read, loadState = loadCollaborationState) => withRoomActivity(documentId, async () => {
    const state = await loadState(documentId);
    if (!state || state.documentId !== documentId || state.status !== 'active' || state.workspaceId !== workspaceId) {
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
  }));
  void recoverCollaborationAgentOperations().then(() => agentTurnHistoryService.recoverExpired()).catch((error) => {
    console.error('[Collaboration] Agent operation recovery failed:', error);
  });
  void recoverProposalGraphActions().catch((error) => {
    console.error('[Collaboration] Proposal action recovery failed:', error);
  });
  setCollaborationRuntimeHealth({ websocketReady: true, persistenceReady: true });
  installCollaborationDirectConnection((input, apply, onApplied) => withRoomActivity(input.documentId, async () => {
    const actorType = input.actorType ?? 'agent';
    let workspace = await resolveDirectConnectionWorkspace(input);
    const { state, releaseRoomAdmission } = await withWorkspaceMutationLock(
      workspace.workspaceId,
      async () => {
        const state = await assertDirectConnectionDocument(input, workspace);
        await assertCurrentCollaborationAdmissionOpen(state);
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
      versionSource: actorType === 'agent' ? 'agent_apply' : input.versionSource ?? 'automatic_checkpoint',
      versionBaseRevisionId: actorType === 'user' ? input.versionBaseRevisionId ?? null : null,
      versionSourceSessionId: actorType === 'user' ? input.versionSourceSessionId ?? null : null,
      agentTurnId: input.agentTurnId,
      exactOperationHistoryOwned: actorType === 'agent' && Boolean(input.mcpAuthority),
      initiatedByUserId: actorType === 'agent' ? input.initiatedByUserId : null,
      operationId: actorType === 'agent' ? input.operationId : null,
      observedDocumentSequence: state.documentSequence,
      releaseRoomAdmission,
    };
    admittedDirectCreates.add(context);
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
    ).finally(() => { admittedDirectCreates.delete(context); });
    let result: unknown;
    let settleHistoryOwnership: ((owned: boolean) => void) | undefined;
    try {
      await withWorkspaceMutationLock(workspace.workspaceId, async () => {
        const document = connection.document;
        if (!document) throw new Error('The direct collaboration connection is closed.');
        await withCollaborationRoomMutationLock(document, async () => {
          // Both fences can yield. Revalidate only after owning the workspace
          // and concrete room; inbound peers must wait through receipt + store.
          await assertDirectConnectionDocument(input, workspace);
          workspace = await resolveDirectConnectionWorkspace(input);
          context.workspace = workspace;
          await assertCurrentCollaborationAdmissionOpen(context.claims);
          if (onApplied && await standaloneOperationHistoryOwned(input)) {
            context.operationHistoryOwnership = new Promise<boolean>(resolve => { settleHistoryOwnership = resolve; });
          }
          await connection.transact((liveDocument) => {
            assertRoomIdentity(liveDocument, context.claims);
            result = apply(liveDocument);
          });
          roomOwners?.fence(document);
          if (onApplied) await onApplied(result as never);
          if (settleHistoryOwnership) {
            const appliedTargetIds = result && typeof result === 'object' && 'appliedTargetIds' in result
              && Array.isArray(result.appliedTargetIds) ? result.appliedTargetIds as string[] : [];
            settleHistoryOwnership(await standaloneOperationHistoryOwned(input, appliedTargetIds));
          }
          roomOwners?.fence(document);
          // Do not acquire this room lease in onStoreDocument: disconnect
          // awaits Hocuspocus's saveMutex, which a scheduled store may own.
          await connection.disconnect({ unloadImmediately: true });
          // Hocuspocus deliberately swallows store failures. A terminal owner
          // loss must still reject this direct call, even after disconnect.
          roomOwners?.assertAvailable();
        });
      });
    } catch (error) {
      settleHistoryOwnership?.(false);
      await connection.disconnect({ unloadImmediately: true }).catch(() => undefined);
      throw error;
    } finally {
      settleHistoryOwnership?.(false);
    }
    return result as never;
  }));
  const wss = new WebSocketServer({ noServer: true });
  const turnRecovery = setInterval(() => {
    void agentTurnHistoryService.recoverExpired().catch(error => console.error('[Collaboration] Agent turn history recovery failed:', error));
  }, 30_000);
  turnRecovery.unref();
  wss.once('close', () => clearInterval(turnRecovery));
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
      const abort = new AbortController();
      const collaborationRequest = requestFromIncoming(request, abort.signal);
      const transport = roomOwners ? {
        get readyState() { return websocket.readyState; },
        close(code?: number, reason?: string) { abort.abort(); websocket.close(code, reason); },
        send(data: Parameters<typeof websocket.send>[0]) {
          try {
            // Hocuspocus has no setup-failure hook. Its denied response is the
            // final boundary even if no Connection/disconnect hook was created.
            if (data instanceof Uint8Array) {
              const decoder = decoding.createDecoder(data);
              const address = decoding.readVarString(decoder).split('\0', 1)[0];
              if (decoding.readVarUint(decoder) === MessageType.Auth
                && decoding.readVarUint(decoder) === AuthMessageType.PermissionDenied) {
                // A closed socket can delete Hocuspocus's hook context after
                // auth but before createDocument. Other phases finish in their
                // own catch/disconnect; never settle a parallel loaded attempt.
                if (collaborationRequest.signal.aborted) {
                  for (const startup of pendingStartups.get(collaborationRequest)?.get(address) ?? []) {
                    if (startupPhases.get(startup) === 'authenticated') startup.finish();
                  }
                }
              }
            }
            websocket.send(data);
          } catch (error) { abort.abort(); throw error; }
        },
      } : websocket;
      const connection = hocuspocus.handleConnection(transport, collaborationRequest);
      websocket.on('message', (data) => {
        const bytes = data instanceof ArrayBuffer
          ? new Uint8Array(data)
          : Array.isArray(data)
            ? new Uint8Array(Buffer.concat(data))
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        connection.handleMessage(bytes);
      });
      websocket.on('close', (code, reason) => {
        abort.abort();
        connection.handleClose({ code, reason: reason.toString() } as CloseEvent);
      });
      websocket.on('error', (error) => {
        abort.abort();
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
