'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronsUpDown, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DirectoryDestinationPicker } from '@/app/components/file-browser/DirectoryDestinationPicker';
import type { FileNode } from '@/app/lib/files/types';
import { loadWorkspaceTree } from '@/app/lib/files/client';
import { insertConfirmedDirectory } from '@/app/lib/files/directory-picker-tree';
import { cn } from '@/lib/utils';
import {
  getWorkspaceKindLabel,
  type WorkspaceKindLabels,
} from '@/app/components/workspaces/workspace-utils';
import {
  selectActiveWorkspace,
  useWorkspaceStore,
} from '@/app/store/workspace-store';

interface WorkspaceDestinationPickerProps {
  selectedWorkspaceId: string | null;
  selectedDir: string;
  onWorkspaceChange: (workspaceId: string) => void;
  onDirChange: (dirPath: string) => void;
  className?: string;
  disabled?: boolean;
  onCreatingDirectoryChange?: (busy: boolean) => void;
  allowWorkspaceChange?: boolean;
}

function mergeDirectoryChildren(nodes: FileNode[], dirPath: string, children: FileNode[]): FileNode[] {
  return nodes.map((node) => {
    if (node.path === dirPath && node.type === 'directory') {
      return { ...node, children };
    }
    if (node.children) {
      return { ...node, children: mergeDirectoryChildren(node.children, dirPath, children) };
    }
    return node;
  });
}

export function WorkspaceDestinationPicker({
  selectedWorkspaceId,
  selectedDir,
  onWorkspaceChange,
  onDirChange,
  className,
  disabled = false,
  onCreatingDirectoryChange,
  allowWorkspaceChange = true,
}: WorkspaceDestinationPickerProps) {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const writableWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'active' && workspace.permissions.canWrite),
    [workspaces]
  );
  const effectiveWorkspaceId = useMemo(() => {
    if (selectedWorkspaceId && writableWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)) return selectedWorkspaceId;
    if (!allowWorkspaceChange) return null;
    if (activeWorkspace && writableWorkspaces.some((workspace) => workspace.id === activeWorkspace.id)) return activeWorkspace.id;
    return writableWorkspaces[0]?.id ?? null;
  }, [activeWorkspace, allowWorkspaceChange, selectedWorkspaceId, writableWorkspaces]);
  useEffect(() => { void hydrateWorkspaces(); }, [hydrateWorkspaces]);
  useEffect(() => {
    if (effectiveWorkspaceId && effectiveWorkspaceId !== selectedWorkspaceId) {
      onWorkspaceChange(effectiveWorkspaceId);
      onDirChange('.');
    }
  }, [effectiveWorkspaceId, onDirChange, onWorkspaceChange, selectedWorkspaceId]);

  return <ScopedWorkspaceDestinationPicker key={effectiveWorkspaceId ?? 'unavailable'}
    selectedWorkspaceId={effectiveWorkspaceId} selectedDir={selectedDir} onWorkspaceChange={onWorkspaceChange}
    onDirChange={onDirChange} className={className} disabled={disabled}
    onCreatingDirectoryChange={onCreatingDirectoryChange} allowWorkspaceChange={allowWorkspaceChange} />;
}

