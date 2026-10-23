import 'server-only';

import { isCanonicalAdmissionPath } from '../collaboration/room-admission-contract';
import { withNativeWorkspaceFilesRead } from '../collaboration/workspace-native-file-read';
import type { WorkspaceContext } from '../workspaces/types';
import type { FileEvent } from './file-watcher';

export type NativeFileEventDependencies = {
  withNamespaceRead?: typeof withNativeWorkspaceFilesRead;
};

function changedScope(): never {
  throw Object.assign(new Error('The filesystem event does not match its current workspace document namespace.'), {
    status: 409, code: 'NATIVE_FILE_EVENT_SOURCE_CHANGED',
  });
}

/** Filesystem projection output is not another native document birth or
 * deletion. Only the existing namespace reader owns the read TX/admission
 * fence; no native content, initialization or mutation is needed here. */
export async function classifyWorkspaceFilesystemEvent(input: {
  workspace: WorkspaceContext;
  event: FileEvent;
}, dependencies: NativeFileEventDependencies = {}): Promise<FileEvent> {
  const workspace = structuredClone(input.workspace), event = structuredClone(input.event);
  if (!workspace.permissions.canRead || workspace.status !== undefined && workspace.status !== 'active') {
    throw Object.assign(new Error('Current workspace read permission is required.'), { status: 403 });
  }
  if (event.workspaceId !== workspace.workspaceId || event.relativePath !== '.' && !isCanonicalAdmissionPath(event.relativePath)) changedScope();
  // Directory observations and managed domain renames retain their own event
  // contract. Native file classification cannot invent a directory authority.
  if (event.type === 'addDir' || event.type === 'unlinkDir' || event.type === 'rename') return event;
  if (!['add', 'change', 'unlink'].includes(event.type) || event.relativePath === '.') changedScope();

  return (dependencies.withNamespaceRead ?? withNativeWorkspaceFilesRead)({
    workspace, paths: [event.relativePath], maxEntries: 1,
  }, async scope => {
    // The real helper rechecks this same bounded catalogue before COMMIT.
    // Reject an unexpected descendant/foreign witness rather than interpreting
    // an uncertain lookup as an unregistered physical file.
    if (scope.documents.length > 1 || scope.documents.some(document => document.path !== event.relativePath
      || document.workspace_id !== workspace.workspaceId || document.organization_id !== (workspace.organizationId ?? null)
      || !document.id || document.status !== 'active'
      || !['initialized', 'missing-state', 'pristine'].includes(document.authority))) changedScope();
    const document = scope.documents[0];
    if (!document || document.authority === 'pristine') return event;
    const nativeEvent: FileEvent = { ...event, type: 'change' };
    // A projection inode/mtime is not the native document's content version.
    delete nativeEvent.fileVersion;
    return nativeEvent;
  });
}
