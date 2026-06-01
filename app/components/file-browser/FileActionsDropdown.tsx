'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useMemo, useState } from 'react';
import {
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus,
  FolderPlus,
  Globe2,
  ImagePlus,
  Maximize2,
  Move,
  Pencil,
  PenTool,
  Share2,
  Trash2,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { isProtectedAppOutputFolder } from '@/app/lib/filesystem/app-output-folders';
import { useFileStore, type FileNode } from '@/app/store/file-store';
import { CreateItemDialog, type CreateItemType } from './CreateItemDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { DirectoryBrowser } from './DirectoryBrowser';
import { ShareMarkdownDialog } from './ShareMarkdownDialog';
import { PublicShareDialog } from './PublicShareDialog';

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

const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|bmp|tiff?)$/i;

type DropdownMenuContentProps = ComponentProps<typeof DropdownMenuContent>;

interface FileActionsDropdownProps {
  node: FileNode | null;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  modal?: boolean;
  contentProps?: Omit<DropdownMenuContentProps, 'children'>;
  showCreateActions?: boolean;
  showMultiSelectActions?: boolean;
  onAfterDelete?: (node: FileNode) => void;
  onAfterRename?: (oldPath: string, newPath: string, node: FileNode) => void;
  onAfterMove?: (oldPath: string, newPath: string, node: FileNode) => void;
}

