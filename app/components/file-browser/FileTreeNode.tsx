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
import { formatCompactFileSize } from '@/app/lib/files/format';

interface FileTreeNodeProps {
  node: FileNodeType;
  depth?: number;
  browserMode?: BrowserMode;
  onNavigateInto?: (node: FileNodeType) => void;
  onOpenFile?: (path: string) => void;
  selectionOrder?: string[];
}

function FileTreeNodeComponent({ node, depth = 0, browserMode = 'tree', onNavigateInto, onOpenFile, selectionOrder }: FileTreeNodeProps) {
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

      selectNode(node, ctrlOrMeta, shiftKey, selectionOrder);
      if (shouldOnlySelect) return;

      if (node.type === 'file') {
        if (onOpenFile) {
          onOpenFile(node.path);
        } else {
          void useFileStore.getState().revealAndLoadFile(node.path, { revealInTree: false });
        }
      }
    },
    [isMultiSelectMode, node, selectNode, selectionOrder, onOpenFile]
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

      selectNode(node, false, false, selectionOrder);
      onNavigateInto?.(node);
    },
    [isMultiSelectMode, node, onNavigateInto, selectNode, selectionOrder]
  );

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

  if (isDirectory) {
    if (browserMode === 'list') {
      return (
        <SidebarMenuItem>
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
                isRowActive && 'text-foreground'
              )}
              onClick={handleListDirectoryClick}
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
              ) : (
                getFileIcon()
              )}
              <span className="min-w-0 flex-1 truncate text-sm" title={node.name}>{displayName}</span>
            </SidebarMenuButton>
            {isMultiSelectMode ? (
              <button
                onClick={handleCheckboxClick}
                className="ml-auto shrink-0 p-1 hover:bg-accent/70"
              >
                {isMultiSelected ? (
                  <CheckSquare className="h-4 w-4 text-primary" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            ) : (
              <button
                onClick={handleDotsClickForListMode}
                className={cn(
                  'ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/70 hover:text-foreground transition-opacity',
                  'opacity-100 md:opacity-0 md:group-hover:opacity-100'
                )}
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
        <SidebarMenuItem>
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
                <span className="min-w-0 flex-1 truncate text-sm" title={node.name}>{displayName}</span>
              </SidebarMenuButton>
            </CollapsibleTrigger>
            {isMultiSelectMode ? (
              <button
                onClick={handleCheckboxClick}
                className="ml-auto shrink-0 p-1 hover:bg-accent/70"
              >
                {isMultiSelected ? (
                  <CheckSquare className="h-4 w-4 text-primary" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            ) : (
              <button
                onClick={handleDotsClick}
                className={cn(
                  'ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/70 hover:text-foreground transition-opacity',
                  'opacity-100 md:opacity-0 md:group-hover:opacity-100'
                )}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            )}
          </div>
        </SidebarMenuItem>
        {showChildren && (
          <CollapsibleContent>
            <SidebarMenuSub className="mx-0 mr-0 border-l-0 px-0 py-0 pr-0 md:ml-3.5 md:border-l md:pl-2.5">
              {isLoading ? (
                <div className="flex items-center gap-2 py-1 pl-[var(--tree-mobile-padding)] pr-2 text-xs text-muted-foreground md:px-2" style={childPaddingStyle}>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Loading...</span>
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
    <SidebarMenuItem>
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
            isRowActive && 'text-foreground'
          )}
          onClick={handleSelect}
        >
          <span className="h-4 w-4 shrink-0 pl-3 md:pl-6" />
          {getFileIcon()}
          <span className="min-w-0 flex-1 truncate text-sm" title={node.name}>{displayName}</span>
          {isPublic && (
            <Globe2
              className="h-3.5 w-3.5 shrink-0 text-amber-600"
              aria-label="Public"
            />
          )}
          {!isDirectory && node.size !== undefined && (
            <span className="ml-auto hidden shrink-0 text-xs text-muted-foreground md:inline">
              {formatCompactFileSize(node.size)}
            </span>
          )}
        </SidebarMenuButton>
        {isMultiSelectMode ? (
          <button
            onClick={handleCheckboxClick}
            className="ml-auto shrink-0 p-1 hover:bg-accent/70"
          >
            {isMultiSelected ? (
              <CheckSquare className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        ) : (
          <button
            onClick={handleDotsClick}
            className={cn(
              'ml-auto shrink-0 rounded p-1 text-muted-foreground hover:bg-accent/70 hover:text-foreground transition-opacity',
              'opacity-100 md:opacity-0 md:group-hover:opacity-100'
            )}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        )}
      </div>
    </SidebarMenuItem>
  );
}

export const FileTreeNode = memo(FileTreeNodeComponent);
