'use client';

import { memo, useCallback, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ChevronRight,
  Square,
  CheckSquare,
  AlertCircle,
  Globe2,
  Loader2,
  MoreVertical,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
} from '@/components/ui/sidebar';
import { useFileStore } from '@/app/store/file-store';
import type { BrowserMode, FileNode as FileNodeType } from '@/app/lib/files/types';
import { cn } from '@/lib/utils';
import { getFileIconComponent, isImageFile } from '@/app/lib/files/file-icons';
import { getFileDisplayName } from '@/app/lib/files/display-name';
import { ImageThumbnailIcon } from '@/app/components/shared/ImageThumbnailIcon';
import { formatCompactFileDate, formatCompactFileSize } from '@/app/lib/files/format';
import { getParentDirectory } from '@/app/lib/files/path-utils';
import { useLocale, useTranslations } from 'next-intl';

interface FileTreeNodeProps {
  node: FileNodeType;
  depth?: number;
  browserMode?: BrowserMode;
  onNavigateInto?: (node: FileNodeType) => void;
  onOpenFile?: (path: string) => void;
  selectionOrder?: string[];
  showPath?: boolean;
  openOnSingleClick?: boolean;
  showListMetadata?: boolean;
}

function FileTreeNodeComponent({
  node,
  depth = 0,
  browserMode = 'tree',
  onNavigateInto,
  onOpenFile,
  selectionOrder,
  showPath = false,
  openOnSingleClick = true,
  showListMetadata = false,
}: FileTreeNodeProps) {
  const t = useTranslations('notebook');
  const locale = useLocale();
  const {
    isExpanded,
    isLoading,
    directoryError,
    isSelected,
    isMultiSelected,
    toggleDirectory,
    selectNode,
    isMultiSelectMode,
    toggleMultiSelectPath,
    openContextMenu,
  } = useFileStore(useShallow((state) => ({
    isExpanded: state.expandedDirs.has(node.path),
    isLoading: state.loadingDirs.has(node.path),
    directoryError: state.directoryErrors[node.path] ?? null,
    isSelected: state.selectedNode?.path === node.path,
    isMultiSelected: state.multiSelectPaths.has(node.path),
    toggleDirectory: state.toggleDirectory,
    selectNode: state.selectNode,
    isMultiSelectMode: state.isMultiSelectMode,
    toggleMultiSelectPath: state.toggleMultiSelectPath,
    openContextMenu: state.openContextMenu,
  })));

  const isDirectory = node.type === 'directory';
  const isRowActive = isSelected || isMultiSelected;
  const isPublic = node.type === 'file' && node.publicShare?.status === 'active';
  const hasLoadedChildren = Array.isArray(node.children);
  const childNodes = node.children ?? [];
  const displayName = getFileDisplayName(node);
  const extensionIndex = node.name.lastIndexOf('.');
  const typeLabel = isDirectory
    ? t('folder')
    : extensionIndex > 0
      ? node.name.slice(extensionIndex + 1).toUpperCase()
      : t('file');
  const modifiedLabel = formatCompactFileDate(node.modified, locale);
  const parentPath = getParentDirectory(node.path);
  const nameContent = (
    <span className="min-w-0 flex-1">
      <span className="block truncate text-sm" title={showPath ? node.path : node.name}>{displayName}</span>
      {showPath && (
        <span className="block truncate text-[10px] leading-tight text-muted-foreground" title={parentPath}>
          {parentPath === '.' ? t('workspaceRoot') : parentPath}
        </span>
      )}
    </span>
  );
  const rowPaddingStyle = {
    '--tree-mobile-padding': `${8 + Math.min(depth, 4) * 12}px`,
  } as CSSProperties;
  const childPaddingStyle = {
    '--tree-mobile-padding': `${8 + Math.min(depth + 1, 4) * 12}px`,
  } as CSSProperties;

  const handleToggle = useCallback(() => {
    if (isDirectory) {
      toggleDirectory(node.path);
    }
  }, [isDirectory, node.path, toggleDirectory]);

  const handleSelect = useCallback(
    (event: React.MouseEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const shiftKey = event.shiftKey;
      const shouldOnlySelect = ctrlOrMeta || shiftKey || isMultiSelectMode;

      if (shouldOnlySelect) {
        event.preventDefault();
        event.stopPropagation();
      }

      const shouldOpen = browserMode === 'tree'
        || openOnSingleClick
        || window.matchMedia('(hover: none), (pointer: coarse), (max-width: 767px)').matches;
      selectNode(node, ctrlOrMeta, shiftKey, selectionOrder, !shouldOpen);
      if (shouldOnlySelect) return;
      if (!shouldOpen) return;

      if (node.type === 'file') {
        if (onOpenFile) {
          onOpenFile(node.path);
        } else {
          void useFileStore.getState().revealAndLoadFile(node.path, { revealInTree: false });
        }
      }
    },
    [browserMode, isMultiSelectMode, node, onOpenFile, openOnSingleClick, selectNode, selectionOrder]
  );

  const handleListDirectoryClick = useCallback(
    (event: React.MouseEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const shiftKey = event.shiftKey;
      const shouldOnlySelect = ctrlOrMeta || shiftKey || isMultiSelectMode;

      if (shouldOnlySelect) {
        event.preventDefault();
        event.stopPropagation();
        selectNode(node, ctrlOrMeta, shiftKey, selectionOrder);
        return;
      }

      const prefersDirectOpen = openOnSingleClick
        || window.matchMedia('(hover: none), (pointer: coarse), (max-width: 767px)').matches;
      if (!prefersDirectOpen) {
        selectNode(node, false, false, selectionOrder, true);
        return;
      }

      selectNode(node, false, false, selectionOrder);
      onNavigateInto?.(node);
    },
    [isMultiSelectMode, node, onNavigateInto, openOnSingleClick, selectNode, selectionOrder]
  );

  const handleListDoubleClick = useCallback((event: React.MouseEvent) => {
    const prefersDirectOpen = openOnSingleClick
      || window.matchMedia('(hover: none), (pointer: coarse), (max-width: 767px)').matches;
    if (
      browserMode !== 'list'
      || prefersDirectOpen
      || isMultiSelectMode
      || event.ctrlKey
      || event.metaKey
      || event.shiftKey
    ) return;
    if (isDirectory) {
      onNavigateInto?.(node);
      return;
    }
    if (onOpenFile) onOpenFile(node.path);
    else void useFileStore.getState().revealAndLoadFile(node.path, { revealInTree: false });
  }, [browserMode, isDirectory, isMultiSelectMode, node, onNavigateInto, onOpenFile, openOnSingleClick]);

  const handleListKeyDown = useCallback((event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (browserMode !== 'list' || event.key !== 'Enter' || isMultiSelectMode) return;
    event.preventDefault();
    if (isDirectory) {
      onNavigateInto?.(node);
      return;
    }
    if (onOpenFile) onOpenFile(node.path);
    else void useFileStore.getState().revealAndLoadFile(node.path, { revealInTree: false });
  }, [browserMode, isDirectory, isMultiSelectMode, node, onNavigateInto, onOpenFile]);

  const handleCheckboxClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    toggleMultiSelectPath(node.path);
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isMultiSelected) {
      useFileStore.getState().clearMultiSelect();
      selectNode(node);
    }
    openContextMenu(node, { x: event.clientX, y: event.clientY });
  };

  const handleDotsClick = (event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (!isMultiSelected) {
      useFileStore.getState().clearMultiSelect();
      selectNode(node);
    }
    openContextMenu(node, { x: event.clientX, y: event.clientY });
  };

  const handleContextMenuForListMode = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!isMultiSelected) {
      useFileStore.getState().clearMultiSelect();
    }
    openContextMenu(node, { x: event.clientX, y: event.clientY });
  };

  const handleDotsClickForListMode = (event: React.MouseEvent) => {
    event.stopPropagation();
    event.preventDefault();
    if (!isMultiSelected) {
      useFileStore.getState().clearMultiSelect();
    }
    openContextMenu(node, { x: event.clientX, y: event.clientY });
  };

  const getFileIcon = () => {
    if (!isDirectory && isImageFile(node.name)) {
      return (
        <ImageThumbnailIcon
          path={node.path}
          name={node.name}
          className="h-5 w-5 rounded-sm"
          fallbackIcon={getFileIconComponent({
            name: node.name,
            path: node.path,
            type: 'file',
          })}
        />
      );
    }

    return getFileIconComponent({
      name: node.name,
      path: node.path,
      type: isDirectory ? 'directory' : 'file',
      isExpanded,
    });
  };

  const renderListContent = (icon: React.ReactNode) => (
    <>
      <span className={showListMetadata ? 'flex min-w-0 items-center gap-2' : 'contents'}>
        {icon}
        {nameContent}
        {isPublic && (
          <Globe2
            className="h-3.5 w-3.5 shrink-0 text-amber-600"
            aria-label={t('publicShareBadge')}
          />
        )}
      </span>
      {showListMetadata && (
        <>
          <span className="hidden truncate text-xs text-muted-foreground md:block" title={typeLabel}>
            {typeLabel}
          </span>
          <span className="hidden truncate text-xs text-muted-foreground md:block" title={modifiedLabel}>
            {modifiedLabel || '—'}
          </span>
          <span className="hidden truncate text-right text-xs text-muted-foreground md:block">
            {!isDirectory && node.size !== undefined ? formatCompactFileSize(node.size) : '—'}
          </span>
        </>
      )}
    </>
  );

  if (isDirectory) {
    if (browserMode === 'list') {
      return (
        <SidebarMenuItem role="none">
          <div
            data-file-path={node.path}
            className={cn(
              'group relative flex w-full min-w-0 items-center px-2 text-foreground transition-colors',
              'py-1.5 md:py-0.5',
              isRowActive ? 'bg-accent/70' : 'hover:bg-accent/50',
              isPublic && 'border-l-2 border-amber-500 bg-amber-500/10'
            )}
            onContextMenu={handleContextMenuForListMode}
          >
            <SidebarMenuButton
              className={cn(
                'min-w-0 flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
                'min-h-[44px] py-2 md:min-h-0 md:py-0',
                showListMetadata && 'md:grid md:grid-cols-[minmax(0,1fr)_7rem_10rem_5rem] md:gap-3',
                isRowActive && 'text-foreground'
              )}
              onClick={handleListDirectoryClick}
              onDoubleClick={handleListDoubleClick}
              onKeyDown={handleListKeyDown}
              role="option"
              aria-selected={isRowActive}
              data-file-primary-action
            >
              {renderListContent(isLoading ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                getFileIcon()
              ))}
            </SidebarMenuButton>
            {isMultiSelectMode ? (
              <button
                type="button"
                onClick={handleCheckboxClick}
                className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7 md:w-7"
                aria-label={t(isMultiSelected ? 'deselectItem' : 'selectItem', { name: displayName })}
                aria-pressed={isMultiSelected}
                data-file-action
              >
                {isMultiSelected ? (
                  <CheckSquare className="h-4 w-4 text-primary" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDotsClickForListMode}
                className={cn(
                  'ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-opacity md:h-7 md:w-7',
                  'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100'
                )}
                aria-label={t('moreActionsFor', { name: displayName })}
                title={t('moreActionsFor', { name: displayName })}
                data-file-action
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            )}
          </div>
        </SidebarMenuItem>
      );
    }

    const showChildren = isExpanded && (hasLoadedChildren || isLoading || Boolean(directoryError));
    return (
      <Collapsible open={isExpanded} onOpenChange={handleToggle}>
        <SidebarMenuItem role="none">
          <div
            data-file-path={node.path}
          className={cn(
            'group relative flex w-full min-w-0 items-center px-2 text-foreground transition-colors',
            'py-1.5 pl-[var(--tree-mobile-padding)] md:py-0.5 md:pl-2',
            isRowActive ? 'bg-accent/70' : 'hover:bg-accent/50',
            isPublic && 'border-l-2 border-amber-500 bg-amber-500/10'
          )}
            style={rowPaddingStyle}
            onContextMenu={handleContextMenu}
          >
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                className={cn(
                  'min-w-0 flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
                  'min-h-[44px] py-2 md:min-h-0 md:py-0',
                  isRowActive && 'text-foreground'
                )}
                onClick={handleSelect}
                role="treeitem"
                aria-level={depth + 1}
                aria-expanded={isExpanded}
                aria-selected={isRowActive}
                data-file-primary-action
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                ) : (
                  <ChevronRight
                    className={cn(
                      'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                      isExpanded && 'rotate-90'
                    )}
                  />
                )}
                {getFileIcon()}
                {nameContent}
              </SidebarMenuButton>
            </CollapsibleTrigger>
            {isMultiSelectMode ? (
              <button
                type="button"
                onClick={handleCheckboxClick}
                className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7 md:w-7"
                aria-label={t(isMultiSelected ? 'deselectItem' : 'selectItem', { name: displayName })}
                aria-pressed={isMultiSelected}
                data-file-action
              >
                {isMultiSelected ? (
                  <CheckSquare className="h-4 w-4 text-primary" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDotsClick}
                className={cn(
                  'ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-opacity md:h-7 md:w-7',
                  'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100'
                )}
                aria-label={t('moreActionsFor', { name: displayName })}
                title={t('moreActionsFor', { name: displayName })}
                data-file-action
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            )}
          </div>
        </SidebarMenuItem>
        {showChildren && (
          <CollapsibleContent>
            <SidebarMenuSub className="mx-0 mr-0 border-l-0 px-0 py-0 pr-0 md:ml-3.5 md:border-l md:pl-2.5" role="group">
              {isLoading ? (
                <div className="flex items-center gap-2 py-1 pl-[var(--tree-mobile-padding)] pr-2 text-xs text-muted-foreground md:px-2" style={childPaddingStyle}>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>{t('loadingFolder')}</span>
                </div>
              ) : directoryError ? (
                <button
                  type="button"
                  className="flex w-full items-start gap-2 py-1 pl-[var(--tree-mobile-padding)] pr-2 text-left text-xs text-destructive hover:bg-destructive/10 md:px-2"
                  style={childPaddingStyle}
                  onClick={() => void useFileStore.getState().loadSubdirectory(node.path, true, false)}
                  title={directoryError}
                >
                  <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                  <span className="line-clamp-2">{directoryError}</span>
                </button>
              ) : (
                childNodes.map((child) => (
                  <FileTreeNode
                    key={child.path}
                    node={child}
                    depth={depth + 1}
                    browserMode={browserMode}
                    onNavigateInto={onNavigateInto}
                    onOpenFile={onOpenFile}
                    selectionOrder={selectionOrder}
                    showPath={showPath}
                    openOnSingleClick={openOnSingleClick}
                    showListMetadata={showListMetadata}
                  />
                ))
              )}
            </SidebarMenuSub>
          </CollapsibleContent>
        )}
      </Collapsible>
    );
  }

  return (
    <SidebarMenuItem role="none">
      <div
        data-file-path={node.path}
          className={cn(
            'group relative flex w-full min-w-0 items-center px-2 text-foreground transition-colors',
            'py-1.5 pl-[var(--tree-mobile-padding)] md:py-0.5 md:pl-2',
            isRowActive ? 'bg-accent/70' : 'hover:bg-accent/50',
            isPublic && 'border-l-2 border-amber-500 bg-amber-500/10'
          )}
        style={rowPaddingStyle}
        onContextMenu={handleContextMenu}
      >
        <SidebarMenuButton
          className={cn(
            'min-w-0 flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
            'min-h-[44px] py-2 md:min-h-0 md:py-0',
            browserMode === 'list' && showListMetadata && 'md:grid md:grid-cols-[minmax(0,1fr)_7rem_10rem_5rem] md:gap-3',
            isRowActive && 'text-foreground'
          )}
          onClick={handleSelect}
          onDoubleClick={handleListDoubleClick}
          onKeyDown={handleListKeyDown}
          role={browserMode === 'list' ? 'option' : 'treeitem'}
          aria-level={browserMode === 'tree' ? depth + 1 : undefined}
          aria-selected={isRowActive}
          data-file-primary-action
        >
          {browserMode === 'list' ? renderListContent(getFileIcon()) : (
            <>
              <span className="h-4 w-4 shrink-0 pl-3 md:pl-6" />
              {getFileIcon()}
              {nameContent}
            </>
          )}
          {browserMode === 'tree' && isPublic && (
            <Globe2
              className="h-3.5 w-3.5 shrink-0 text-amber-600"
              aria-label={t('publicShareBadge')}
            />
          )}
          {!showListMetadata && !isDirectory && node.size !== undefined && (
            <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground md:inline">
              {formatCompactFileSize(node.size)}
            </span>
          )}
        </SidebarMenuButton>
        {isMultiSelectMode ? (
          <button
            type="button"
            onClick={handleCheckboxClick}
            className="ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded hover:bg-accent/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 md:h-7 md:w-7"
            aria-label={t(isMultiSelected ? 'deselectItem' : 'selectItem', { name: displayName })}
            aria-pressed={isMultiSelected}
            data-file-action
          >
            {isMultiSelected ? (
              <CheckSquare className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        ) : (
          <button
            type="button"
            onClick={handleDotsClick}
            className={cn(
              'ml-auto flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 transition-opacity md:h-7 md:w-7',
              'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100'
            )}
            aria-label={t('moreActionsFor', { name: displayName })}
            title={t('moreActionsFor', { name: displayName })}
            data-file-action
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        )}
      </div>
    </SidebarMenuItem>
  );
}

export const FileTreeNode = memo(FileTreeNodeComponent);
