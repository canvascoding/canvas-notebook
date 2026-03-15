'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Folder, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
};

function collectExpandedPaths(nodes: FileNode[], paths = new Set<string>()): Set<string> {
  for (const node of nodes) {
    if (node.type !== 'directory') {
      continue;
    }

    paths.add(node.path);

    if (node.children?.length) {
      collectExpandedPaths(node.children, paths);
    }
  }

  return paths;
}

function collectAncestorPaths(path: string | undefined): Set<string> {
  if (!path) {
    return new Set();
  }

  const normalized = path.trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!normalized) {
    return new Set();
  }

  const segments = normalized.split('/');
  const ancestors = new Set<string>();
  for (let index = 1; index < segments.length; index += 1) {
    ancestors.add(segments.slice(0, index).join('/'));
  }
  return ancestors;
}

function filterDirectoryTree(nodes: FileNode[], query: string): FileNode[] {
  if (!query) {
    return nodes;
  }

  const normalizedQuery = query.toLowerCase();
  const filtered: FileNode[] = [];

  for (const node of nodes) {
    if (node.type !== 'directory') {
      continue;
    }

    const filteredChildren = node.children ? filterDirectoryTree(node.children, normalizedQuery) : [];
    const matchesSelf = node.path.toLowerCase().includes(normalizedQuery);

    if (matchesSelf || filteredChildren.length > 0) {
      filtered.push({
        ...node,
        children: filteredChildren,
      });
    }
  }

  return filtered;
}

function buildDirectoryLabel(path: string): string {
  return path === '.' ? 'Workspace Root' : path;
}

type WorkspaceDirectoryPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
  selectedPath?: string;
};

export function WorkspaceDirectoryPickerDialog({
  open,
  onOpenChange,
  onSelect,
  selectedPath,
}: WorkspaceDirectoryPickerDialogProps) {
  const [directories, setDirectories] = useState<FileNode[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

  async function loadDirectories() {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('/api/files/tree?path=.&depth=6&noCache=1', {
        cache: 'no-store',
        credentials: 'include',
      });
      const payload = await response.json();
      if (!response.ok || !payload.success) {
        throw new Error(payload.error || 'Ordner konnten nicht geladen werden.');
      }

      const nextDirectories = (payload.data || []).filter((node: FileNode) => node.type === 'directory');
      setDirectories(nextDirectories);
    } catch (loadError) {
      setDirectories([]);
      setError(loadError instanceof Error ? loadError.message : 'Ordner konnten nicht geladen werden.');
    } finally {
      setIsLoading(false);
    }
  }

  useEffect(() => {
    if (!open) {
      setSearch('');
      return;
    }

    setExpandedPaths(collectAncestorPaths(selectedPath));
    void loadDirectories();
  }, [open, selectedPath]);

  const filteredDirectories = useMemo(() => {
    return filterDirectoryTree(directories, search.trim());
  }, [directories, search]);

  const visibleExpandedPaths = useMemo(() => {
    if (!search.trim()) {
      return expandedPaths;
    }

    const next = new Set(expandedPaths);
    collectExpandedPaths(filteredDirectories, next);
    return next;
  }, [expandedPaths, filteredDirectories, search]);



  function renderDirectoryNodes(nodes: FileNode[], depth = 0): ReactNode {
    return nodes.map((directory) => {
      const hasChildren = Boolean(directory.children?.length);
      const isExpanded = visibleExpandedPaths.has(directory.path);
      const isSelected = (selectedPath || '') === (directory.path === '.' ? '' : directory.path);
      const label = buildDirectoryLabel(directory.path);

      return (
        <Collapsible
          key={directory.path}
          open={hasChildren ? isExpanded : false}
          onOpenChange={(open) => {
            if (!hasChildren) return;
            setExpandedPaths((current) => {
              const next = new Set(current);
              if (open) {
                next.add(directory.path);
              } else {
                next.delete(directory.path);
              }
              return next;
            });
          }}
          className="space-y-1"
        >
          <div
            className={cn(
              'flex min-w-0 items-center gap-2 rounded-md border px-2 py-2',
              isSelected ? 'border-primary bg-primary/5' : 'border-transparent bg-background',
            )}
            style={{ marginLeft: `${depth * 12}px` }}
          >
            <CollapsibleTrigger
              type="button"
              data-testid={`automation-directory-toggle-${directory.path.replace(/[^a-z0-9]+/gi, '-')}`}
              className={cn(
                'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border',
                hasChildren ? 'border-border text-foreground hover:bg-muted' : 'pointer-events-none border-transparent text-muted-foreground',
              )}
              aria-label={hasChildren ? 'Ordner auf- oder zuklappen' : 'Keine Unterordner'}
            >
              <ChevronRight
                className={cn(
                  'h-4 w-4 transition',
                  hasChildren ? '' : 'opacity-30',
                  isExpanded ? 'rotate-90' : '',
                )}
              />
            </CollapsibleTrigger>
            <button
              type="button"
              data-testid={`automation-directory-option-${directory.path === '.' ? 'root' : directory.path.replace(/[^a-z0-9]+/gi, '-')}`}
              className="flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-1 text-left hover:bg-muted"
              onClick={() => {
                onSelect(directory.path === '.' ? '' : directory.path);
                onOpenChange(false);
              }}
            >
              <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="truncate font-mono text-xs">{label}</span>
            </button>
          </div>

          {hasChildren && (isExpanded || search.trim().length > 0) ? (
            <CollapsibleContent forceMount>
              {renderDirectoryNodes(directory.children || [], depth + 1)}
            </CollapsibleContent>
          ) : null}
        </Collapsible>
      );
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-3xl">
        <DialogHeader>
          <DialogTitle>Ordner im Workspace wählen</DialogTitle>
          <DialogDescription>
            Wähle einen bestehenden Basisordner im Workspace-Inspector. Der Tree startet standardmäßig eingeklappt.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
          <div className="space-y-3 min-w-0">
            <div className="flex gap-2">
              <Input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Ordner suchen"
              />
              <Button variant="outline" size="sm" onClick={() => void loadDirectories()} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
              </Button>
            </div>

            {error ? <p className="text-sm text-destructive">{error}</p> : null}

            <ScrollArea className="h-[420px] rounded-md border border-border bg-background p-2" data-testid="automation-directory-picker">
              {isLoading ? (
                <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Lade Ordner...
                </div>
              ) : filteredDirectories.length === 0 ? (
                <div className="flex h-28 items-center justify-center text-sm text-muted-foreground">
                  Keine Ordner gefunden.
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="rounded-md border border-transparent bg-background">
                    <button
                      type="button"
                      data-testid="automation-directory-option-root"
                      className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left hover:bg-muted ${
                        !selectedPath ? 'border border-primary bg-primary/5' : ''
                      }`}
                      onClick={() => {
                        onSelect('');
                        onOpenChange(false);
                      }}
                    >
                      <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="font-mono text-xs">Workspace Root</span>
                    </button>
                  </div>
                  {renderDirectoryNodes(filteredDirectories)}
                </div>
              )}
            </ScrollArea>
          </div>

          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4">
            <div>
              <p className="text-sm font-medium">Aktuelle Auswahl</p>
              <p className="mt-2 break-all rounded-md border border-border bg-background px-3 py-2 font-mono text-xs text-muted-foreground">
                {selectedPath || 'Workspace Root'}
              </p>
            </div>

            <div className="space-y-2 text-xs text-muted-foreground">
              <p>Nur Ordner innerhalb des Workspace sind auswählbar.</p>
              <p>Wenn du keinen eigenen Pfad setzt, nutzt die Automation automatisch ihren Standardordner.</p>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
