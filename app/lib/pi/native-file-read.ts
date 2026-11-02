import 'server-only';

import path from 'node:path';
import { withNativeWorkspaceFilesRead } from '../collaboration/workspace-native-file-read';
import { readCurrentCollaborationTextSnapshot, type CollaborationStructureReadOptions,
  type CollaborationTextSnapshot } from '../collaboration/agent-file-edits';
import { loadCollaborationStateOnConnection } from '../collaboration/persistence';
import { assertWorkspacePathHasNoAliases } from '../workspaces/path-guard';
import { getAgentExecutionContext } from './agent-execution-context';
import { withCurrentAgentWorkspaceRead } from './workspace-read-authority';

type Result = Readonly<{ handled: false; snapshot: null }> | Readonly<{ handled: true; snapshot: CollaborationTextSnapshot | null }>;

/** Existing native authority only. A pristine physical file remains a byte
 * source; a missing/invalid initialized state never grants a disk fallback.
 * No document, revision, state or projection is initialized by this read. */
export async function readExistingAgentNativeFile(fullPath: string,
  options: CollaborationStructureReadOptions = {}): Promise<Result> {
  const context = getAgentExecutionContext();
  if (!context || context.legacy) return { handled: false, snapshot: null };
  const relative = path.relative(context.workspaceRoot, fullPath);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return { handled: false, snapshot: null };
  }
  const selected = relative.split(path.sep).join('/');
  return withCurrentAgentWorkspaceRead(async workspace => {
    if (!selected) return { handled: true, snapshot: null };
    await assertWorkspacePathHasNoAliases(workspace, selected, { readOnly: true });
    const snapshot = await withNativeWorkspaceFilesRead({ workspace, paths: [selected], maxEntries: 1 }, async (scope, connection) => {
      const document = scope.documents.find(value => value.path === selected);
      if (!document || document.authority === 'pristine') return null;
      if (document.authority !== 'initialized' || document.lifecycle_generation === null) {
        throw Object.assign(new Error('The initialized native document state is unavailable; no file fallback is allowed.'),
          { status: 409, code: 'COLLABORATION_STATE_UNAVAILABLE' });
      }
      return readCurrentCollaborationTextSnapshot({ documentId: document.id, workspace, path: selected,
        lifecycleGeneration: document.lifecycle_generation, ...options,
        loadState: async documentId => {
          if (documentId !== document.id) throw new Error('The native read identity changed.');
          return loadCollaborationStateOnConnection(connection, documentId);
        } });
    });
    return { handled: true, snapshot };
  });
}
