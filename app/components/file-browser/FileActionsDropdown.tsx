'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus,
  FolderPlus,
  FolderInput,
  Globe2,
  ImagePlus,
  Images,
  Loader2,
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
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { hasMarpFileName } from '@/app/lib/marp/detect';
import { useFileStore } from '@/app/store/file-store';
import { copyWorkspacePaths } from '@/app/lib/files/client';
import type { FileNode } from '@/app/lib/files/types';
import { getParentDirectory, joinWorkspacePath } from '@/app/lib/files/path-utils';
import { isWorkspaceImageFileName, shareWorkspaceImageFile } from '@/app/lib/files/workspace-image-share';
import {
  getWorkspacePathName,
  isMoveIntoSelf,
  isProtectedDirectoryNode,
  resolveMoveDestination,
  splitProtectedWorkspacePaths,
} from '@/app/lib/files/operation-flows';
import { CreateItemDialog } from './CreateItemDialog';
import { DeleteConfirmDialog } from './DeleteConfirmDialog';
import { DirectoryBrowser } from './DirectoryBrowser';
import { ShareMarkdownDialog } from './ShareMarkdownDialog';
import { PublicShareDialog } from './PublicShareDialog';
import { MarpExportDialog } from './MarpExportDialog';
import { useCreateItemDialog } from './useCreateItemDialog';
import { WorkspaceDestinationPicker } from '@/app/components/workspaces/WorkspaceDestinationPicker';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';

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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [marpExportOpen, setMarpExportOpen] = useState(false);
  const [marpDetection, setMarpDetection] = useState<{ path: string; isMarp: boolean } | null>(null);
  const [publicShareOpen, setPublicShareOpen] = useState(false);
  const [copyToWorkspaceOpen, setCopyToWorkspaceOpen] = useState(false);
  const [copyTargetWorkspaceId, setCopyTargetWorkspaceId] = useState<string | null>(null);
  const [copyTargetDir, setCopyTargetDir] = useState('.');
  const [isCopyingToWorkspace, setIsCopyingToWorkspace] = useState(false);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);

  const {
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
    refreshDirectory,
  } = useFileStore();

  const parentPath = useMemo(() => {
    if (!node) return '.';
    if (node.type === 'directory') {
      return node.path;
    }
    return getParentDirectory(node.path);
  }, [node]);

  const isProtectedOutputFolder = isProtectedDirectoryNode(node);
  const nodePath = node?.path ?? null;

  const isMarkdown = node
    ? node.type === 'file' && /\.(md|mdx|markdown)$/i.test(node.name)
    : false;
  const hasMarpName = node ? node.type === 'file' && hasMarpFileName(node.name) : false;
  const isMarpMarkdown = node
    ? isMarkdown && (hasMarpName || (marpDetection?.path === node.path && marpDetection.isMarp))
    : false;

  const isImageFile = node
    ? node.type === 'file' && isWorkspaceImageFileName(node.name)
    : false;

  const showMultiSelectOptions = showMultiSelectActions && multiSelectPaths.size > 0;
  const selectedCopyPaths = useMemo(() => {
    if (showMultiSelectOptions) return Array.from(multiSelectPaths);
    return node ? [node.path] : [];
  }, [multiSelectPaths, node, showMultiSelectOptions]);

  useEffect(() => {
    if (!nodePath || !isMarkdown || hasMarpName) {
      return;
    }

    let cancelled = false;

    fetch(`/api/files/marp-detect?path=${encodeURIComponent(nodePath)}`)
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<{ isMarp?: boolean }>;
      })
      .then((result) => {
        if (!cancelled) {
          setMarpDetection({ path: nodePath, isMarp: !!result?.isMarp });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMarpDetection({ path: nodePath, isMarp: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [hasMarpName, isMarkdown, nodePath]);

  const closeMenu = useCallback(() => {
    onOpenChange?.(false);
  }, [onOpenChange]);

  const { createDialogProps, openCreateDialog } = useCreateItemDialog(closeMenu);

  const handleOpenInStudio = () => {
    if (!node) return;
    closeMenu();
    const params = new URLSearchParams({
      ref: node.path,
      refSource: 'workspace',
    });
    const url = `/${locale}/studio?${params.toString()}`;
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
    openCreateDialog('file');
  };

  const handleNewExcalidraw = () => {
    openCreateDialog('excalidraw');
  };

  const handleNewFolder = () => {
    openCreateDialog('directory');
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

    const newPath = joinWorkspacePath(getParentDirectory(node.path), newName);
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
    if (node) setMoveTarget(getParentDirectory(node.path));
    setMoveExpandedDirs(new Set());
    setIsMovingMultiple(false);
    setMoveOpen(true);
    closeMenu();
  };

  const handleMoveMultiple = () => {
    if (multiSelectPaths.size === 0) return;

    const selectedProtection = splitProtectedWorkspacePaths(multiSelectPaths);
    if (selectedProtection.hasProtected) {
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

  const handleShareImage = async () => {
    if (!node || node.type !== 'file') return;
    closeMenu();
    const shareResult = await shareWorkspaceImageFile({
      path: node.path,
      fileName: node.name,
    });

    if (shareResult === 'shared' || shareResult === 'cancelled') return;

    await downloadFile(node.path);
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

  const handleCopyToWorkspace = () => {
    if (selectedCopyPaths.length === 0) return;

    const selectedProtection = splitProtectedWorkspacePaths(selectedCopyPaths);
    if (selectedProtection.hasProtected) {
      toast.error(t('protectedFolderCopy'));
      return;
    }

    setCopyTargetWorkspaceId(activeWorkspace?.id ?? null);
    setCopyTargetDir('.');
    setCopyToWorkspaceOpen(true);
    closeMenu();
  };

  const handleConfirmCopyToWorkspace = async () => {
    if (selectedCopyPaths.length === 0 || !activeWorkspace?.id || !copyTargetWorkspaceId) return;
    setIsCopyingToWorkspace(true);

    try {
      const result = await copyWorkspacePaths({
        sources: selectedCopyPaths,
        destDir: copyTargetDir,
        overwrite: false,
        renameOnCollision: true,
        sourceWorkspaceId: activeWorkspace.id,
        targetWorkspaceId: copyTargetWorkspaceId,
      }, t('copyToWorkspaceFailed'));

      if (copyTargetWorkspaceId === activeWorkspace.id) {
        await refreshDirectory(copyTargetDir, true);
      }

      if (showMultiSelectOptions) {
        clearMultiSelect();
      }

      const unresolvedCount = result.failed.length + result.skipped.length;
      if (unresolvedCount > 0) {
        console.warn('[FileActionsDropdown] Cross-workspace copy completed with unresolved paths', {
          failed: result.failed,
          skipped: result.skipped,
        });
        if (result.copied.length === 0) {
          toast.error(t('copyToWorkspaceNoFilesCopied', { count: unresolvedCount }));
          return;
        }
        toast.warning(t('copyToWorkspacePartialSuccess', {
          copied: result.copied.length,
          failed: unresolvedCount,
        }));
      } else {
        toast.success(t('copyToWorkspaceSuccess', { count: result.copied.length }));
      }
      setCopyToWorkspaceOpen(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('copyToWorkspaceFailed'));
    } finally {
      setIsCopyingToWorkspace(false);
    }
  };

  const handlePaste = async () => {
    if (!node) return;
    const destDir = node.type === 'directory' ? node.path : getParentDirectory(node.path);
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

  const handleMarpExport = () => {
    setMarpExportOpen(true);
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
        const destination = resolveMoveDestination(moveTarget, getWorkspacePathName(path));

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
      const destination = resolveMoveDestination(moveTarget, trimmedName);
      if (destination === node.path) {
        setMoveOpen(false);
        return;
      }
      if (node.type === 'directory' && isMoveIntoSelf(node.path, destination)) {
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
              <DropdownMenuLabel className="px-2 py-1 text-xs font-medium text-muted-foreground">
                {t('create')}
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={handleNewFolder}>
                <FolderPlus className="h-4 w-4" />
                {t('newFolder')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleNewFile}>
                <FilePlus className="h-4 w-4" />
                {t('newFile')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={handleNewExcalidraw}>
                <PenTool className="h-4 w-4" />
                {t('newExcalidraw')}
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
          <DropdownMenuItem onSelect={handleCopyToWorkspace} disabled={selectedCopyPaths.length === 0}>
            <FolderInput className="h-4 w-4" />
            {t('copyToWorkspace')}
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
          {isMarpMarkdown && (
            <DropdownMenuItem onSelect={handleMarpExport}>
              <Images className="h-4 w-4" />
              {t('exportMarpSlides')}
            </DropdownMenuItem>
          )}
          {isImageFile && (
            <>
              <DropdownMenuItem onSelect={handleShareImage}>
                <Share2 className="h-4 w-4" />
                {t('shareImage')}
              </DropdownMenuItem>
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
        {...createDialogProps}
        defaultPath={parentPath}
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

      <Dialog open={copyToWorkspaceOpen} onOpenChange={setCopyToWorkspaceOpen}>
        <DialogContent className="max-w-xl overflow-hidden">
          <DialogHeader>
            <DialogTitle>{t('copyToWorkspaceTitle')}</DialogTitle>
            <DialogDescription>{t('copyToWorkspaceDescription', { count: selectedCopyPaths.length })}</DialogDescription>
          </DialogHeader>
          <WorkspaceDestinationPicker
            selectedWorkspaceId={copyTargetWorkspaceId}
            selectedDir={copyTargetDir}
            onWorkspaceChange={setCopyTargetWorkspaceId}
            onDirChange={setCopyTargetDir}
          />
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setCopyToWorkspaceOpen(false)}>
              {t('cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={() => void handleConfirmCopyToWorkspace()}
              disabled={isCopyingToWorkspace || !copyTargetWorkspaceId || selectedCopyPaths.length === 0}
            >
              {isCopyingToWorkspace ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderInput className="h-4 w-4" />}
              {t('copyToWorkspaceConfirm')}
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

      {isMarpMarkdown && node && (
        <MarpExportDialog
          open={marpExportOpen}
          onOpenChange={setMarpExportOpen}
          filePath={node.path}
          fileName={node.name}
        />
      )}

      {node && (
        <PublicShareDialog
          open={publicShareOpen}
          onOpenChange={setPublicShareOpen}
          paths={node.type === 'file' ? [node.path] : []}
          onPublished={() => void refreshDirectory(getParentDirectory(node.path), true)}
        />
      )}
    </>
  );
}
