'use client';

import type { ComponentProps, ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClipboardCopy,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Download,
  FilePlus,
  FolderPlus,
  FolderSearch,
  FolderInput,
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
import { copyWorkspacePaths, previewWorkspaceCopy, previewWorkspaceRename, workspaceHeaders, type WorkspaceFileOperationDryRun } from '@/app/lib/files/client';
import type { WorkspacePlannerIssue } from '@/app/lib/markdown/workspace-file-operation-planner';
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
import { PublicShareDialog } from './PublicShareDialog';
import { MarpExportDialog } from './MarpExportDialog';
import { useCreateItemDialog } from './useCreateItemDialog';
import { WorkspaceDestinationPicker } from '@/app/components/workspaces/WorkspaceDestinationPicker';
import { selectActiveWorkspace, useWorkspaceStore } from '@/app/store/workspace-store';
import { useShallow } from 'zustand/react/shallow';
import { useTrashUndo } from './useTrashUndo';
import { FileInfoDialog } from './FileInfoDialog';
import { FileVersionMenuItem, type FileVersionMenuSource } from './FileVersionMenuItem';

type DropdownMenuContentProps = ComponentProps<typeof DropdownMenuContent>;

const previewIssueKeys = {
  'unsupported-operation': 'fileOperationIssueUnsupportedOperation',
  'cross-workspace-move': 'fileOperationIssueCrossWorkspaceMove',
  'invalid-path': 'fileOperationIssueInvalidPath',
  'missing-source': 'fileOperationIssueMissingSource',
  'overlapping-selection': 'fileOperationIssueOverlappingSelection',
  'destination-collision': 'fileOperationIssueDestinationCollision',
  'duplicate-destination': 'fileOperationIssueDuplicateDestination',
  'directory-cycle': 'fileOperationIssueDirectoryCycle',
  'incomplete-index': 'fileOperationIssueIncompleteIndex',
  'uncopied-cross-workspace-target': 'fileOperationIssueUncopiedTarget',
  'stale-content': 'fileOperationIssueStaleContent',
  'unsupported-target-format': 'fileOperationIssueUnsupportedTargetFormat',
} as const satisfies Record<WorkspacePlannerIssue['code'], string>;

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
  onRevealInExplorer?: () => void;
  versionLineageId?: string | null;
  versionCenterSource?: FileVersionMenuSource;
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
  onRevealInExplorer,
  versionLineageId,
  versionCenterSource = 'file_browser',
}: FileActionsDropdownProps) {
  const t = useTranslations('notebook');
  const linkWarningDescription = (status: 'partial' | 'incomplete') => t(status === 'partial'
    ? 'fileOperationLinksPartial' : 'fileOperationLinksUnverified');
  const fileOperationErrorMessage = (error: unknown, fallbackKey: 'renameFailed' | 'copyToWorkspaceFailed') => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'PREVIEW_STALE') return t('fileOperationPreviewStale');
    if (code === 'PREVIEW_BLOCKED') return t('fileOperationPreviewBlockedApply');
    return error instanceof Error ? error.message : t(fallbackKey);
  };
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
  const [isPreviewingRename, setIsPreviewingRename] = useState(false);
  const [renamePreview, setRenamePreview] = useState<WorkspaceFileOperationDryRun | null>(null);
  const renamePreviewRequestId = useRef(0);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [marpExportOpen, setMarpExportOpen] = useState(false);
  const [marpDetection, setMarpDetection] = useState<{ path: string; isMarp: boolean } | null>(null);
  const [publicShareOpen, setPublicShareOpen] = useState(false);
  const [copyToWorkspaceOpen, setCopyToWorkspaceOpen] = useState(false);
  const [copyTargetWorkspaceId, setCopyTargetWorkspaceId] = useState<string | null>(null);
  const [copyTargetDir, setCopyTargetDir] = useState('.');
  const [isCopyingToWorkspace, setIsCopyingToWorkspace] = useState(false);
  const [isPreviewingCopy, setIsPreviewingCopy] = useState(false);
  const [copyPreview, setCopyPreview] = useState<WorkspaceFileOperationDryRun | null>(null);
  const copyPreviewRequestId = useRef(0);
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
    renamePreviewRequestId.current += 1;
    setRenamePreview(null);
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
      const result = await renamePath(node.path, newPath, false, true, activeWorkspace?.id ?? null,
        renamePreview?.plan.planId);
      if (result && result.linkStatus && result.linkStatus !== 'complete') {
        toast.warning(t('fileOperationLinksIncomplete'), {
          description: linkWarningDescription(result.linkStatus),
        });
      }
      setRenameOpen(false);
      onAfterRename?.(node.path, newPath, node);
    } catch (renameOperationError) {
      setRenameError(fileOperationErrorMessage(renameOperationError, 'renameFailed'));
    } finally {
      setIsRenaming(false);
    }
  };

  const handlePreviewRename = async () => {
    if (!node || !newName.trim() || newName.trim() === node.name) return;
    setIsPreviewingRename(true);
    setRenameError('');
    setRenamePreview(null);
    const requestId = ++renamePreviewRequestId.current;
    const workspaceId = activeWorkspace?.id ?? null;
    try {
      const preview = await previewWorkspaceRename(
        node.path,
        joinWorkspacePath(getParentDirectory(node.path), newName.trim()),
        workspaceId,
      );
      if (requestId === renamePreviewRequestId.current
        && useWorkspaceStore.getState().activeWorkspaceId === workspaceId) setRenamePreview(preview);
    } catch (error) {
      if (requestId === renamePreviewRequestId.current) {
        setRenameError(error instanceof Error ? error.message : t('renameFailed'));
      }
    } finally {
      if (requestId === renamePreviewRequestId.current) setIsPreviewingRename(false);
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
    const selectedPaths = showMultiSelectOptions ? selectedCopyPaths : [node.path];
    if (selectedPaths.length === 0) return;
    await downloadFile(selectedPaths);
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
    copyPreviewRequestId.current += 1;
    setCopyPreview(null);
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
        planId: copyPreview?.plan.planId,
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
        }), { description: result.linkStatus && result.linkStatus !== 'complete'
          ? linkWarningDescription(result.linkStatus) : undefined });
      } else {
        if (result.linkStatus && result.linkStatus !== 'complete') {
          toast.warning(t('fileOperationLinksIncomplete'), { description: linkWarningDescription(result.linkStatus) });
        } else {
          toast.success(t('copyToWorkspaceSuccess', { count: summary.copiedCount }));
        }
      }
      setCopyToWorkspaceOpen(false);
    } catch (error) {
      toast.error(fileOperationErrorMessage(error, 'copyToWorkspaceFailed'));
    } finally {
      setIsCopyingToWorkspace(false);
    }
  };

  const handlePreviewCopyToWorkspace = async () => {
    if (selectedCopyPaths.length === 0 || !activeWorkspace?.id || !copyTargetWorkspaceId) return;
    setIsPreviewingCopy(true);
    setCopyPreview(null);
    const requestId = ++copyPreviewRequestId.current;
    const sourceWorkspaceId = activeWorkspace.id;
    try {
      const preview = await previewWorkspaceCopy({
        sources: selectedCopyPaths,
        destDir: copyTargetDir,
        renameOnCollision: true,
        sourceWorkspaceId,
        targetWorkspaceId: copyTargetWorkspaceId,
      });
      if (requestId === copyPreviewRequestId.current
        && useWorkspaceStore.getState().activeWorkspaceId === sourceWorkspaceId) setCopyPreview(preview);
    } catch (error) {
      if (requestId === copyPreviewRequestId.current) {
        toast.error(error instanceof Error ? error.message : t('copyToWorkspaceFailed'));
      }
    } finally {
      if (requestId === copyPreviewRequestId.current) setIsPreviewingCopy(false);
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
        }), { description: result.linkStatus && result.linkStatus !== 'complete'
          ? linkWarningDescription(result.linkStatus) : undefined });
      } else {
        if (result.linkStatus && result.linkStatus !== 'complete') {
          toast.warning(t('fileOperationLinksIncomplete'), { description: linkWarningDescription(result.linkStatus) });
        } else {
          toast.success(t('pasteSuccess', { count: summary.copiedCount }));
        }
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('pasteFailed'));
    }
  };

  const handleDuplicate = async () => {
    if (!node) return;
    try {
      const result = await duplicatePath(node.path);
      if (result.linkStatus && result.linkStatus !== 'complete') {
        toast.warning(t('fileOperationLinksIncomplete'), { description: linkWarningDescription(result.linkStatus) });
      }
      closeMenu();
    } catch (duplicateError) {
      toast.error(duplicateError instanceof Error ? duplicateError.message : t('duplicateFailed'));
    }
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
      const result = await renamePath(node.path, destination);
      if (result && result.linkStatus && result.linkStatus !== 'complete') {
        toast.warning(t('fileOperationLinksIncomplete'), {
          description: linkWarningDescription(result.linkStatus),
        });
      }
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
          {onRevealInExplorer ? (
            <DropdownMenuItem onSelect={onRevealInExplorer} disabled={!node}>
              <FolderSearch className="h-4 w-4" />
              {t('revealInFileBrowser')}
            </DropdownMenuItem>
          ) : null}
          <DropdownMenuItem onSelect={handleCopyPath} disabled={!node}>
            <Copy className="h-4 w-4" />
            {t('copyPath')}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleShowFileInfo} disabled={!node}>
            <Info className="h-4 w-4" />
            {t('fileInfoAction')}
          </DropdownMenuItem>
          {node?.type === 'file' ? (
            <FileVersionMenuItem
              workspaceId={activeWorkspace?.id ?? null}
              path={node.path}
              lineageId={versionLineageId}
              source={versionCenterSource}
            />
          ) : null}
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
            <Share2 className="h-4 w-4" />
            {t('share')}
          </DropdownMenuItem>
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
                renamePreviewRequestId.current += 1;
                setIsPreviewingRename(false);
                setRenamePreview(null);
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
            {renamePreview && (
              <div className="mt-3 rounded-md border p-3 text-xs" role="status">
                <p>{t('fileOperationPreviewReadiness', { readiness: t(renamePreview.plan.readiness === 'ready'
                  ? 'fileOperationPreviewReady' : 'fileOperationPreviewBlocked') })}</p>
                <p>{t('fileOperationPreviewSummary', {
                  paths: renamePreview.plan.pathMappings.length,
                  links: renamePreview.plan.linkEdits.length,
                })}</p>
                <p>{t('fileOperationPreviewCoverage', {
                  omitted: renamePreview.plan.coverage.omittedSources.length,
                  unresolved: renamePreview.plan.coverage.unresolvedLinks.length,
                })}</p>
                {renamePreview.plan.pathMappings.slice(0, 5).map((mapping) => (
                  <p key={mapping.sourcePath}>{mapping.sourcePath} → {mapping.destinationPath}</p>
                ))}
                {renamePreview.plan.pathMappings.length > 5 && <p>+{renamePreview.plan.pathMappings.length - 5}</p>}
                {renamePreview.plan.linkEdits.slice(0, 5).map((edit, index) => (
                  <p key={`${edit.sourcePathBefore}-${edit.targetRange.startUtf16}-${index}`}>
                    {edit.sourcePathBefore}: {edit.previousTargetLiteral} → {edit.nextTargetLiteral}
                  </p>
                ))}
                {renamePreview.plan.linkEdits.length > 5 && <p>+{renamePreview.plan.linkEdits.length - 5}</p>}
                {renamePreview.plan.issues.slice(0, 3).map((issue, index) => (
                  <p key={`${issue.code}-${issue.path}-${index}`} className="text-amber-600">
                    {issue.path ? `${issue.path}: ` : ''}{t(previewIssueKeys[issue.code])}
                  </p>
                ))}
                <p className="mt-1 text-muted-foreground">{t('fileOperationPreviewRevalidate')}</p>
              </div>
            )}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setRenameOpen(false)} disabled={isRenaming}>{t('cancel')}</Button>
            <Button variant="outline" onClick={() => void handlePreviewRename()} disabled={isRenaming || isPreviewingRename || !newName.trim()}>
              {isPreviewingRename && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('fileOperationPreview')}
            </Button>
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
            onWorkspaceChange={(workspaceId) => { copyPreviewRequestId.current += 1; setIsPreviewingCopy(false); setCopyTargetWorkspaceId(workspaceId); setCopyPreview(null); }}
            onDirChange={(dir) => { copyPreviewRequestId.current += 1; setIsPreviewingCopy(false); setCopyTargetDir(dir); setCopyPreview(null); }}
          />
          {copyPreview && (
            <div className="max-h-48 overflow-auto rounded-md border p-3 text-xs" role="status">
              <p>{t('fileOperationPreviewReadiness', { readiness: t(copyPreview.plan.readiness === 'ready'
                ? 'fileOperationPreviewReady' : 'fileOperationPreviewBlocked') })}</p>
              <p>{t('fileOperationPreviewSummary', {
                paths: copyPreview.plan.pathMappings.length, links: copyPreview.plan.linkEdits.length,
              })}</p>
              <p>{t('fileOperationPreviewCoverage', {
                omitted: copyPreview.plan.coverage.omittedSources.length,
                unresolved: copyPreview.plan.coverage.unresolvedLinks.length,
              })}</p>
              {copyPreview.plan.pathMappings.slice(0, 5).map((mapping) => (
                <p key={mapping.sourcePath}>{mapping.sourcePath} → {mapping.destinationPath}</p>
              ))}
              {copyPreview.plan.pathMappings.length > 5 && <p>+{copyPreview.plan.pathMappings.length - 5}</p>}
              {copyPreview.plan.linkEdits.slice(0, 5).map((edit, index) => (
                <p key={`${edit.sourcePathBefore}-${edit.targetRange.startUtf16}-${index}`}>
                  {edit.sourcePathBefore}: {edit.previousTargetLiteral} → {edit.nextTargetLiteral}
                </p>
              ))}
              {copyPreview.plan.linkEdits.length > 5 && <p>+{copyPreview.plan.linkEdits.length - 5}</p>}
              {copyPreview.plan.issues.slice(0, 3).map((issue, index) => (
                <p key={`${issue.code}-${issue.path}-${index}`} className="text-amber-600">
                  {issue.path ? `${issue.path}: ` : ''}{t(previewIssueKeys[issue.code])}
                </p>
              ))}
              <p className="mt-1 text-muted-foreground">{t('fileOperationPreviewRevalidate')}</p>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="ghost" onClick={() => setCopyToWorkspaceOpen(false)}>
              {t('cancel')}
            </Button>
            <Button variant="outline" onClick={() => void handlePreviewCopyToWorkspace()}
              disabled={isCopyingToWorkspace || isPreviewingCopy || !copyTargetWorkspaceId || selectedCopyPaths.length === 0}>
              {isPreviewingCopy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('fileOperationPreview')}
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
