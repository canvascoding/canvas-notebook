import 'server-only';

import { openDb } from '@/app/lib/db';
import { normalizeWorkspaceRelativePath } from '@/app/lib/workspaces/path-guard';
import { resolveExcalidrawCheckpointWorkspace as resolveCheckpointWorkspace } from '@/app/lib/excalidraw-collaboration/checkpoint-worker';
import { CollaborationCheckpointSupersededError, materializeCollaborationCheckpoint } from '@/app/lib/collaboration/checkpoint';
import { loadCollaborationState } from '@/app/lib/collaboration/persistence';

/** Portable exports must publish durable text, even while the editor is still open. */
export async function ensurePortableTextCheckpointsCurrent(options: {
  workspaceId?: string;
  paths?: readonly string[];
  rootRelativePaths?: readonly string[];
} = {}): Promise<void> {
  const paths = options.paths?.map(normalizeWorkspaceRelativePath);
  let after = '';
  for (;;) {
    const database = await openDb();
    let rows: Array<{ id: string; workspace_id: string; root_relative_path: string }>;
    try {
      rows = await database.all(`SELECT document.id, document.workspace_id, workspace.root_relative_path
        FROM collaboration_documents document
        JOIN collaboration_yjs_states state ON state.document_id = document.id
          AND state.workspace_id = document.workspace_id AND state.path = document.path AND state.status = 'active'
        JOIN canvas_workspaces workspace ON workspace.id = document.workspace_id AND workspace.status = 'active'
        WHERE document.status = 'active' AND document.provider = 'yjs' AND document.id > $1
          AND ($2::text IS NULL OR document.workspace_id = $2)
          AND ($3::text[] IS NULL OR EXISTS (SELECT 1 FROM unnest($3::text[]) scope(path)
            WHERE scope.path = '.' OR document.path = scope.path
              OR left(document.path, char_length(scope.path) + 1) = scope.path || '/'))
        ORDER BY document.id LIMIT 100`, [after, options.workspaceId ?? null, paths ?? null]) as typeof rows;
    } finally { await database.close(); }
    if (!rows.length) return;
    for (const row of rows) {
      if (options.rootRelativePaths && !options.rootRelativePaths.some(root =>
        row.root_relative_path === root || row.root_relative_path.startsWith(root + '/'))) continue;
      try {
        const workspace = await resolveCheckpointWorkspace(row.workspace_id);
        if (!workspace) throw new Error('The exported workspace is no longer active.');
        for (let attempt = 0; attempt < 3; attempt++) {
          const state = await loadCollaborationState(row.id);
          if (!state || state.status !== 'active' || state.workspaceId !== workspace.workspaceId) {
            throw new Error('The exported document changed lifecycle.');
          }
          try {
            await materializeCollaborationCheckpoint({ state, workspace, actorType: 'system' });
            break;
          } catch (error) {
            if (!(error instanceof CollaborationCheckpointSupersededError) || attempt === 2) throw error;
          }
        }
      } catch (cause) {
        throw Object.assign(new Error('A live text document could not be prepared for export. Resolve its synchronization conflict and retry.'), {
          code: 'COLLABORATION_EXPORT_CHECKPOINT_UNAVAILABLE', status: 409, cause,
        });
      }
    }
    after = rows[rows.length - 1].id;
  }
}
