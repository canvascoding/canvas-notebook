import type { OpenWorkspaceFileOptions, OpenWorkspaceFileResult } from './types';

export type CreatedItemFollowUpResult =
  | OpenWorkspaceFileResult
  | { status: 'directory-opened'; path: string };

interface CompleteCreatedWorkspaceItemOptions {
  path: string;
  itemType: 'file' | 'directory';
  workspaceId: string | null;
  transitionId: string;
  getActiveWorkspaceId: () => string | null;
  openFile: (
    path: string,
    options: OpenWorkspaceFileOptions,
  ) => Promise<OpenWorkspaceFileResult>;
  openDirectory: (path: string, workspaceId: string | null) => Promise<void>;
}

export async function completeCreatedWorkspaceItem({
  path,
  itemType,
  workspaceId,
  transitionId,
  getActiveWorkspaceId,
  openFile,
  openDirectory,
}: CompleteCreatedWorkspaceItemOptions): Promise<CreatedItemFollowUpResult> {
  if (getActiveWorkspaceId() !== workspaceId) {
    return { status: 'superseded', path };
  }

  if (itemType === 'directory') {
    await openDirectory(path, workspaceId);
    if (getActiveWorkspaceId() !== workspaceId) {
      return { status: 'superseded', path };
    }
    return { status: 'directory-opened', path };
  }

  return openFile(path, { workspaceId, transitionId });
}
