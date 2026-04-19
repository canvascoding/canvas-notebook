'use client';

import { useMemo, useState } from 'react';
import { Download, FilePlus, FolderPlus, Pencil, Trash2, Copy, Move, Share2, ClipboardCopy, ClipboardPaste, CopyPlus } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
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
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { ShareMarkdownDialog } from './ShareMarkdownDialog';
import { CreateItemDialog } from './CreateItemDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { DirectoryBrowser } from './DirectoryBrowser';

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

export function FileContextMenu() {
  const t = useTranslations('notebook');
  const contextMenuNode = useFileStore((s) => s.contextMenuNode);
  const contextMenuPosition = useFileStore((s) => s.contextMenuPosition);
  const isContextMenuOpen = useFileStore((s) => s.isContextMenuOpen);
  const contextMenuRequestId = useFileStore((s) => s.contextMenuRequestId);
  const closeContextMenu = useFileStore((s) => s.closeContextMenu);
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveName, setMoveName] = useState('');
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());
  const [isMovingMultiple, setIsMovingMultiple] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<'file' | 'directory'>('file');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);

  const node = contextMenuNode;

  const {
    createPath,
    deletePath,
    renamePath,
    downloadFile,
    fileTree,
    multiSelectPaths,
    clearMultiSelect,
    copyPaths,
    pastePaths,
    duplicatePath,
    clipboardPaths,
    clipboardMode,
  } = useFileStore();

  const parentPath = useMemo(() => {
    if (!node) return '.';
    if (node.type === 'directory') {
      return node.path;
    }
    return getParentPath(node.path);
  }, [node]);

  const isProtectedOutputFolder = node
    ? node.type === 'directory' && isProtectedAppOutputFolder(node.path)
    : false;

  const isMarkdown = node
    ? node.type === 'file' && /\.(md|mdx|markdown)$/i.test(node.name)
    : false;

  const handleNewFile = () => {
    closeContextMenu();
    setCreateType('file');
    setCreateOpen(true);
  };

  const handleNewFolder = () => {

    closeContextMenu();
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

    if (node) setNewName(node.name);
    setRenameOpen(true);
    closeContextMenu();
  };

  const handleConfirmRename = async () => {
    if (!node || !newName || newName === node.name) {
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

    if (node) setMoveName(node.name);
    if (node) setMoveTarget(getParentPath(node.path));
    setMoveExpandedDirs(new Set());
    setIsMovingMultiple(false);
    setMoveOpen(true);
    closeContextMenu();
  };

  const handleMoveMultiple = () => {
    if (multiSelectPaths.size === 0) return;

    const hasProtected = Array.from(multiSelectPaths).some(path => isProtectedAppOutputFolder(path));
    if (hasProtected) {
      toast.error(t('protectedFolderMove'));
      return;
    }


    setMoveTarget('.');
    setMoveExpandedDirs(new Set());
    setIsMovingMultiple(true);
    setMoveOpen(true);
    closeContextMenu();
  };

  const handleDelete = () => {
    if (isProtectedOutputFolder) {
      toast.error(t('protectedFolderDelete'));
      return;
    }

    setDeleteOpen(true);
    closeContextMenu();
  };

  const handleConfirmDelete = async () => {
    if (node) await deletePath(node.path);
  };

  const handleDownload = async () => {
    if (node) await downloadFile(node.path);
  };

  const handleCopyPath = async () => {
    if (!node) return;
    try {
      await navigator.clipboard.writeText(node.path);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
  };

  const handleCopy = () => {
    copyPaths();
    closeContextMenu();

  };

  const handlePaste = async () => {
    if (!node) return;
    const destDir = node.type === 'directory' ? node.path : getParentPath(node.path);
    try {
      await pastePaths(destDir);
      closeContextMenu();
  
    } catch {}
  };

  const handleDuplicate = async () => {
    if (!node) return;
    try {
      await duplicatePath(node.path);
      closeContextMenu();
  
    } catch {}
  };

  const handleShare = () => {

    setShareOpen(true);
    closeContextMenu();
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
      const pathsToMove = Array.from(multiSelectPaths);
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
      if (!node) return;
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

  const showMultiSelectOptions = multiSelectPaths.size > 0;
  const menuOpen = isContextMenuOpen && !!node && !!contextMenuPosition;

  if (!node || !contextMenuPosition) {
    return null;
  }

  return (
    <>
      <DropdownMenu
        key={contextMenuRequestId}
        open={menuOpen}
        onOpenChange={(open) => {
          if (!open) closeContextMenu();
        }}
        modal={false}
      >
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-hidden="true"
            className="pointer-events-none fixed h-1 w-1 opacity-0"
            style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          sideOffset={4}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {showMultiSelectOptions && (
            <>
              <DropdownMenuItem onSelect={handleMoveMultiple}>
                <Move className="h-4 w-4" />
                {t('moveMultiple', { count: multiSelectPaths.size })}
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
          <DropdownMenuItem onSelect={handleCopyPath} disabled={!node}>
            <Copy className="h-4 w-4" />
            {t('copyPath')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleCopy} disabled={!node}>
            <ClipboardCopy className="h-4 w-4" />
            {t('copy')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handlePaste} disabled={clipboardMode !== 'copy' || clipboardPaths.size === 0}>
            <ClipboardPaste className="h-4 w-4" />
            {t('paste')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleDuplicate} disabled={isProtectedOutputFolder || !node}>
            <CopyPlus className="h-4 w-4" />
            {t('duplicate')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={handleRename} disabled={isProtectedOutputFolder || !node}>
            <Pencil className="h-4 w-4" />
            {t('rename')}
          </DropdownMenuItem>
          {!showMultiSelectOptions && (
            <DropdownMenuItem onSelect={handleMove} disabled={isProtectedOutputFolder || !node}>
              <Move className="h-4 w-4" />
              {t('move')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={handleDownload} disabled={!node}>
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
            disabled={isProtectedOutputFolder || !node}
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
        paths={node ? [node.path] : []}
        skippedCount={0}
        onConfirm={handleConfirmDelete}
      />

      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{node ? t('renameTitle', { name: node.name }) : ''}</DialogTitle>
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
            <DialogTitle>{node ? t('moveTitle', { name: node.name }) : ''}</DialogTitle>
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

      {isMarkdown && node && (
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
