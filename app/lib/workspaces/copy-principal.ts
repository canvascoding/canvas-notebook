import 'server-only';

import { isDeepStrictEqual } from 'node:util';
import { NextRequest } from 'next/server';
import type { SqlConnection } from '../db';
import { assertWorkspaceOperationCopyOriginCurrent, captureWorkspaceOperationCopyOrigin, captureWorkspaceOperationCopyMcpOrigin,
  decodeWorkspaceOperationCopyOrigin, WorkspaceOperationCopyOriginError,
  type WorkspaceOperationCopyActor, type WorkspaceOperationCopyOrigin } from '../files/workspace-operation-copy-origin';
import { captureWorkspaceOperationJobScope } from '../files/workspace-operation-job-scope';
import { withWorkspaceRequestPrincipal, withWorkspaceRequestPrincipalOnConnection,
  withWorkspaceAgentToolPrincipal, withWorkspaceAgentToolPrincipalOnConnection,
  WorkspaceRequestPrincipalError } from './request-principal';
import type { WorkspaceContext } from './types';
import { withDirectMcpWorkspaceCopyPrincipalOnConnection,
  type DirectMcpWorkspaceCopyPrincipal } from '../mcp/server/document-read-principal';

/** Data valid inside the actual principal phase only. Neither an authorization
 * handle nor an assertion to retain across filesystem work or COMMIT. */
export type WorkspaceCopyPrincipalAccess = Readonly<{
  sourceWorkspace: WorkspaceContext;
  destinationWorkspace: WorkspaceContext;
  currentActor: WorkspaceOperationCopyActor;
  originalOrigin: WorkspaceOperationCopyOrigin;
}>;

function changed(): never { throw new WorkspaceOperationCopyOriginError('COPY_ORIGIN_CHANGED'); }
function assertSource(origin: WorkspaceOperationCopyOrigin, workspace: WorkspaceContext, actor: WorkspaceOperationCopyActor): void {
  if (!isDeepStrictEqual(captureWorkspaceOperationJobScope(workspace), origin.sourceScope)
    || actor.type !== origin.actor.type || actor.userId !== origin.actor.userId || actor.actorId !== origin.actor.actorId) changed();
}
function access(origin: WorkspaceOperationCopyOrigin, sourceWorkspace: WorkspaceContext,
  destinationWorkspace: WorkspaceContext, currentActor: WorkspaceOperationCopyActor): WorkspaceCopyPrincipalAccess {
  const originalOrigin = assertWorkspaceOperationCopyOriginCurrent(origin,
    captureWorkspaceOperationCopyOrigin({ actor: currentActor, sourceWorkspace, destinationWorkspace }));
  return Object.freeze({ sourceWorkspace, destinationWorkspace, currentActor: Object.freeze(currentActor), originalOrigin });
}

/** Genuine member request composition for one short caller-held RC/RW B.
 * Source READ and destination WRITE are checked on the SAME actual B. Cross-
 * workspace phases run serially: source READ, destination WRITE+operation,
 * source READ. The original phase's SQL ACL/auth locks remain until caller TX
 * end; no inactive assertCurrent closure is reused. Existing principal phases
 * recheck their current authority on exit and enforce their own B/time bounds.
 *
 * Caller MUST roll back on ANY error and owns lifecycle/namespace admission,
 * original journal/hash checks, the awaited domain operation and COMMIT proof.
 * All domain SQL uses B; the normal genuine factories retain their own
 * authentication/policy capture reads. This adapter never controls or closes B.
 * Fresh factories are required again for a later B2 after filesystem work. */
