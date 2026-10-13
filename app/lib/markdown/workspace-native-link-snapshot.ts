import 'server-only';

import { openDb, type SqlConnection } from '../db';
import { loadCollaborationStateOnConnection } from '../collaboration/persistence';
import { readWorkspaceDocumentCatalogue } from '../collaboration/workspace-document-catalogue';
import type { WorkspaceFileOperationOptions } from '../filesystem/workspace-files';
import type { WorkspaceContext } from '../workspaces/types';
import { buildWorkspacePlannerSnapshot } from './workspace-file-operation-preview';
import { inspectPersistedDocumentLinks, nativeLinkJsonProof } from './workspace-native-link-inventory';
import type { NativeDocumentLinkInventory, NativeLinkCoverageGap, NativeNamespaceEntry, NativeWorkspaceLinkSnapshot } from './workspace-link-contract-v2';

type Dependencies = {
  buildDiskSnapshot?: typeof buildWorkspacePlannerSnapshot;
  openConnection?: () => Promise<SqlConnection>;
  readCatalogue?: typeof readWorkspaceDocumentCatalogue;
  loadState?: typeof loadCollaborationStateOnConnection;
};

/** Namespace/catalogue union. A missing, empty or broken projection never hides
 * an initialized document or becomes its content source. Uninitialized Markdown
 * requires the explicit import capability before a native operation is ready. */
export async function buildWorkspaceNativeLinkSnapshot(
  workspace: WorkspaceContext,
  options: WorkspaceFileOperationOptions,
  dependencies: Dependencies = {},
): Promise<NativeWorkspaceLinkSnapshot> {
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active'
    || options.workspace?.workspaceId !== workspace.workspaceId) throw new Error('The native workspace snapshot scope is unavailable.');
  const disk = await (dependencies.buildDiskSnapshot ?? buildWorkspacePlannerSnapshot)(workspace.workspaceId, options);
  const namespace = new Map<string, NativeNamespaceEntry>(disk.entries.map((entry) => [entry.path, {
    workspaceId: workspace.workspaceId, path: entry.path, kind: entry.kind, identity: entry.identity,
    filesystemIdentity: entry.identity, documentId: null, lifecycleGeneration: null,
  }]));
  const documents: NativeDocumentLinkInventory[] = [];
  const gaps: NativeLinkCoverageGap[] = [];
  const inspected = new Set<string>();
  let connection: SqlConnection | undefined;
  let transaction = false;
  try {
    connection = await (dependencies.openConnection ?? openDb)();
    await connection.run('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true;
    const catalogue = await (dependencies.readCatalogue ?? readWorkspaceDocumentCatalogue)(connection, workspace);
    for (const registered of catalogue) {
      const prior = namespace.get(registered.path);
      if (prior?.kind === 'directory') { gaps.push({ code: 'identity-conflict', path: registered.path }); continue; }
      const state = await (dependencies.loadState ?? loadCollaborationStateOnConnection)(connection, registered.id, true);
      namespace.set(registered.path, { workspaceId: workspace.workspaceId, path: registered.path, kind: 'file',
        documentId: registered.id, lifecycleGeneration: state?.lifecycleGeneration ?? null,
        identity: `document:${registered.id}:${state?.lifecycleGeneration ?? 'uninitialized'}`,
        filesystemIdentity: prior?.filesystemIdentity ?? null });
      if (!/\.(?:md|markdown)$/iu.test(registered.path)) continue;
      inspected.add(registered.path);
      if (!state) {
        gaps.push({ code: registered.authority === 'pristine' ? 'uninitialized-source' : 'unreadable-source', path: registered.path });
        continue;
      }
      try {
        if (state.documentId !== registered.id || state.workspaceId !== workspace.workspaceId || state.path !== registered.path
          || state.organizationId !== (workspace.organizationId ?? null)) throw new Error('Native source identity differs from its catalogue.');
        const inventory = inspectPersistedDocumentLinks(state);
        documents.push(inventory); gaps.push(...inventory.coverage.gaps);
      } catch { gaps.push({ code: 'unreadable-source', path: registered.path }); }
    }
    await connection.run('COMMIT'); transaction = false;
  } catch {
    gaps.push({ code: 'identity-conflict', path: '' });
  } finally {
    try { if (transaction) await connection?.run('ROLLBACK'); }
    finally { await connection?.close(); }
  }
  for (const entry of disk.entries) if (entry.kind === 'file' && /\.(?:md|markdown)$/iu.test(entry.path) && !inspected.has(entry.path)) {
    gaps.push({ code: entry.omissionReason ? 'unreadable-source' : 'uninitialized-source', path: entry.path });
  }
  const entries = [...namespace.values()].sort((a, b) => a.path.localeCompare(b.path));
  documents.sort((a, b) => a.document.path.localeCompare(b.document.path));
  const body = { contractVersion: 2 as const, workspaceId: workspace.workspaceId, namespace: entries, documents,
    coverage: { complete: gaps.length === 0, gaps } };
  return { ...body, snapshotProof: nativeLinkJsonProof(body) };
}
