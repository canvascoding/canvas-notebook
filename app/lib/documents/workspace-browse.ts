import 'server-only';

import path from 'node:path';
import { formatWorkspaceTreePage } from '@/app/lib/files/workspace-tree';
import { readWorkspaceDocumentTree, readWorkspaceDocumentTreePage } from '@/app/lib/files/workspace-document-tree';
import { readDirectMcpFileLinks } from '@/app/lib/mcp/server/file-links';
import { readManifestFile, ManifestReadError, MANIFEST_MAX_FILE_BYTES } from '@/app/lib/mcp/server/file-manifest';
import { readCurrentCollaborationTextSnapshot } from '@/app/lib/collaboration/agent-file-edits';
import type { WorkspaceContext } from '@/app/lib/workspaces/types';

export type WorkspaceBrowseSelection = Readonly<{ path: string; maxDepth: number; maxEntries: number; cursor: string | null }>;

/** Shared data readers only. Callers retain their actual authentication,
 * permission/transaction lifetime, tool policy, audit and public error mapping. */
export async function readWorkspaceOverviewContents(workspace: WorkspaceContext) {
  const topLevel = (await readWorkspaceDocumentTree(workspace, '.', 0, { includeMetadata: false }))
    .filter(node => node.path.split('/').every(segment => segment !== '.' && !segment.startsWith('.')));
  const files = topLevel.filter(entry => entry.type === 'file');
  return { count: topLevel.length, contents: { top_level_files: files.length,
    top_level_folders: topLevel.filter(entry => entry.type === 'directory').length,
    file_types: [...new Set(files.map(entry => path.extname(entry.name).replace(/^\./u, '').toLowerCase()).filter(Boolean))].sort().slice(0, 20) } };
}

export async function readWorkspaceTreeWithLinks(workspace: WorkspaceContext, selection: WorkspaceBrowseSelection) {
  const tree = await readWorkspaceDocumentTreePage(workspace, selection, { includeMetadata: false });
  const links = await readDirectMcpFileLinks(workspace.workspaceId, tree.entries.filter(entry => entry.type === 'file').map(entry => entry.path));
  return { count: tree.entries.length, value: { workspace_id: workspace.workspaceId, ...tree,
    entries: tree.entries.map(entry => ({ ...entry, ...links.get(entry.path) })) },
  text: [formatWorkspaceTreePage(tree), ...[...links].map(([file, link]) => `${JSON.stringify(file)}: ${link.document_url}`)].join('\n') };
}

export async function readWorkspaceManifest(workspace: WorkspaceContext, selection: WorkspaceBrowseSelection) {
  const workspaceId = workspace.workspaceId;
  const tree = await readWorkspaceDocumentTreePage(workspace, selection, { includeMetadata: false });
  const files = tree.entries.filter(entry => entry.type === 'file');
  const links = await readDirectMcpFileLinks(workspaceId, files.map(entry => entry.path));
  const entries: Record<string, unknown>[] = [];
  for (const entry of files) {
    const link = links.get(entry.path)!;
    const row: Record<string, unknown> = { path: entry.path, ...link, hash_basis: 'original_file_bytes' };
    let missingPhysical = false, nativeConfirmed = false;
    try { Object.assign(row, { file_state: 'available' }, await readManifestFile(workspace, entry.path)); }
    catch (error) {
      missingPhysical = Boolean(error && typeof error === 'object' && Object.getOwnPropertyDescriptor(error, 'code')?.value === 'ENOENT');
      Object.assign(row, { file_state: missingPhysical ? 'not_materialized' : 'unavailable', size: entry.size ?? null,
        sha256: null, revision: null, modified_at: null, error: error instanceof ManifestReadError ? error.code : 'MANIFEST_SOURCE_UNAVAILABLE' });
    }
    if (link.document_id && /\.m(?:d|arkdown)$/iu.test(entry.path)) {
      try {
        const snapshot = await readCurrentCollaborationTextSnapshot({ documentId: link.document_id, workspace, path: entry.path });
        row.document = { hash_basis: 'authoritative_markdown_utf8', sha256: snapshot.sha256,
          size: Buffer.byteLength(snapshot.content, 'utf8'), revision: `sha256:${snapshot.sha256}`,
          document_sequence: snapshot.documentSequence, lifecycle_generation: snapshot.lifecycleGeneration };
        nativeConfirmed = true;
      } catch { row.document = { error: 'MANIFEST_NATIVE_SOURCE_UNAVAILABLE' }; }
    }
    // Absence of a cache file is valid only after a genuine current native read.
    // Its document hash never substitutes for an original-file byte hash.
    if (missingPhysical && nativeConfirmed) delete row.error;
    entries.push(row);
  }
  return { count: entries.length, value: { workspace_id: workspaceId, path: tree.path, entries, directories: tree.directories,
    next_cursor: tree.next_cursor, has_more: tree.has_more, truncated_by_depth: tree.truncated_by_depth,
    coverage: { source: 'visible_workspace_namespace', atomic_snapshot: false, max_file_bytes: MANIFEST_MAX_FILE_BYTES,
      complete: !tree.truncated && entries.every(entry => !entry.error && !(entry.document && typeof entry.document === 'object' && 'error' in entry.document)) } }, text: `Manifest page: ${entries.length} files.` };
}
