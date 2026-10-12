'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createWorkspacePath } from '@/app/lib/files/client';
import { getParentDirectories, joinWorkspacePath } from '@/app/lib/files/path-utils';
import { hasDirectoryInTree, insertConfirmedDirectory } from '@/app/lib/files/directory-picker-tree';
import { useFileStore } from '@/app/store/file-store';
import { useWorkspaceStore } from '@/app/store/workspace-store';
import { DirectoryBrowser, type DirectoryBrowserProps } from './DirectoryBrowser';

export interface DirectoryDestinationPickerProps extends Omit<DirectoryBrowserProps, 'onCreateDirectory'> {
  workspaceId?: string | null;
  onDirectoryCreated?: (path: string, parentPath: string, workspaceId: string) => Promise<void> | void;
}

export function DirectoryDestinationPicker(props: DirectoryDestinationPickerProps) {
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspaceId = props.workspaceId === undefined ? activeWorkspaceId : props.workspaceId;
  return <ScopedDirectoryDestinationPicker key={workspaceId ?? 'unavailable'} {...props} workspaceId={workspaceId} />;
}

function ScopedDirectoryDestinationPicker({ tree, workspaceId, onDirectoryCreated, expandedDirs,
  onToggleDir, isDirectoryDisabled, ...browserProps }: DirectoryDestinationPickerProps) {
  const t = useTranslations('notebook');
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const canWrite = Boolean(workspaceId && workspaces.some((workspace) => workspace.id === workspaceId
    && workspace.status === 'active' && workspace.permissions.canWrite));
  const [confirmedPaths, setConfirmedPaths] = useState<string[]>([]);
  const [refreshWarning, setRefreshWarning] = useState(false);
  const activeRef = useRef(true);
  const pendingRef = useRef(false);

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);
  useEffect(() => {
    // Release confirmations once the owner publishes them, so later deletions remain visible.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setConfirmedPaths((paths) => {
      const remaining = paths.filter((path) => !hasDirectoryInTree(tree, path));
      return remaining.length === paths.length ? paths : remaining;
    });
  }, [tree]);
  const visibleTree = useMemo(() => confirmedPaths.reduce(insertConfirmedDirectory, tree), [confirmedPaths, tree]);

  const createDirectory = async (parentPath: string, name: string): Promise<string | null> => {
    if (!workspaceId || !canWrite || browserProps.disabled || pendingRef.current || isDirectoryDisabled?.(parentPath)) return null;
    const path = joinWorkspacePath(parentPath, name);
    if (isDirectoryDisabled?.(path)) return null;
    const isCurrent = () => activeRef.current && useWorkspaceStore.getState().workspaces.some((workspace) => (
      workspace.id === workspaceId && workspace.status === 'active' && workspace.permissions.canWrite
    ));
    pendingRef.current = true;
    setRefreshWarning(false);
    try {
      await createWorkspacePath(path, 'directory', { workspaceId });
      if (!isCurrent()) return null;
      setConfirmedPaths((paths) => [...new Set([...paths, path])]);
      try {
        if (onDirectoryCreated) await onDirectoryCreated(path, parentPath, workspaceId);
        else if (useWorkspaceStore.getState().activeWorkspaceId === workspaceId) {
          await useFileStore.getState().refreshDirectory(parentPath, true, workspaceId);
          if (isCurrent() && useFileStore.getState().directoryErrors[parentPath]) setRefreshWarning(true);
        }
      } catch {
        if (isCurrent()) setRefreshWarning(true);
      }
      if (!isCurrent()) return null;
      for (const ancestor of getParentDirectories(path)) {
        if (!expandedDirs.has(ancestor)) onToggleDir(ancestor);
      }
      return path;
    } finally {
      pendingRef.current = false;
    }
  };

  return (
    <div className="min-w-0 space-y-2">
      <DirectoryBrowser {...browserProps} tree={visibleTree} expandedDirs={expandedDirs} onToggleDir={onToggleDir}
        isDirectoryDisabled={isDirectoryDisabled} onCreateDirectory={canWrite ? createDirectory : undefined} />
      {refreshWarning ? <p role="status" className="text-xs text-muted-foreground">{t('destinationFolderRefreshFailed')}</p> : null}
    </div>
  );
}
