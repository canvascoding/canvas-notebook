import 'server-only';

import { auth } from '@/app/lib/auth';
import type { SqlConnection } from '@/app/lib/db';
import type { CollaborationTicketClaims } from '@/app/lib/collaboration/types';
import { validateExcalidrawAssetMetadata } from '@/app/lib/excalidraw-collaboration/assets';
import type { ExcalidrawAssetMetadata } from '@/app/lib/excalidraw-collaboration/protocol';
import { applyExcalidrawScenePatchInTransaction, loadExcalidrawSceneInTransaction,
  withExcalidrawSceneTransaction, type PersistedExcalidrawScene } from '@/app/lib/excalidraw-collaboration/repository';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { resolveWorkspaceActor } from '@/app/lib/workspaces/context';
import { readPostgresWorkspaceForActorOnConnection } from '@/app/lib/workspaces/postgres-runtime';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type ExcalidrawSocketScope = {
  claims: CollaborationTicketClaims;
  requestHeaders: Headers;
  workspace: WorkspaceContext;
  isOpen: () => boolean;
};

export class ExcalidrawSocketAuthorityError extends Error {
  constructor(readonly closeCode: number, message: string) {
    super(message);
    this.name = 'ExcalidrawSocketAuthorityError';
  }
}

/** All awaited identity and authority checks precede a synchronous delivery or a locked write. */
export async function withExcalidrawSocketAuthority<T>(scope: ExcalidrawSocketScope, permission: 'read' | 'write',
  action: (state: PersistedExcalidrawScene, workspace: WorkspaceContext, transaction: SqlConnection) => Promise<T> | T): Promise<T> {
  if (!scope.isOpen()) throw new ExcalidrawSocketAuthorityError(4401, 'The Excalidraw socket is closed.');
  return withWorkspaceMutationLock(scope.claims.workspaceId, () => withExcalidrawSceneTransaction(scope.claims.documentId,
    async transaction => {
      const state = await loadExcalidrawSceneInTransaction(transaction, scope.claims.documentId, true, true);
      const session = await auth.api.getSession({ headers: scope.requestHeaders, query: { disableCookieCache: true } });
      if (!session || session.user.id !== scope.claims.userId || session.session.id !== scope.claims.sessionId
        || scope.claims.expiresAt <= Date.now()) throw new ExcalidrawSocketAuthorityError(4403,
        'The Excalidraw session is no longer authenticated.');
      const workspace = await readPostgresWorkspaceForActorOnConnection(transaction, resolveWorkspaceActor(session.user), scope.claims.workspaceId);
      if (!workspace || workspace.workspaceId !== scope.claims.workspaceId || workspace.rootPath !== scope.workspace.rootPath
        || (workspace.organizationId ?? null) !== scope.claims.organizationId || workspace.legacy
        || workspace.status !== undefined && workspace.status !== 'active' || !workspace.permissions.canRead
        || permission === 'write' && (scope.claims.permission !== 'write' || !workspace.permissions.canWrite)) {
        throw new ExcalidrawSocketAuthorityError(4403, 'Current Excalidraw workspace access was revoked.');
      }
      const identity = await transaction.get(`SELECT document.id FROM collaboration_documents document
        JOIN file_collaboration_lineages lineage ON lineage.id=document.lineage_id AND lineage.status='active'
        WHERE document.id=$1 AND document.workspace_id=$2 AND document.path=$3
          AND document.status='active' AND document.provider='excalidraw'
          AND document.organization_id IS NOT DISTINCT FROM $4 FOR SHARE OF document,lineage`,
      [scope.claims.documentId,scope.claims.workspaceId,scope.claims.path,scope.claims.organizationId]);
      if (!identity || !state || state.status !== 'active' || state.documentId !== scope.claims.documentId
        || state.workspaceId !== workspace.workspaceId || state.organizationId !== scope.claims.organizationId
        || state.path !== scope.claims.path || state.lifecycleGeneration !== scope.claims.lifecycleGeneration) {
        throw new ExcalidrawSocketAuthorityError(4409, 'The Excalidraw document path or lifecycle changed.');
      }
      if (!scope.isOpen()) throw new ExcalidrawSocketAuthorityError(4401, 'The Excalidraw socket is closed.');
      return action(state, workspace, transaction);
    }));
}

export async function applyExcalidrawSocketPatch(scope: ExcalidrawSocketScope, input: {
  baseSequence: number; messageId: string; elements: unknown; appState?: unknown; assets?: ExcalidrawAssetMetadata[];
}) {
  const assets = input.assets === undefined ? undefined
    : await validateExcalidrawAssetMetadata(scope.claims.workspaceId, input.assets);
  return withExcalidrawSocketAuthority(scope, 'write', async (state, workspace, transaction) => {
    if (!scope.isOpen()) throw new ExcalidrawSocketAuthorityError(4401, 'The Excalidraw socket is closed.');
    const result = await applyExcalidrawScenePatchInTransaction(transaction, { documentId: state.documentId,
      lifecycleGeneration: scope.claims.lifecycleGeneration, baseSequence: input.baseSequence,
      messageId: input.messageId, elements: input.elements, appState: input.appState, assets,
      actorType: 'user', actorId: scope.claims.userId });
    return { ...result, workspace };
  });
}

/** Queue before revalidation so slow authority checks cannot reorder later deliveries. */
export function createExcalidrawAuthorizedDelivery(scope: ExcalidrawSocketScope,
  reject: (error: unknown) => void) {
  let tail: Promise<void> = Promise.resolve();
  return (deliver: (state: PersistedExcalidrawScene, workspace: WorkspaceContext) => void): Promise<void> => {
    const next = tail.then(() => withExcalidrawSocketAuthority(scope, 'read', (state, workspace) => deliver(state, workspace)))
      .catch(reject);
    tail = next;
    return next;
  };
}
