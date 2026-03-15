'use client';

import { useEffect, useMemo, useState } from 'react';
import { Folder, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';

type FileNode = {
  name: string;
  path: string;
  type: 'file' | 'directory';
  children?: FileNode[];
};

type DirectoryOption = {
  path: string;
  label: string;
};

function flattenDirectories(nodes: FileNode[], options: DirectoryOption[] = []): DirectoryOption[] {
  for (const node of nodes) {
    if (node.type !== 'directory') {
      continue;
    }

    options.push({
      path: node.path,
      label: node.path === '.' ? 'Workspace Root' : node.path,
    });

    if (node.children?.length) {
      flattenDirectories(node.children, options);
    }
  }

  return options;
}

type WorkspaceDirectoryPickerDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (path: string) => void;
};

export function WorkspaceDirectoryPickerDialog({
  open,
  onOpenChange,
  onSelect,
}: WorkspaceDirectoryPickerDialogProps) {
  const [directories, setDirectories] = useState<DirectoryOption[]>([]);
  const [search, setSearch] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

      const nextDirectories = flattenDirectories(payload.data || []);
      setDirectories([
        { path: '.', label: 'Workspace Root' },
        ...nextDirectories.filter((entry) => entry.path !== '.'),
      ]);
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

    void loadDirectories();
  }, [open]);

  const filteredDirectories = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) {
      return directories;
    }

    return directories.filter((entry) => entry.path.toLowerCase().includes(query));
  }, [directories, search]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] max-w-2xl">
        <DialogHeader>
          <DialogTitle>Ordner im Workspace wählen</DialogTitle>
          <DialogDescription>
            Wähle einen bestehenden Basisordner. Du kannst den Pfad danach bei Bedarf noch im Feld verfeinern.
          </DialogDescription>
        </DialogHeader>

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

        <ScrollArea className="h-[360px] rounded-md border border-border bg-background p-2" data-testid="automation-directory-picker">
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
              {filteredDirectories.map((directory) => (
                <button
                  key={directory.path}
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md border border-transparent px-3 py-2 text-left text-sm transition hover:border-primary/30 hover:bg-muted"
                  onClick={() => {
                    onSelect(directory.path === '.' ? '' : directory.path);
                    onOpenChange(false);
                  }}
                >
                  <Folder className="h-4 w-4 text-muted-foreground" />
                  <span className="font-mono text-xs">{directory.label}</span>
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