function ScopedWorkspaceDestinationPicker({ selectedWorkspaceId: effectiveWorkspaceId, selectedDir,
  onWorkspaceChange, onDirChange, className, disabled = false, onCreatingDirectoryChange,
  allowWorkspaceChange = true }: WorkspaceDestinationPickerProps) {
  const t = useTranslations('workspaces');
  const notebookT = useTranslations('notebook');
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [loadingDirs, setLoadingDirs] = useState(new Set<string>());
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeRef = useRef(true);
  const [creatingDirectory, setCreatingDirectory] = useState(false);
  const requestVersionsRef = useRef(new Map<string, number>());

  const writableWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'active' && workspace.permissions.canWrite),
    [workspaces]
  );

  const kindLabels = {
    personal: t('types.personal'),
    organization: t('types.organization'),
    team: t('types.team'),
    project: t('types.project'),
  } satisfies WorkspaceKindLabels;

  useEffect(() => {
    activeRef.current = true;
    if (!effectiveWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTree([]);
      setLoadingDirs(new Set<string>());
      return;
    }

    let cancelled = false;
    setIsLoadingTree(true);
    setError(null);
    setExpandedDirs(new Set<string>());
    setLoadingDirs(new Set<string>());

    loadWorkspaceTree('.', 6, true, t('folderLoadFailed'), effectiveWorkspaceId)
      .then((nextTree) => {
        if (!cancelled) {
          setTree(nextTree);
        }
      })
      .catch((loadError) => {
        if (!cancelled) {
          setTree([]);
          setError(loadError instanceof Error ? loadError.message : t('folderLoadFailed'));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingTree(false);
        }
      });

    return () => {
      cancelled = true;
      activeRef.current = false;
    };
  }, [effectiveWorkspaceId, t]);

  const handleWorkspaceSelect = (workspaceId: string) => {
    if (!workspaceId || disabled || creatingDirectory || !allowWorkspaceChange) return;
    onWorkspaceChange(workspaceId);
    onDirChange('.');
  };

  const handleToggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) {
        next.delete(dirPath);
      } else {
        next.add(dirPath);
      }
      return next;
    });
  };

  const handleLoadSubdirectory = async (dirPath: string) => {
    const requestWorkspaceId = effectiveWorkspaceId;
    if (!requestWorkspaceId) return;
    const version = (requestVersionsRef.current.get(dirPath) ?? 0) + 1;
    requestVersionsRef.current.set(dirPath, version);
    const isCurrent = () => activeRef.current && requestVersionsRef.current.get(dirPath) === version;
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const children = await loadWorkspaceTree(dirPath, 1, true, t('folderLoadFailed'), requestWorkspaceId);
      if (!isCurrent()) return;
      setTree((prev) => mergeDirectoryChildren(prev, dirPath, children));
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(loadError instanceof Error ? loadError.message : t('folderLoadFailed'));
    } finally {
      if (!isCurrent()) return;
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  };

  const handleDirectoryCreated = async (path: string, parentPath: string, workspaceId: string) => {
    if (!activeRef.current || workspaceId !== effectiveWorkspaceId) return;
    setTree((previous) => insertConfirmedDirectory(previous, path));
    const version = (requestVersionsRef.current.get(parentPath) ?? 0) + 1;
    requestVersionsRef.current.set(parentPath, version);
    const children = await loadWorkspaceTree(parentPath, 1, true, t('folderLoadFailed'), workspaceId);
    if (!activeRef.current || requestVersionsRef.current.get(parentPath) !== version) return;
    setTree((previous) => insertConfirmedDirectory(parentPath === '.' ? children
      : mergeDirectoryChildren(previous, parentPath, children), path));
  };

  if (!effectiveWorkspaceId || writableWorkspaces.length === 0) {
    return (
      <div className={cn('rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground', className)}>
        {t('noWritableWorkspace')}
      </div>
    );
  }

  return (
    <div className={cn('min-w-0 space-y-3', className)}>
      {allowWorkspaceChange ? <label className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{t('targetWorkspace')}</span>
        <span className="relative block">
          <select
            value={effectiveWorkspaceId ?? ''}
            onChange={(event) => handleWorkspaceSelect(event.target.value)}
            disabled={disabled || creatingDirectory}
            className="h-9 w-full appearance-none rounded-md border border-input bg-background px-2 pr-8 text-left text-sm font-normal shadow-xs outline-none transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {!effectiveWorkspaceId ? <option value="">{t('targetWorkspace')}</option> : null}
            {writableWorkspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name} - {getWorkspaceKindLabel(workspace, kindLabels)}
              </option>
            ))}
          </select>
          <ChevronsUpDown className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        </span>
      </label> : null}

      <div className="min-w-0 overflow-hidden rounded-md border border-border bg-muted/40 px-3 py-2">
        <p className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t('targetFolder')}</p>
        <p className="mt-1 truncate font-mono text-sm">{selectedDir === '.' ? notebookT('rootDirectory') : selectedDir}</p>
      </div>

      {error ? <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div> : null}

      <div className="relative">
        {isLoadingTree ? (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded border border-border bg-background/70">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : null}
        <DirectoryDestinationPicker
          workspaceId={effectiveWorkspaceId}
          tree={tree}
          selectedPath={selectedDir}
          onSelect={onDirChange}
          expandedDirs={expandedDirs}
          onToggleDir={handleToggleDir}
          loadingDirs={loadingDirs}
          onLoadSubdirectory={handleLoadSubdirectory}
          onDirectoryCreated={handleDirectoryCreated}
          disabled={disabled || isLoadingTree}
          onCreatingDirectoryChange={(busy) => { setCreatingDirectory(busy); onCreatingDirectoryChange?.(busy); }}
        />
      </div>
    </div>
  );
}
