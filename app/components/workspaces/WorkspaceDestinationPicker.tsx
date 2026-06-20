'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { DirectoryBrowser } from '@/app/components/file-browser/DirectoryBrowser';
import type { FileNode } from '@/app/lib/files/types';
import { loadWorkspaceTree } from '@/app/lib/files/client';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
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
}: WorkspaceDestinationPickerProps) {
  const t = useTranslations('workspaces');
  const notebookT = useTranslations('notebook');
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);
  const hydrateWorkspaces = useWorkspaceStore((state) => state.hydrateWorkspaces);
  const [tree, setTree] = useState<FileNode[]>([]);
  const [expandedDirs, setExpandedDirs] = useState(new Set<string>());
  const [loadingDirs, setLoadingDirs] = useState(new Set<string>());
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);

  useEffect(() => {
    void hydrateWorkspaces();
  }, [hydrateWorkspaces]);

  const writableWorkspaces = useMemo(
    () => workspaces.filter((workspace) => workspace.status === 'active' && workspace.permissions.canWrite),
    [workspaces]
  );

  const effectiveWorkspaceId = useMemo(() => {
    if (selectedWorkspaceId && writableWorkspaces.some((workspace) => workspace.id === selectedWorkspaceId)) {
      return selectedWorkspaceId;
    }
    if (activeWorkspace?.permissions.canWrite) return activeWorkspace.id;
    return writableWorkspaces[0]?.id ?? null;
  }, [activeWorkspace, selectedWorkspaceId, writableWorkspaces]);

  const kindLabels = {
    personal: t('types.personal'),
    team: t('types.team'),
    project: t('types.project'),
  } satisfies WorkspaceKindLabels;

  useEffect(() => {
    if (effectiveWorkspaceId && effectiveWorkspaceId !== selectedWorkspaceId) {
      onWorkspaceChange(effectiveWorkspaceId);
      onDirChange('.');
    }
  }, [effectiveWorkspaceId, onDirChange, onWorkspaceChange, selectedWorkspaceId]);

  useEffect(() => {
    if (!effectiveWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTree([]);
      return;
    }

    let cancelled = false;
    setIsLoadingTree(true);
    setError(null);
    setExpandedDirs(new Set<string>());

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
    };
  }, [effectiveWorkspaceId, t]);

  const handleWorkspaceSelect = (workspaceId: string) => {
    onWorkspaceChange(workspaceId);
    onDirChange('.');
    setWorkspaceMenuOpen(false);
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
    if (!effectiveWorkspaceId) return;
    setLoadingDirs((prev) => new Set(prev).add(dirPath));
    try {
      const children = await loadWorkspaceTree(dirPath, 1, true, t('folderLoadFailed'), effectiveWorkspaceId);
      setTree((prev) => mergeDirectoryChildren(prev, dirPath, children));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('folderLoadFailed'));
    } finally {
      setLoadingDirs((prev) => {
        const next = new Set(prev);
        next.delete(dirPath);
        return next;
      });
    }
  };

  if (writableWorkspaces.length === 0) {
    return (
      <div className={cn('rounded-md border border-border bg-muted/40 px-3 py-2 text-sm text-muted-foreground', className)}>
        {t('noWritableWorkspace')}
      </div>
    );
  }

  const selectedWorkspace = writableWorkspaces.find((workspace) => workspace.id === effectiveWorkspaceId);

  return (
    <div className={cn('min-w-0 space-y-3', className)}>
      <label className="flex min-w-0 flex-col gap-1 text-sm">
        <span className="text-xs font-medium text-muted-foreground">{t('targetWorkspace')}</span>
        <Popover open={workspaceMenuOpen} onOpenChange={setWorkspaceMenuOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              role="combobox"
              aria-expanded={workspaceMenuOpen}
              className="h-9 min-w-0 justify-between px-2 text-left font-normal"
            >
              <span className="min-w-0 truncate">
                {selectedWorkspace
                  ? `${selectedWorkspace.name} - ${getWorkspaceKindLabel(selectedWorkspace, kindLabels)}`
                  : t('targetWorkspace')}
              </span>
              <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-[var(--radix-popover-trigger-width)] p-1">
            <Command>
              <CommandList>
                <CommandEmpty>{t('noWritableWorkspace')}</CommandEmpty>
                <CommandGroup>
                  {writableWorkspaces.map((workspace) => {
                    const selected = workspace.id === effectiveWorkspaceId;
                    return (
                      <CommandItem
                        key={workspace.id}
                        value={`${workspace.name} ${workspace.id}`}
                        onSelect={() => handleWorkspaceSelect(workspace.id)}
                      >
                        <Check className={cn('h-4 w-4', selected ? 'opacity-100' : 'opacity-0')} />
                        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                        <span className="shrink-0 text-xs text-muted-foreground">
                          {getWorkspaceKindLabel(workspace, kindLabels)}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </label>

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
        <DirectoryBrowser
          tree={tree}
          selectedPath={selectedDir}
          onSelect={onDirChange}
          expandedDirs={expandedDirs}
          onToggleDir={handleToggleDir}
          loadingDirs={loadingDirs}
          onLoadSubdirectory={handleLoadSubdirectory}
        />
      </div>
    </div>
  );
}
