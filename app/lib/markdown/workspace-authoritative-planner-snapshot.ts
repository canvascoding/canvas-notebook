import 'server-only';

import { openDb, type SqlConnection } from '@/app/lib/db';
import { authoritativeCollaborationSnapshot } from '@/app/lib/collaboration/checkpoint';
import { loadCollaborationStateOnConnection, serializeCanonicalText } from '@/app/lib/collaboration/persistence';
import type { WorkspaceFileOperationOptions } from '@/app/lib/filesystem/workspace-files';
import { buildWorkspacePlannerSnapshot, WorkspacePreviewUnavailableError } from './workspace-file-operation-preview';
import type { WorkspacePlannerEntry, WorkspacePlannerSnapshot } from './workspace-file-operation-planner';
import { MAX_INDEXED_MARKDOWN_BYTES } from './workspace-link-limits';
import { parseWorkspaceLocalLinks } from './workspace-local-link-parser';

type Dependencies = {
  buildDiskSnapshot?: typeof buildWorkspacePlannerSnapshot;
  openConnection?: () => Promise<SqlConnection>;
};

type ActiveDocument = {
  id: string;
  path: string;
  workspace_id: string;
  organization_id: string | null;
  status: string;
  state_version: number;
  has_persisted_state: boolean;
  has_state_history: boolean;
};

function omit(entry: WorkspacePlannerEntry, reason: 'source-unreadable' | 'source-too-large'): void {
  delete entry.markdownContent;
  delete entry.contentHash;
  entry.omissionReason = reason;
}

/** Overlay durable HTML-link truth; ordinary Markdown keeps the existing move/preflight byte semantics. */
export async function buildWorkspaceAuthoritativePlannerSnapshot(
  workspaceId: string,
  options: WorkspaceFileOperationOptions,
  dependencies: Dependencies = {},
): Promise<WorkspacePlannerSnapshot> {
  const disk = await (dependencies.buildDiskSnapshot ?? buildWorkspacePlannerSnapshot)(workspaceId, options);
  const workspace = options.workspace;
  if (!workspace) return disk;
  if (workspace.workspaceId !== workspaceId || !workspace.permissions.canRead
    || workspace.status !== undefined && workspace.status !== 'active') throw new WorkspacePreviewUnavailableError();
  const entries = disk.entries.map((entry) => ({ ...entry }));
  const markdown = entries.filter((entry) => entry.kind === 'file' && /\.(?:md|markdown)$/iu.test(entry.path));
  if (!markdown.length) return { workspaceId, entries };
  const byPath = new Map(markdown.map((entry) => [entry.path, entry]));
  let connection: SqlConnection | undefined;
  let transaction = false;
  try {
    connection = await (dependencies.openConnection ?? openDb)();
    await connection.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    transaction = true;
    const documents = await connection.all(`SELECT d.id,d.path,d.workspace_id,d.organization_id,d.status,d.state_version,
      EXISTS(SELECT 1 FROM collaboration_yjs_states s WHERE s.document_id=d.id) AS has_persisted_state,
      (EXISTS(SELECT 1 FROM collaboration_yjs_state_backups b WHERE b.document_id=d.id)
        OR EXISTS(SELECT 1 FROM collaboration_agent_operations a WHERE a.document_id=d.id)) AS has_state_history
      FROM collaboration_documents d
      WHERE d.workspace_id=$1 AND d.path=ANY($2::text[]) AND d.provider='yjs' AND d.status='active'`,
    [workspaceId, [...byPath.keys()]]) as ActiveDocument[];
    const seen = new Set<string>();
    for (const document of documents) {
      const entry = byPath.get(document.path);
      if (!entry) throw new WorkspacePreviewUnavailableError();
      if (seen.has(document.path)) { omit(entry, 'source-unreadable'); continue; }
      seen.add(document.path);
      try {
        if (!document.id || document.status !== 'active' || document.workspace_id !== workspaceId
          || document.organization_id !== (workspace.organizationId ?? null)) {
          omit(entry, 'source-unreadable');
          continue;
        }
        const state = await loadCollaborationStateOnConnection(connection, document.id, true);
        if (!state) {
          // A registered upload has disk authority only until its first Yjs state exists.
          if (document.state_version === 0 && !document.has_persisted_state && !document.has_state_history) continue;
          omit(entry, 'source-unreadable');
          continue;
        }
        if (state.documentId !== document.id || state.workspaceId !== workspaceId
          || state.organizationId !== (workspace.organizationId ?? null) || state.path !== document.path
          || state.status !== 'active' || state.degraded || state.projectionError?.permanent) {
          omit(entry, 'source-unreadable');
          continue;
        }
        const content = serializeCanonicalText(authoritativeCollaborationSnapshot(state).canonicalContent, state);
        const bytes = Buffer.from(content, 'utf8');
        if (bytes.byteLength > MAX_INDEXED_MARKDOWN_BYTES) { omit(entry, 'source-too-large'); continue; }
        if (new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== content) { omit(entry, 'source-unreadable'); continue; }
        const hasHtml = (markdownContent: string) => parseWorkspaceLocalLinks(markdownContent, entry.path)
          .unevaluated.some((link) => link.reason === 'html');
        if (!hasHtml(entry.markdownContent ?? '') && !hasHtml(content)) continue;
        entry.markdownContent = content;
        delete entry.contentHash;
        delete entry.omissionReason;
      } catch { omit(entry, 'source-unreadable'); }
    }
    await connection.run('COMMIT');
    transaction = false;
  } catch {
    // An unavailable identity/state catalogue cannot authorize a disk fallback.
    for (const entry of markdown) omit(entry, 'source-unreadable');
  } finally {
    try { if (connection && transaction) await connection.run('ROLLBACK'); }
    finally { await connection?.close(); }
  }
  return { workspaceId, entries };
}
