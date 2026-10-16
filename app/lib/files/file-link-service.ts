import 'server-only';
import { openDb } from '@/app/lib/db';
import { withWorkspaceMutationLock } from './workspace-mutation-lock';
import { normalizeWorkspacePathParam } from './path-utils';
import { assertWorkspacePathHasNoAliases } from '@/app/lib/workspaces/path-guard';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';
import type { WorkspaceFileLinkTarget } from './file-link-target';

type TargetRow = { path: string; document_id: string | null; lineage_id: string };
const projection = `SELECT lineage.path, lineage.id AS lineage_id, document.id AS document_id
  FROM file_collaboration_lineages lineage
  LEFT JOIN collaboration_documents document ON document.workspace_id=lineage.workspace_id
    AND document.lineage_id=lineage.id AND document.path=lineage.path AND document.status='active'
  WHERE lineage.workspace_id=$1 AND lineage.status='active'`;

export async function readWorkspaceFileLinkTargets(workspaceId: string, paths: string[]): Promise<Map<string, WorkspaceFileLinkTarget>> {
  const unique = [...new Set(paths)];
  if (!unique.length) return new Map();
  const database = await openDb();
  try {
    const targets = new Map<string, WorkspaceFileLinkTarget>();
    for (let index = 0; index < unique.length; index += 400) {
      const batch = unique.slice(index, index + 400);
      const rows = await database.all(`${projection} AND lineage.path IN (${batch.map((_, i) => `$${i + 2}`).join(',')})`,
        [workspaceId, ...batch]) as TargetRow[];
      for (const row of rows) targets.set(row.path, { workspaceId, path: row.path,
        documentId: row.document_id, lineageId: row.lineage_id });
    }
    return targets;
  } finally { await database.close(); }
}

export async function resolveWorkspaceFileLinkTarget(workspace: WorkspaceContext,
  identity: { documentId?: string | null; lineageId?: string | null }): Promise<WorkspaceFileLinkTarget | null> {
  if (!workspace.permissions.canRead || (!identity.documentId && !identity.lineageId)) return null;
  return withWorkspaceMutationLock(workspace.workspaceId, async () => {
    const database = await openDb();
    try {
      const row = await database.get(`${projection}
        AND ($2::text IS NULL OR document.id=$2) AND ($3::text IS NULL OR lineage.id=$3) LIMIT 1`,
      [workspace.workspaceId, identity.documentId ?? null, identity.lineageId ?? null]) as TargetRow | undefined;
      if (!row || normalizeWorkspacePathParam(row.path) !== row.path) return null;
      await assertWorkspacePathHasNoAliases(workspace, row.path, { readOnly: true });
      return { workspaceId: workspace.workspaceId, path: row.path, documentId: row.document_id, lineageId: row.lineage_id };
    } finally { await database.close(); }
  });
}
