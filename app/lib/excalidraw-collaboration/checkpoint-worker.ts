import 'server-only';

import { openDb } from '@/app/lib/db';
import { workspaceAbsoluteRoot } from '@/app/lib/workspaces/contracts';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { materializeExcalidrawCheckpoint } from './checkpoint';
import { loadExcalidrawScene } from './repository';

/** Internal system work resolves existing storage only; it never creates accounts or workspaces. */
export async function resolveExcalidrawCheckpointWorkspace(workspaceId: string): Promise<WorkspaceContext | null> {
  const database = await openDb();
  try {
    const row = await database.get(`SELECT id, type, root_relative_path, organization_id,
      owner_user_id, customer_id, project_id FROM canvas_workspaces WHERE id = $1 AND status = 'active'`,
    [workspaceId]) as { id: string; type: WorkspaceContext['workspaceType']; root_relative_path: string;
      organization_id: string | null; owner_user_id: string | null; customer_id: string | null; project_id: string | null } | undefined;
    if (!row || !['personal', 'organization', 'team', 'project'].includes(row.type)) return null;
    return {
      workspaceId: row.id, workspaceType: row.type, rootPath: workspaceAbsoluteRoot(row.root_relative_path),
      rootRelativePath: row.root_relative_path, organizationId: row.organization_id, ownerUserId: row.owner_user_id,
      customerId: row.customer_id, projectId: row.project_id, status: 'active', legacy: false,
      permissions: { canRead: true, canWrite: true, canDelete: false, canCreatePublicLinks: false,
        canManageWorkspace: false, canRunAgent: false },
    };
  } finally { await database.close(); }
}

export async function flushPendingExcalidrawCheckpoints(options: {
  workspaceId?: string;
  paths?: readonly string[];
  limit?: number;
  afterDocumentId?: string;
  throwOnFailure?: boolean;
  forceValidation?: boolean;
} = {}): Promise<{ attempted: number; completed: number; failedDocumentIds: string[]; lastDocumentId: string | null }> {
  const limit = options.limit ?? 1_000;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) throw new Error('Invalid Excalidraw checkpoint batch limit.');
  const paths = options.paths?.map(normalizeWorkspaceRelativePath);
  if (paths && !paths.length) return { attempted: 0, completed: 0, failedDocumentIds: [], lastDocumentId: null };
  const database = await openDb();
  let rows: Array<{ document_id: string; workspace_id: string }>;
  try {
    rows = await database.all(`SELECT state.document_id, state.workspace_id FROM collaboration_excalidraw_states state
      JOIN collaboration_documents document ON document.id = state.document_id AND document.workspace_id = state.workspace_id
        AND document.path = state.path AND document.status = 'active' AND document.provider = 'excalidraw'
      JOIN canvas_workspaces workspace ON workspace.id = state.workspace_id AND workspace.status = 'active'
      WHERE state.status = 'active' AND ($5::boolean OR state.scene_sequence > state.checkpoint_sequence OR state.checkpoint_revision_id IS NULL)
        AND ($1::text IS NULL OR state.workspace_id = $1) AND state.document_id > $2
        AND ($3::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($3::text[]) scope(path)
          WHERE scope.path = '.' OR state.path = scope.path OR left(state.path, char_length(scope.path) + 1) = scope.path || '/'))
      ORDER BY state.document_id LIMIT $4`, [options.workspaceId ?? null, options.afterDocumentId ?? '', paths ?? null, limit,
      options.forceValidation ?? false]) as typeof rows;
  } finally { await database.close(); }
  const failedDocumentIds: string[] = [];
  const failures: unknown[] = [];
  let completed = 0;
  for (const row of rows) {
    try {
      const [workspace, state] = await Promise.all([
        resolveExcalidrawCheckpointWorkspace(row.workspace_id), loadExcalidrawScene(row.document_id),
      ]);
      if (!workspace || !state) continue; // A lifecycle mutation removed it after the scan.
      await materializeExcalidrawCheckpoint({ state, workspace, actorType: 'system' });
      completed += 1;
    } catch (error) {
      failedDocumentIds.push(row.document_id);
      failures.push(error);
    }
  }
  if (failures.length && options.throwOnFailure !== false) throw new AggregateError(failures,
    'Some Excalidraw portable checkpoints could not be refreshed.');
  return { attempted: rows.length, completed, failedDocumentIds, lastDocumentId: rows.at(-1)?.document_id ?? null };
}

/** Portable consumers validate every scene in scope, including saved checkpoints. */
export async function ensureExcalidrawCheckpointsCurrent(options: {
  workspaceId?: string; paths?: readonly string[];
} = {}): Promise<void> {
  let afterDocumentId: string | undefined;
  for (;;) {
    const result = await flushPendingExcalidrawCheckpoints({ ...options, afterDocumentId,
      forceValidation: true, throwOnFailure: true, limit: 100 }).catch((error: unknown) => {
      const failures: unknown[] = error instanceof AggregateError ? error.errors : [error];
      const conflict = failures.every(failure => failure && typeof failure === 'object'
        && 'status' in failure && failure.status === 409);
      throw Object.assign(new Error('An Excalidraw checkpoint could not be validated. Resolve its conflict or retry the checkpoint before downloading or exporting.'), {
        code: 'EXCALIDRAW_CHECKPOINT_NOT_CURRENT', status: conflict ? 409 : 503, cause: error,
      });
    });
    if (!result.lastDocumentId) return;
    if (afterDocumentId && result.lastDocumentId <= afterDocumentId) throw new Error('Excalidraw checkpoint pagination did not advance.');
    afterDocumentId = result.lastDocumentId;
  }
}

/** One bounded recovery worker belongs to the existing application server. */
export function startExcalidrawCheckpointWorker(options: {
  onError?: (error: unknown) => void;
  intervalMs?: number;
} = {}): { recover: () => Promise<void>; stop: () => Promise<void> } {
  let stopped = false;
  let pending: Promise<void> | null = null;
  let cursor: string | undefined;
  const recover = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      const { recoverPendingExcalidrawCreates } = await import('./scene-service');
      await recoverPendingExcalidrawCreates();
      let result = await flushPendingExcalidrawCheckpoints({ limit: 50, afterDocumentId: cursor, throwOnFailure: false });
      if (result.attempted === 0 && cursor) {
        cursor = undefined;
        result = await flushPendingExcalidrawCheckpoints({ limit: 50, throwOnFailure: false });
      }
      cursor = result.lastDocumentId ?? undefined;
      if (result.failedDocumentIds.length) options.onError?.(new Error(
        `${result.failedDocumentIds.length} Excalidraw checkpoints remain pending.`));
    })().finally(() => { pending = null; });
    return pending;
  };
  const tick = () => { void recover().catch(error => options.onError?.(error)); };
  const timer = setInterval(tick, options.intervalMs ?? 15_000);
  timer.unref?.();
  tick();
  return { recover, stop: async () => { stopped = true; clearInterval(timer); await pending?.catch(() => undefined); } };
}
