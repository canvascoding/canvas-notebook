'use client';

import { useMemo, useState } from 'react';
import { Download, FilePlus, FolderPlus, Pencil, Trash2, MoreHorizontal, Copy, Move, Share2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
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
import { useFileStore } from '@/app/store/file-store';
import { cn } from '@/lib/utils';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { ShareMarkdownDialog } from './ShareMarkdownDialog';
import { CreateItemDialog } from './CreateItemDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { DirectoryBrowser } from './DirectoryBrowser';

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
  const t = useTranslations('notebook');
  const [open, setOpen] = useState(false);
  
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveName, setMoveName] = useState(node.name);
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());
  const [isMovingMultiple, setIsMovingMultiple] = useState(false);

  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'directory'>('file');
  
  const [deleteOpen, setDeleteOpen] = useState(false);
  
  const [shareOpen, setShareOpen] = useState(false);
  
  const isProtectedOutputFolder =
    node.type === 'directory' && isProtectedAppOutputFolder(node.path);
  
  const isMarkdown = node.type === 'file' && /\.(md|mdx|markdown)$/i.test(node.name);

  const { 
    createPath, 
    deletePath, 
    renamePath, 
    downloadFile, 
    fileTree,
    multiSelectPaths,
    clearMultiSelect,
  } = useFileStore();
  const parentPath = useMemo(() => {
    if (node.type === 'directory') {
      return node.path;
    }
    return getParentPath(node.path);
  }, [node]);

  const handleNewFile = () => {
    setOpen(false);
    setCreateType('file');
    setCreateOpen(true);
  };

  const handleNewFolder = () => {
    setOpen(false);
    setCreateType('directory');
    setCreateOpen(true);
  };

  const handleCreate = async (fullPath: string, itemType: 'file' | 'directory') => {
    await createPath(fullPath, itemType);
  };

  const handleRename = () => {
    if (isProtectedOutputFolder) {
      toast.error(t('protectedFolderRename'));
      return;
    }
    setOpen(false);
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
      toast.error(t('protectedFolderMove'));
      return;
    }
    setOpen(false);
    setMoveName(node.name);
    setMoveTarget(getParentPath(node.path));
    setMoveExpandedDirs(new Set());
    setIsMovingMultiple(false);
    setMoveOpen(true);
  };

  const handleMoveMultiple = () => {
    if (multiSelectPaths.length === 0) return;
    
    const hasProtected = multiSelectPaths.some(path => isProtectedAppOutputFolder(path));
    if (hasProtected) {
      toast.error(t('protectedFolderMove'));
      return;
    }
    
    setOpen(false);
    setMoveTarget('.');
    setMoveExpandedDirs(new Set());
    setIsMovingMultiple(true);
    setMoveOpen(true);
  };

  const handleDelete = () => {
    if (isProtectedOutputFolder) {
      toast.error(t('protectedFolderDelete'));
      return;
    }
    setOpen(false);
    setDeleteOpen(true);
  };

  const handleConfirmDelete = async () => {
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

  const handleConfirmMove = async () => {
    if (isMovingMultiple) {
      const pathsToMove = [...multiSelectPaths];
      let successCount = 0;
      
      for (const path of pathsToMove) {
        const name = path.split('/').pop() || path;
        const destination = moveTarget === '.' ? name : `${moveTarget}/${name}`;
        
        if (path === destination) {
          successCount++;
          continue;
        }
        
        try {
          await renamePath(path, destination);
          successCount++;
        } catch (error) {
          console.error(`Failed to move ${path}:`, error);
        }
      }
      
      clearMultiSelect();
      toast.success(t('moveMultipleSuccess', { count: successCount }));
    } else {
      const trimmedName = moveName.trim();
      if (!trimmedName) {
        toast.error(t('pleaseEnterName'));
        return;
      }
      const destination = moveTarget === '.' ? trimmedName : `${moveTarget}/${trimmedName}`;
      if (destination === node.path) {
        setMoveOpen(false);
        return;
      }
      if (node.type === 'directory' && destination.startsWith(`${node.path}/`)) {
        toast.error(t('moveIntoSelf'));
        return;
      }
      await renamePath(node.path, destination);
    }
    setMoveOpen(false);
  };

  const showMultiSelectOptions = multiSelectPaths.length > 0;

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
            aria-label={t('fileActions')}
          >
            <MoreHorizontal className="h-4 w-4 text-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6}>
          {showMultiSelectOptions && (
            <>
              <DropdownMenuItem onSelect={handleMoveMultiple}>
                <Move className="h-4 w-4" />
                {t('moveMultiple', { count: multiSelectPaths.length })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuItem onSelect={handleNewFile}>
            <FilePlus className="h-4 w-4" />
            {t('newFile')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleNewFolder}>
            <FolderPlus className="h-4 w-4" />
            {t('newFolder')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleCopyPath}>
            <Copy className="h-4 w-4" />
            {t('copyPath')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleRename} disabled={isProtectedOutputFolder}>
            <Pencil className="h-4 w-4" />
            {t('rename')}
          </DropdownMenuItem>
          {!showMultiSelectOptions && (
            <DropdownMenuItem onSelect={handleMove} disabled={isProtectedOutputFolder}>
              <Move className="h-4 w-4" />
              {t('move')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={handleDownload}>
            <Download className="h-4 w-4" />
            {t('download')}
          </DropdownMenuItem>
          {isMarkdown && (
            <DropdownMenuItem onSelect={handleShare}>
              <Share2 className="h-4 w-4" />
              {t('share')}
            </DropdownMenuItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onSelect={handleDelete}
            disabled={isProtectedOutputFolder}
          >
            <Trash2 className="h-4 w-4" />
            {t('delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateItemDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        type={createType}
        defaultPath={parentPath}
        onCreate={handleCreate}
      />

      <DeleteConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        paths={[node.path]}
        skippedCount={0}
        onConfirm={handleConfirmDelete}
      />

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>{t('renameTitle', { name: node.name })}</DialogTitle>
              <DialogDescription>
                {t('renameDescription')}
              </DialogDescription>
            </DialogHeader>
          <div className="py-4">
            <label htmlFor="newName" className="text-xs text-muted-foreground">{t('newName')}</label>
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
            <Button variant="ghost" onClick={() => setRenameOpen(false)}>{t('cancel')}</Button>
            <Button variant="secondary" onClick={handleConfirmRename}>{t('rename')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={moveOpen} onOpenChange={setMoveOpen}>
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{t('moveTitle', { name: node.name })}</DialogTitle>
            <DialogDescription>
              {t('moveDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-xs text-muted-foreground">{t('destinationFolder')}</label>
              <Input
                value={moveTarget}
                onChange={(event) => setMoveTarget(event.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">{t('name')}</label>
              <Input
                value={moveName}
                onChange={(event) => setMoveName(event.target.value)}
                className="mt-1"
              />
            </div>
            <DirectoryBrowser
              tree={fileTree}
              selectedPath={moveTarget}
              onSelect={setMoveTarget}
              expandedDirs={moveExpandedDirs}
              onToggleDir={toggleMoveDir}
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setMoveOpen(false)}>
              {t('cancel')}
            </Button>
            <Button variant="secondary" onClick={handleConfirmMove}>
              {t('move')}
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