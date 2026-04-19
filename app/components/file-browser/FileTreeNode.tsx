'use client';

import { useCallback } from 'react';
import {
  ChevronRight,
  Square,
  CheckSquare,
  Loader2,
  MoreVertical,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
} from '@/components/ui/sidebar';
import { useFileStore, FileNode as FileNodeType } from '@/app/store/file-store';
import { cn } from '@/lib/utils';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { useIsMobile } from '@/hooks/use-mobile';

interface FileTreeNodeProps {
  node: FileNodeType;
  depth?: number;
}

export function FileTreeNode({ node, depth = 0 }: FileTreeNodeProps) {
  const isMobile = useIsMobile();
  const {
    expandedDirs,
    selectedNode,
    toggleDirectory,
    selectNode,
    loadFile,
    isMultiSelectMode,
    multiSelectPaths,
    toggleMultiSelectPath,
    openContextMenu,
    mobileFileOpened,
    loadingDirs,
  } = useFileStore();

  const isDirectory = node.type === 'directory';
  const isExpanded = expandedDirs.has(node.path);
  const isLoading = loadingDirs.has(node.path);
  const isSelected = selectedNode?.path === node.path;
  const isMultiSelected = multiSelectPaths.has(node.path);
  const isRowActive = isSelected || isMultiSelected;
  const childNodes = node.children ?? [];
  const rowPaddingStyle = isMobile
    ? { paddingLeft: `${8 + Math.min(depth, 4) * 12}px` }
    : undefined;

  const handleToggle = useCallback(() => {
    if (isDirectory) {
      toggleDirectory(node.path);
    }
  }, [isDirectory, node.path, toggleDirectory]);

  const handleSelect = useCallback(
    (event: React.MouseEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const shiftKey = event.shiftKey;
      selectNode(node, ctrlOrMeta, shiftKey);
      if (node.type === 'file') {
        loadFile(node.path, true);
        mobileFileOpened();
      }
    },
    [node, selectNode, loadFile, mobileFileOpened]
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
    if (!isMultiSelected) {
      useFileStore.getState().clearMultiSelect();
      selectNode(node);
    }
    openContextMenu(node, { x: event.clientX, y: event.clientY });
  };

  const getFileIcon = () => {
    return getFileIconComponent({
      name: node.name,
      path: node.path,
      type: isDirectory ? 'directory' : 'file',
      isExpanded,
    });
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  if (isDirectory) {
    const showChildren = isExpanded && (childNodes.length > 0 || isLoading);
    return (
      <Collapsible open={isExpanded} onOpenChange={handleToggle}>
        <SidebarMenuItem>
          <div
            className={cn(
              'group relative flex w-full items-center px-2 text-foreground transition-colors',
              isMobile ? 'py-1.5' : 'py-0.5',
              isRowActive ? 'bg-accent/70' : 'hover:bg-accent/50'
            )}
            style={rowPaddingStyle}
            onContextMenu={handleContextMenu}
          >
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                className={cn(
                  'flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
                  isMobile && 'min-h-[44px] py-2',
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
                <span className="flex-1 truncate text-sm">{node.name}</span>
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
                  isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
                )}
              >
                <MoreVertical className="h-4 w-4" />
              </button>
            )}
          </div>
        </SidebarMenuItem>
        {showChildren && (
          <CollapsibleContent>
            <SidebarMenuSub className={cn('mr-0 pr-0', isMobile && 'mx-0 border-l-0 px-0 py-0')}>
              {isLoading ? (
                <div className="flex items-center gap-2 px-2 py-1 text-xs text-muted-foreground" style={isMobile ? { paddingLeft: `${8 + Math.min(depth + 1, 4) * 12}px` } : undefined}>
                  <Loader2 className="h-3 w-3 animate-spin" />
                  <span>Loading...</span>
                </div>
              ) : (
                childNodes.map((child) => (
                  <FileTreeNode key={child.path} node={child} depth={depth + 1} />
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
        className={cn(
          'group relative flex w-full items-center px-2 text-foreground transition-colors',
          isMobile ? 'py-1.5' : 'py-0.5',
          isRowActive ? 'bg-accent/70' : 'hover:bg-accent/50'
        )}
        style={rowPaddingStyle}
        onContextMenu={handleContextMenu}
      >
        <SidebarMenuButton
          className={cn(
            'flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
            isMobile && 'min-h-[44px] py-2',
            isRowActive && 'text-foreground'
          )}
          onClick={handleSelect}
        >
          {isDirectory ? (
            <span className="h-4 w-4 shrink-0" />
          ) : (
            <span className={cn('h-4 w-4 shrink-0', isMobile ? 'pl-3' : 'pl-6')} />
          )}
          {getFileIcon()}
          <span className="flex-1 truncate text-sm">{node.name}</span>
          {!isMobile && !isDirectory && node.size !== undefined && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">
              {formatSize(node.size)}
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
              isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'
            )}
          >
            <MoreVertical className="h-4 w-4" />
          </button>
        )}
      </div>
    </SidebarMenuItem>
  );
}