export async function withWorkspaceCopyRequestOnConnection<T>(database: SqlConnection, request: NextRequest,
  original: WorkspaceOperationCopyOrigin, operation: (current: WorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  const origin = decodeWorkspaceOperationCopyOrigin(original);
  if (origin.version !== 1 || origin.actor.type !== 'user') changed();
  if (!(request instanceof NextRequest) || typeof operation !== 'function') throw new WorkspaceRequestPrincipalError('PRINCIPAL_INVALID');
  // Freeze the actual request's authentication/selectors before any await.
  const captured = new NextRequest(request.url, { method: request.method, headers: new Headers(request.headers) });
  const userActor = (userId: string, sessionId: string): WorkspaceOperationCopyActor =>
    Object.freeze({ type: 'user', userId, actorId: userId, sessionId });
  if (origin.sourceScope.workspaceId === origin.destinationScope.workspaceId) {
    return withWorkspaceRequestPrincipal(captured, { permission: 'canWrite', workspaceId: origin.sourceScope.workspaceId },
      principal => withWorkspaceRequestPrincipalOnConnection(database, principal, current =>
        operation(access(origin, current.workspace, current.workspace, userActor(current.userId, current.sessionId)))));
  }
  return withWorkspaceRequestPrincipal(captured, { permission: 'canRead', workspaceId: origin.sourceScope.workspaceId }, sourcePrincipal =>
    withWorkspaceRequestPrincipal(captured, { permission: 'canWrite', workspaceId: origin.destinationScope.workspaceId }, async destinationPrincipal => {
      const source = await withWorkspaceRequestPrincipalOnConnection(database, sourcePrincipal, async current => {
        const actor = userActor(current.userId, current.sessionId);
        assertSource(origin, current.workspace, actor);
        return Object.freeze({ workspace: current.workspace, actor });
      });
      const result = await withWorkspaceRequestPrincipalOnConnection(database, destinationPrincipal, async current => {
        const actor = userActor(current.userId, current.sessionId);
        if (!isDeepStrictEqual(actor, source.actor)) changed();
        return operation(access(origin, source.workspace, current.workspace, actor));
      });
      await withWorkspaceRequestPrincipalOnConnection(database, sourcePrincipal, async current => {
        const actor = userActor(current.userId, current.sessionId);
        if (!isDeepStrictEqual(actor, source.actor)) changed();
        assertSource(origin, current.workspace, actor);
      });
      return result;
    }));
}

/** Genuine current PI tool invocation only. The existing agent principal
 * factory enforces its selected workspace and current grant/profile. No
 * constructed member request, actor DTO or historical session grants access.
 * The same caller transaction/rollback/COMMIT responsibilities apply. */
export async function withWorkspaceCopyAgentOnConnection<T>(database: SqlConnection,
  original: WorkspaceOperationCopyOrigin, operation: (current: WorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  const origin = decodeWorkspaceOperationCopyOrigin(original);
  if (origin.version !== 1 || origin.actor.type !== 'agent') changed();
  if (origin.sourceScope.workspaceId !== origin.destinationScope.workspaceId) throw new WorkspaceRequestPrincipalError('PRINCIPAL_ACCESS_DENIED');
  if (typeof operation !== 'function') throw new WorkspaceRequestPrincipalError('PRINCIPAL_INVALID');
  return withWorkspaceAgentToolPrincipal({ permission: 'canWrite', workspaceId: origin.sourceScope.workspaceId },
    principal => withWorkspaceAgentToolPrincipalOnConnection(database, principal, current =>
      operation(access(origin, current.workspace, current.workspace, { type: 'agent', userId: current.userId,
        actorId: current.agentId, sessionId: current.piSessionId }))));
}

/** A real live MCP Copy handle supplies current authority on caller B. Stored
 * V2 attribution only binds that authority to the original client and scopes;
 * its original SID is preserved even after genuine session renewal. Neither
 * an agent-shaped actor nor the stored origin can replace the opaque handle.
 * Caller owns transaction/rollback, admission and later filesystem phases. */
export async function withWorkspaceCopyMcpOnConnection<T>(database: SqlConnection,
  principal: DirectMcpWorkspaceCopyPrincipal, original: WorkspaceOperationCopyOrigin,
  operation: (current: WorkspaceCopyPrincipalAccess) => Promise<T>): Promise<T> {
  const origin = decodeWorkspaceOperationCopyOrigin(original);
  if (origin.version !== 2) changed();
  if (typeof operation !== 'function') throw new WorkspaceRequestPrincipalError('PRINCIPAL_INVALID');
  return withDirectMcpWorkspaceCopyPrincipalOnConnection(database, principal, async current => {
    const fresh = captureWorkspaceOperationCopyMcpOrigin({ userId: current.userId, clientId: current.clientId,
      sessionId: current.sessionId, sourceWorkspace: current.sourceWorkspace, destinationWorkspace: current.destinationWorkspace });
    const originalOrigin = assertWorkspaceOperationCopyOriginCurrent(origin, fresh);
    return operation(Object.freeze({ sourceWorkspace: current.sourceWorkspace, destinationWorkspace: current.destinationWorkspace,
      currentActor: fresh.actor, originalOrigin }));
  });
}
