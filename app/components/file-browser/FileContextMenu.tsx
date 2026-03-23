'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, Download, FilePlus, FolderPlus, Pencil, Trash2, MoreHorizontal, Copy, Move, Folder, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { useFileStore, type FileNode } from '@/app/store/file-store';
import { cn } from '@/lib/utils';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { ShareMarkdownDialog } from './ShareMarkdownDialog';

interface FileContextMenuProps {
  node: {
    path: string;
    name: string;
    type: 'file' | 'directory';
  };
  isRowActive?: boolean;
}

function getParentPath(path: string) {
  const trimmed = path.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash <= 0) {
    return '.';
  }
  return trimmed.slice(0, lastSlash);
}

function joinPath(parent: string, name: string) {
  const normalizedParent = parent === '.' ? '' : parent.replace(/\/+$/, '');
  const normalizedName = name.replace(/^\/+/, '');
  if (!normalizedParent) {
    return normalizedName;
  }
  return `${normalizedParent}/${normalizedName}`;
}

export function FileContextMenu({ node, isRowActive = false }: FileContextMenuProps) {
  const [open, setOpen] = useState(false);
  
  // State for Move Dialog
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveName, setMoveName] = useState(node.name);
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());

  // State for Rename Dialog
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  
  // State for Share Dialog (Markdown only)
  const [shareOpen, setShareOpen] = useState(false);
  
  const isProtectedOutputFolder =
    node.type === 'directory' && isProtectedAppOutputFolder(node.path);
  
  // Check if file is a markdown file
  const isMarkdown = node.type === 'file' && /\.(md|mdx|markdown)$/i.test(node.name);

  const { createPath, deletePath, renamePath, downloadFile, fileTree } =
    useFileStore();
  const parentPath = useMemo(() => {
    if (node.type === 'directory') {
      return node.path;
    }
    return getParentPath(node.path);
  }, [node]);

  const handleNewFile = async () => {
    const name = window.prompt('New file name');
    if (!name) return;
    await createPath(joinPath(parentPath, name), 'file');
  };

  const handleNewFolder = async () => {
    const name = window.prompt('New folder name');
    if (!name) return;
    await createPath(joinPath(parentPath, name), 'directory');
  };

  const handleRename = () => {
    if (isProtectedOutputFolder) {
      toast.error('This app output folder cannot be renamed.');
      return;
    }
    setOpen(false); // Close dropdown
    setNewName(node.name);
    setRenameOpen(true);
  };
  
  const handleConfirmRename = async () => {
    if (!newName || newName === node.name) {
      setRenameOpen(false);
      return;
    }
    await renamePath(node.path, joinPath(getParentPath(node.path), newName));
    setRenameOpen(false);
  };

  const handleMove = () => {
    if (isProtectedOutputFolder) {
      toast.error('This app output folder cannot be moved.');
      return;
    }
    setOpen(false);
    setMoveName(node.name);
    setMoveTarget(getParentPath(node.path));
    setMoveExpandedDirs(new Set()); // Collapse all on open
    setMoveOpen(true);
  };

  const handleDelete = async () => {
    if (isProtectedOutputFolder) {
      toast.error('This app output folder cannot be deleted.');
      return;
    }
    const confirmed = window.confirm(`Delete "${node.name}"?`);
    if (!confirmed) return;
    await deletePath(node.path);
  };

  const handleDownload = async () => {
    await downloadFile(node.path);
  };

  const handleCopyPath = async () => {
    try {
      await navigator.clipboard.writeText(node.path);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  const handleShare = () => {
    setOpen(false);
    setShareOpen(true);
  };

  const toggleMoveDir = (path: string) => {
    setMoveExpandedDirs(prev => {
      const newSet = new Set(prev);
      if (newSet.has(path)) {
        newSet.delete(path);
      } else {
        newSet.add(path);
      }
      return newSet;
    });
  };

  const renderMoveDirectories = (nodes: FileNode[], depth = 0): ReactNode[] => {
    return nodes.flatMap((entry) => {
      if (entry.type !== 'directory') return [];
      
      const isSelected = moveTarget === entry.path;
      const isExpanded = moveExpandedDirs.has(entry.path);
      
      const row = (
        <div key={entry.path} className="flex items-center" style={{ paddingLeft: `${depth * 12}px` }}>
          <button
            type="button"
            className="p-1 rounded hover:bg-accent/70"
            onClick={() => toggleMoveDir(entry.path)}
          >
            <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${isExpanded ? 'rotate-90' : ''}`} />
          </button>
          <button
            type="button"
            className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
              isSelected ? 'bg-accent text-accent-foreground' : 'text-foreground hover:bg-accent/70'
            }`}
            onClick={() => setMoveTarget(entry.path)}
          >
            <Folder className="h-4 w-4 text-muted-foreground" />
            <span className="truncate">{entry.name}</span>
          </button>
        </div>
      );
      
      const children = isExpanded && entry.children ? renderMoveDirectories(entry.children, depth + 1) : [];
      return [row, ...children];
    });
  };

  const handleConfirmMove = async () => {
    const trimmedName = moveName.trim();
    if (!trimmedName) {
      toast.error('Please enter a name.');
      return;
    }
    const destination = moveTarget === '.' ? trimmedName : `${moveTarget}/${trimmedName}`;
    if (destination === node.path) {
      setMoveOpen(false);
      return;
    }
    if (node.type === 'directory' && destination.startsWith(`${node.path}/`)) {
      toast.error('Cannot move a folder into itself.');
      return;
    }
    await renamePath(node.path, destination);
    setMoveOpen(false);
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={setOpen} modal={false}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className={cn(
              'ml-1 text-foreground transition-opacity',
              isRowActive || open
                ? 'opacity-100'
                : 'opacity-100 md:opacity-0 md:group-hover:opacity-70 hover:opacity-100',
              isRowActive
                ? 'bg-transparent border-transparent hover:!bg-transparent active:!bg-transparent'
                : 'bg-transparent border-transparent hover:!bg-accent/70 active:!bg-accent/70'
            )}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(true);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            aria-label="File actions"
          >
            <MoreHorizontal className="h-4 w-4 text-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          <DropdownMenuItem onSelect={handleNewFile}>
            <FilePlus className="h-4 w-4" />
            New file
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleNewFolder}>
            <FolderPlus className="h-4 w-4" />
            New folder
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleCopyPath}>
            <Copy className="h-4 w-4" />
            Copy path
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleRename} disabled={isProtectedOutputFolder}>
            <Pencil className="h-4 w-4" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleMove} disabled={isProtectedOutputFolder}>
            <Move className="h-4 w-4" />
            Move
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleDownload}>
            <Download className="h-4 w-4" />
            Download
          </DropdownMenuItem>
          {isMarkdown && (
            <DropdownMenuItem onSelect={handleShare}>
              <Share2 className="h-4 w-4" />
              Share
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={handleDelete}
            disabled={isProtectedOutputFolder}
          >
            <Trash2 className="h-4 w-4" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{`Rename "${node.name}"`}</DialogTitle>
              <DialogDescription>
                Enter a new name for the item. The new name will be saved in the same directory.
              </DialogDescription>
            </DialogHeader>
          <div className="py-4">
            <label htmlFor="newName" className="text-xs text-muted-foreground">New name</label>
            <Input
              id="newName"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="mt-1"
              onKeyDown={(e) => e.key === 'Enter' && handleConfirmRename()}
              autoFocus
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>Cancel</Button>
            <Button variant="secondary" onClick={handleConfirmRename}>Rename</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{`Move "${node.name}"`}</DialogTitle>
            <DialogDescription>
              Select a new destination folder and optionally rename the item.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground">Destination folder</label>
              <Input
                value={moveTarget}
                onChange={(event) => setMoveTarget(event.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Name</label>
              <Input
                value={moveName}
                onChange={(event) => setMoveName(event.target.value)}
                className="mt-1"
              />
            </div>
            <div className="rounded border border-border bg-muted/40 p-2">
              <div className="mb-2 text-xs text-muted-foreground">Choose destination</div>
              <div className="max-h-56 overflow-auto">
                <button
                  type="button"
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm ${
                    moveTarget === '.'
                      ? 'bg-accent text-accent-foreground'
                      : 'text-foreground hover:bg-accent/70'
                  }`}
                  onClick={() => setMoveTarget('.')}
                >
                  <Folder className="h-4 w-4 text-muted-foreground" />
                  <span className="truncate">/ (root)</span>
                </button>
                {renderMoveDirectories(fileTree)}
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>
              Cancel
            </Button>
            <Button variant="secondary" onClick={handleConfirmMove}>
              Move
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isMarkdown && (
        <ShareMarkdownDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          filePath={node.path}
          fileName={node.name}
        />
      )}
    </>
  );
}