export function FileActionsDropdown({
  node,
  children,
  open,
  onOpenChange,
  modal,
  contentProps,
  showCreateActions = true,
  showMultiSelectActions = true,
  onAfterDelete,
  onAfterRename,
  onAfterMove,
}: FileActionsDropdownProps) {
  const t = useTranslations('notebook');
  const locale = useLocale();
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveTarget, setMoveTarget] = useState('.');
  const [moveName, setMoveName] = useState('');
  const [moveExpandedDirs, setMoveExpandedDirs] = useState(new Set<string>());
  const [isMovingMultiple, setIsMovingMultiple] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [createType, setCreateType] = useState<CreateItemType>('file');
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [publicShareOpen, setPublicShareOpen] = useState(false);

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
    setBulkMoveOpen,
    refreshVisibleTree,
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

  const isImageFile = node
    ? node.type === 'file' && IMAGE_EXTENSIONS.test(node.name)
    : false;

  const showMultiSelectOptions = showMultiSelectActions && multiSelectPaths.size > 0;

  const closeMenu = () => {
    onOpenChange?.(false);
  };

  const handleOpenInStudio = () => {
    if (!node) return;
    closeMenu();
    const params = new URLSearchParams({
      ref: node.path,
      refSource: 'workspace',
    });
    const url = `/${locale}/studio/create?${params.toString()}`;
    window.open(url, '_blank');
  };

  const handleResizeInStudio = () => {
    if (!node) return;
    closeMenu();
    const params = new URLSearchParams({
      ref: node.path,
      refSource: 'workspace',
    });
    const url = `/${locale}/studio/aspect-ratio?${params.toString()}`;
    window.open(url, '_blank');
  };

  const handleNewFile = () => {
    closeMenu();
    setCreateType('file');
    setCreateOpen(true);
  };

  const handleNewExcalidraw = () => {
    closeMenu();
    setCreateType('excalidraw');
    setCreateOpen(true);
  };

  const handleNewFolder = () => {
    closeMenu();
    setCreateType('directory');
    setCreateOpen(true);
  };

  const handleCreate = async (
    fullPath: string,
    itemType: 'file' | 'directory',
    options?: { template?: 'excalidraw' }
  ) => {
    await createPath(fullPath, itemType, options);
  };

  const handleRename = () => {
    if (isProtectedOutputFolder) {
      toast.error(t('protectedFolderRename'));
      return;
    }

    if (node) setNewName(node.name);
    setRenameOpen(true);
    closeMenu();
  };

  const handleConfirmRename = async () => {
    if (!node || !newName || newName === node.name) {
      setRenameOpen(false);
      return;
    }

    const newPath = joinPath(getParentPath(node.path), newName);
    await renamePath(node.path, newPath);
    setRenameOpen(false);
    onAfterRename?.(node.path, newPath, node);
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
    closeMenu();
  };

  const handleMoveMultiple = () => {
    if (multiSelectPaths.size === 0) return;

    const hasProtected = Array.from(multiSelectPaths).some(path => isProtectedAppOutputFolder(path));
    if (hasProtected) {
      toast.error(t('protectedFolderMove'));
      return;
    }

    setBulkMoveOpen(true);
    closeMenu();
  };

  const handleDelete = () => {
    if (isProtectedOutputFolder) {
      toast.error(t('protectedFolderDelete'));
      return;
    }

    setDeleteOpen(true);
    closeMenu();
  };

  const handleConfirmDelete = async () => {
    if (!node) return;
    await deletePath(node.path);
    onAfterDelete?.(node);
  };

  const handleDownload = async () => {
    if (!node) return;
    await downloadFile(node.path);
    closeMenu();
  };

  const handleCopyPath = async () => {
    if (!node) return;
    try {
      await navigator.clipboard.writeText(node.path);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
    closeMenu();
  };

  const handleCopy = () => {
    if (!node) return;
    if (showMultiSelectOptions) {
      copyPaths();
    } else {
      copyPaths([node.path]);
    }
    closeMenu();
  };

  const handlePaste = async () => {
    if (!node) return;
    const destDir = node.type === 'directory' ? node.path : getParentPath(node.path);
    try {
      await pastePaths(destDir);
      closeMenu();
    } catch {}
  };

  const handleDuplicate = async () => {
    if (!node) return;
    try {
      await duplicatePath(node.path);
      closeMenu();
    } catch {}
  };

  const handleShare = () => {
    setShareOpen(true);
    closeMenu();
  };

  const handlePublicShare = () => {
    setPublicShareOpen(true);
    closeMenu();
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
      onAfterMove?.(node.path, destination, node);
    }
    setMoveOpen(false);
  };

  return (
    <>
      <DropdownMenu open={open} onOpenChange={onOpenChange} modal={modal}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent align="start" sideOffset={4} {...contentProps}>
          {showMultiSelectOptions && (
            <>
              <DropdownMenuItem onSelect={handleMoveMultiple}>
                <Move className="h-4 w-4" />
                {t('moveMultiple', { count: multiSelectPaths.size })}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {showCreateActions && (
            <>
              <DropdownMenuItem onSelect={handleNewFile}>
                <FilePlus className="h-4 w-4" />
                {t('newFile')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleNewExcalidraw}>
                <PenTool className="h-4 w-4" />
                {t('newExcalidraw')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleNewFolder}>
                <FolderPlus className="h-4 w-4" />
                {t('newFolder')}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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
          <DropdownMenuItem onSelect={handlePublicShare} disabled={!node || node.type !== 'file'}>
            <Globe2 className="h-4 w-4" />
            {node?.publicShare?.status === 'active' ? t('publicShareManage') : t('publicShareAction')}
          </DropdownMenuItem>
          {isMarkdown && (
            <DropdownMenuItem onSelect={handleShare}>
              <Share2 className="h-4 w-4" />
              {t('share')}
            </DropdownMenuItem>
          )}
          {isImageFile && (
            <>
              <DropdownMenuItem onSelect={handleOpenInStudio}>
                <ImagePlus className="h-4 w-4" />
                {t('openInStudio')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleResizeInStudio}>
                <Maximize2 className="h-4 w-4" />
                {t('resizeInStudio')}
              </DropdownMenuItem>
            </>
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
            <DialogDescription>{t('renameDescription')}</DialogDescription>
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
            <DialogDescription>{t('moveDescription')}</DialogDescription>
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

      {node && (
        <PublicShareDialog
          open={publicShareOpen}
          onOpenChange={setPublicShareOpen}
          paths={node.type === 'file' ? [node.path] : []}
          onPublished={() => void refreshVisibleTree()}
        />
      )}
    </>
  );
}
