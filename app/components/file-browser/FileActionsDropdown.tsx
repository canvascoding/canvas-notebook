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
  Info,
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
import { copyWorkspacePaths, workspaceHeaders } from '@/app/lib/files/client';
import type { FileNode } from '@/app/lib/files/types';
import { getParentDirectory, joinWorkspacePath } from '@/app/lib/files/path-utils';
import { isWorkspaceImageFileName, shareWorkspaceImageFile } from '@/app/lib/files/workspace-image-share';
import {
  compactWorkspaceSelection,
  isMoveIntoSelf,
  isProtectedDirectoryNode,
  resolveMoveDestination,
  splitProtectedWorkspacePaths,
  summarizeWorkspaceBatchResult,
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
import { useShallow } from 'zustand/react/shallow';
import { useTrashUndo } from './useTrashUndo';
import { FileInfoDialog } from './FileInfoDialog';

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
  const [moveError, setMoveError] = useState('');
  const [isMoving, setIsMoving] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [renameError, setRenameError] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [marpExportOpen, setMarpExportOpen] = useState(false);
  const [marpDetection, setMarpDetection] = useState<{ path: string; isMarp: boolean } | null>(null);
  const [publicShareOpen, setPublicShareOpen] = useState(false);
  const [copyToWorkspaceOpen, setCopyToWorkspaceOpen] = useState(false);
  const [copyTargetWorkspaceId, setCopyTargetWorkspaceId] = useState<string | null>(null);
  const [copyTargetDir, setCopyTargetDir] = useState('.');
  const [isCopyingToWorkspace, setIsCopyingToWorkspace] = useState(false);
  const [fileInfoOpen, setFileInfoOpen] = useState(false);
  const activeWorkspace = useWorkspaceStore(selectActiveWorkspace);

  const {
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
  } = useFileStore(useShallow((state) => ({
    renamePath: state.renamePath,
    downloadFile: state.downloadFile,
    fileTree: state.fileTree,
    multiSelectPaths: state.multiSelectPaths,
    clearMultiSelect: state.clearMultiSelect,
    copyPaths: state.copyPaths,
    pastePaths: state.pastePaths,
    duplicatePath: state.duplicatePath,
    clipboardPaths: state.clipboardPaths,
    clipboardMode: state.clipboardMode,
    setBulkMoveOpen: state.setBulkMoveOpen,
    refreshDirectory: state.refreshDirectory,
  })));
  const deleteWithUndo = useTrashUndo();

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
    if (showMultiSelectOptions) return compactWorkspaceSelection(multiSelectPaths);
    return node ? compactWorkspaceSelection([node.path]) : [];
  }, [multiSelectPaths, node, showMultiSelectOptions]);

  useEffect(() => {
    if (!nodePath || !isMarkdown || hasMarpName) {
      return;
    }

    let cancelled = false;

    fetch(`/api/files/marp-detect?path=${encodeURIComponent(nodePath)}`, {
      headers: workspaceHeaders(),
    })
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

  const { createDialogProps, openCreateDialog } = useCreateItemDialog({ onBeforeOpen: closeMenu });

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
    setRenameError('');
    setIsRenaming(false);
    setRenameOpen(true);
    closeMenu();
  };

  const handleConfirmRename = async () => {
    if (!node) return;
    const trimmedName = newName.trim();
    if (!trimmedName) {
      setRenameError(t('pleaseEnterName'));
      return;
    }
    if (trimmedName === node.name) {
      setRenameOpen(false);
      return;
    }

    const newPath = joinWorkspacePath(getParentDirectory(node.path), trimmedName);
    setIsRenaming(true);
    setRenameError('');
    try {
      await renamePath(node.path, newPath);
      setRenameOpen(false);
      onAfterRename?.(node.path, newPath, node);
    } catch (renameOperationError) {
      setRenameError(renameOperationError instanceof Error ? renameOperationError.message : t('renameFailed'));
    } finally {
      setIsRenaming(false);
    }
  };

  const handleMove = () => {
    if (isProtectedOutputFolder) {
      toast.error(t('protectedFolderMove'));
      return;
    }

    if (node) setMoveName(node.name);
    if (node) setMoveTarget(getParentDirectory(node.path));
    setMoveExpandedDirs(new Set());
    setMoveError('');
    setIsMoving(false);
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
    await deleteWithUndo(node.path);
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

  const handleShowFileInfo = () => {
    if (!node) return;
    setFileInfoOpen(true);
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

      const summary = summarizeWorkspaceBatchResult(result);
      if (summary.hasUnresolved) {
        console.warn('[FileActionsDropdown] Cross-workspace copy completed with unresolved paths', {
          failed: result.failed,
          skipped: result.skipped,
        });
        if (!summary.hasCopied) {
          toast.error(t('copyToWorkspaceNoFilesCopied', { count: summary.unresolvedCount }));
          return;
        }
        toast.warning(t('copyToWorkspacePartialSuccess', {
          copied: summary.copiedCount,
          failed: summary.unresolvedCount,
        }));
      } else {
        toast.success(t('copyToWorkspaceSuccess', { count: summary.copiedCount }));
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
      const result = await pastePaths(destDir);
      closeMenu();
      if (!result) return;

      const summary = summarizeWorkspaceBatchResult(result);
      if (summary.hasUnresolved) {
        console.warn('[FileActionsDropdown] Paste completed with unresolved paths', {
          failed: result.failed,
          skipped: result.skipped,
        });
        if (!summary.hasCopied) {
          toast.error(t('pasteNoFilesCopied', { count: summary.unresolvedCount }));
          return;
        }
        toast.warning(t('pastePartialSuccess', {
          copied: summary.copiedCount,
          failed: summary.unresolvedCount,
        }));
      } else {
        toast.success(t('pasteSuccess', { count: summary.copiedCount }));
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('pasteFailed'));
    }
  };

  const handleDuplicate = async () => {
    if (!node) return;
    try {
      await duplicatePath(node.path);
      closeMenu();
    } catch (duplicateError) {
      toast.error(duplicateError instanceof Error ? duplicateError.message : t('duplicateFailed'));
    }
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
    if (!node) return;
    const trimmedName = moveName.trim();
    if (!trimmedName) {
      setMoveError(t('pleaseEnterName'));
      return;
    }
    const destination = resolveMoveDestination(moveTarget, trimmedName);
    if (destination === node.path) {
      setMoveOpen(false);
      return;
    }
    if (node.type === 'directory' && isMoveIntoSelf(node.path, destination)) {
      setMoveError(t('moveIntoSelf'));
      return;
    }
    setIsMoving(true);
    setMoveError('');
    try {
      await renamePath(node.path, destination);
      onAfterMove?.(node.path, destination, node);
      setMoveOpen(false);
    } catch (moveOperationError) {
      setMoveError(moveOperationError instanceof Error ? moveOperationError.message : t('moveFailed'));
    } finally {
      setIsMoving(false);
    }
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
          <DropdownMenuItem onSelect={handleShowFileInfo} disabled={!node}>
            <Info className="h-4 w-4" />
            {t('fileInfoAction')}
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

      <FileInfoDialog node={node} open={fileInfoOpen} onOpenChange={setFileInfoOpen} />

      <Dialog
        open={renameOpen}
        onOpenChange={(nextOpen) => {
          if (!isRenaming || nextOpen) setRenameOpen(nextOpen);
        }}
      >
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
              onChange={(e) => {
                setNewName(e.target.value);
                if (renameError) setRenameError('');
              }}
              className="mt-1"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !isRenaming) void handleConfirmRename();
              }}
              autoFocus
              disabled={isRenaming}
            />
            {renameError && <p className="mt-1.5 text-xs text-destructive" role="alert">{renameError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)} disabled={isRenaming}>{t('cancel')}</Button>
            <Button variant="secondary" onClick={() => void handleConfirmRename()} disabled={isRenaming}>
              {isRenaming && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('rename')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={moveOpen}
        onOpenChange={(nextOpen) => {
          if (!isMoving || nextOpen) setMoveOpen(nextOpen);
        }}
      >
        <DialogContent className="max-w-xl">
          <DialogHeader>
            <DialogTitle>{node ? t('moveTitle', { name: node.name }) : ''}</DialogTitle>
            <DialogDescription>{t('moveDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label htmlFor="moveTarget" className="text-xs text-muted-foreground">{t('destinationFolder')}</label>
              <Input
                id="moveTarget"
                value={moveTarget}
                onChange={(event) => {
                  setMoveTarget(event.target.value);
                  if (moveError) setMoveError('');
                }}
                className="mt-1"
                disabled={isMoving}
              />
            </div>
            <div>
              <label htmlFor="moveName" className="text-xs text-muted-foreground">{t('name')}</label>
              <Input
                id="moveName"
                value={moveName}
                onChange={(event) => {
                  setMoveName(event.target.value);
                  if (moveError) setMoveError('');
                }}
                className="mt-1"
                disabled={isMoving}
              />
            </div>
            <div className={isMoving ? 'pointer-events-none opacity-60' : undefined}>
              <DirectoryBrowser
                tree={fileTree}
                selectedPath={moveTarget}
                onSelect={(path) => {
                  setMoveTarget(path);
                  if (moveError) setMoveError('');
                }}
                expandedDirs={moveExpandedDirs}
                onToggleDir={toggleMoveDir}
              />
            </div>
            {moveError && <p className="text-sm text-destructive" role="alert">{moveError}</p>}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setMoveOpen(false)} disabled={isMoving}>
              {t('cancel')}
            </Button>
            <Button variant="secondary" onClick={() => void handleConfirmMove()} disabled={isMoving}>
              {isMoving && <Loader2 className="h-4 w-4 animate-spin" />}
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
