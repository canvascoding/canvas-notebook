import 'server-only';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { openDb } from '@/app/lib/db';
import { resolveExistingWorkspacePath } from '@/app/lib/filesystem/workspace-files';
import { filesystemFileVersion } from '@/app/lib/filesystem/file-version';
import { authoritativeCollaborationSnapshot } from '@/app/lib/collaboration/checkpoint';
import { loadCollaborationStateIncludingArchived, serializeCanonicalText } from '@/app/lib/collaboration/persistence';
import { WorkspaceOperationBatchError } from './workspace-operation-batch-store';
import type { WorkspaceOperationBatchPlan, WorkspaceOperationBatchScope } from './workspace-operation-batch-contract';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
/** Targeted approval fence only. The executor worker still validates the entire graph before writes. */
export async function assertWorkspaceOperationBatchApprovalCurrent(plan: WorkspaceOperationBatchPlan, scope: WorkspaceOperationBatchScope): Promise<void> {
  const stale = (): never => { throw new WorkspaceOperationBatchError('PREVIEW_STALE', 409,
    'Files changed after the combined preview. Check again before approval.'); };
  if (plan.readiness !== 'ready') stale();
  const documents = new Map(plan.originalDocuments.map((document) => [document.path, document.content]));
  for (const expected of plan.expectedPathState) {
    try {
      const fullPath = await resolveExistingWorkspacePath(expected.path, scope.fileOptions);
      const stat = await fs.stat(fullPath);
      if (expected.identity === null || filesystemFileVersion(stat) !== expected.identity) stale();
      if (expected.contentHash !== null) {
        const content = await fs.readFile(fullPath);
        if (hash(content) !== expected.contentHash) stale();
        if (/\.(?:md|markdown)$/iu.test(expected.path)) documents.set(expected.path, content.toString('utf8'));
      }
    } catch (error) {
      if (expected.identity === null && ['ENOENT','ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) continue;
      if (error instanceof WorkspaceOperationBatchError) throw error;
      stale();
    }
  }
  if (!documents.size) return;
  const db = await openDb();
  let active: Array<{ id: string; path: string; state_version: number;
    has_persisted_state: boolean; has_state_history: boolean }>;
  try {
    active = await db.all(`SELECT d.id,d.path,d.state_version,
      EXISTS(SELECT 1 FROM collaboration_yjs_states s WHERE s.document_id=d.id) AS has_persisted_state,
      (EXISTS(SELECT 1 FROM collaboration_yjs_state_backups b WHERE b.document_id=d.id)
        OR EXISTS(SELECT 1 FROM collaboration_agent_operations a WHERE a.document_id=d.id)) AS has_state_history
      FROM collaboration_documents d
      WHERE d.workspace_id=$1 AND d.path=ANY($2::text[]) AND d.provider='yjs' AND d.status='active'`,
    [scope.workspace.workspaceId, [...documents.keys()]]) as typeof active;
  } finally { await db.close(); }
  for (const document of active) {
    const content = documents.get(document.path)!;
    const persisted = await loadCollaborationStateIncludingArchived(document.id);
    if (!persisted) {
      // Uploads register a version-zero document before its first editor/worker
      // initializes Yjs. These already-fenced disk bytes remain authoritative.
      // A previously persisted/checkpointed/operated document never gets this exception.
      if (Number(document.state_version) === 0 && !document.has_persisted_state && !document.has_state_history) continue;
      stale();
    }
    if (persisted.status !== 'active' || persisted.workspaceId !== scope.workspace.workspaceId
      || persisted.path !== document.path || persisted.degraded
      || hash(serializeCanonicalText(authoritativeCollaborationSnapshot(persisted).canonicalContent, persisted)) !== hash(content)) stale();
  }
}
