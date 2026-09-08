import 'server-only';

import { withFileCollaborationTransaction } from '@/app/lib/files/collaboration-repository';
import { withWorkspaceMutationLock } from '@/app/lib/files/workspace-mutation-lock';
import { resolveWorkspacePath } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import { listOfficeVersions, OfficeJournalError, readOfficeVersion } from './document-journal';

export type OfficeHistoryLineage = { id: string; status: 'active' | 'archived'; createdAt: number };
type LineageRow = { id: string; status: 'active' | 'archived'; created_at: number };

/** History does not depend on the current file being readable, present or valid. */
export async function readOfficePathHistory(workspace: WorkspaceContext, filePath: string, selectedLineageId?: string | null, contentHash?: string | null) {
  const normalizedPath = resolveWorkspacePath(workspace, filePath).relativePath;
  return withWorkspaceMutationLock(workspace.workspaceId, async () => {
    const { rows, selected } = await withFileCollaborationTransaction(async (transaction) => {
      const rows = await transaction.all(
        "SELECT id, status, created_at FROM file_collaboration_lineages WHERE workspace_id = $1 AND path = $2 ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, created_at DESC, id DESC LIMIT 51",
        [workspace.workspaceId, normalizedPath],
      ) as LineageRow[];
      const selected = selectedLineageId ? await transaction.get(
        'SELECT id, status, created_at FROM file_collaboration_lineages WHERE workspace_id = $1 AND path = $2 AND id = $3',
        [workspace.workspaceId, normalizedPath, selectedLineageId],
      ) as LineageRow | undefined : rows[0];
      if (selectedLineageId && !selected) throw new OfficeJournalError('OFFICE_VERSION_NOT_FOUND', 'This document history is not available at the requested workspace path.');
      return { rows, selected };
    });
    if (contentHash) {
      if (!selected) throw new OfficeJournalError('OFFICE_VERSION_NOT_FOUND', 'No saved version is available for this document.');
      const bytes = await readOfficeVersion({ workspaceId: workspace.workspaceId, lineageId: selected.id, contentHash });
      return { lineageId: selected.id, contentHash, content: `base64:${bytes.toString('base64')}` };
    }
    return {
      lineageId: selected?.id ?? null,
      lineages: rows.slice(0, 50).map((row): OfficeHistoryLineage => ({ id: row.id, status: row.status, createdAt: Number(row.created_at) })),
      moreLineages: rows.length > 50,
      versions: selected ? await listOfficeVersions(workspace.workspaceId, selected.id) : [],
    };
  });
}
