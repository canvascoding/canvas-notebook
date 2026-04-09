'use client';

import { useCallback } from 'react';
import {
  ChevronRight,
  Square,
  CheckSquare,
} from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarMenuSub,
} from '@/components/ui/sidebar';
import { useFileStore, FileNode as FileNodeType } from '@/app/store/file-store';
import { FileContextMenu } from './FileContextMenu';
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
  } = useFileStore();

  const isDirectory = node.type === 'directory';
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedNode?.path === node.path;
  const isMultiSelected = multiSelectPaths.includes(node.path);
  const isRowActive = isSelected || isMultiSelected;
  const rowPaddingStyle = isMobile
    ? { paddingLeft: `${8 + Math.min(depth, 4) * 12}px` }
    : undefined;

  // Sync internal state with external expanded state for directories
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
        window.dispatchEvent(
          new CustomEvent('notebook-mobile-file-opened', {
            detail: { path: node.path },
          })
        );
        window.dispatchEvent(
          new CustomEvent('notebook-mobile-surface', {
            detail: { surface: 'editor' },
          })
        );
      }
    },
    [node, selectNode, loadFile]
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

  if (isDirectory && hasChildren) {
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
            {isMultiSelectMode && (
              <button
                onClick={handleCheckboxClick}
                className="mr-1 flex-shrink-0 p-1 hover:bg-accent/70"
              >
                {isMultiSelected ? (
                  <CheckSquare className="h-4 w-4 text-primary" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            )}
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                className={cn(
                  'flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
                  isMobile && 'min-h-[44px] py-2',
                  isRowActive && 'text-foreground'
                )}
                onClick={handleSelect}
              >
                <ChevronRight
                  className={cn(
                    'h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200',
                    isExpanded && 'rotate-90'
                  )}
                />
                {getFileIcon()}
                <span className="flex-1 truncate text-sm">{node.name}</span>
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <FileContextMenu node={node} isRowActive={isRowActive} />
          </div>
        </SidebarMenuItem>
        <CollapsibleContent>
          <SidebarMenuSub className={cn('mr-0 pr-0', isMobile && 'mx-0 border-l-0 px-0 py-0')}>
            {node.children!.map((child) => (
              <FileTreeNode key={child.path} node={child} depth={depth + 1} />
            ))}
          </SidebarMenuSub>
        </CollapsibleContent>
      </Collapsible>
    );
  }

  // File or empty directory
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
        {isMultiSelectMode && (
          <button
            onClick={handleCheckboxClick}
            className="mr-1 flex-shrink-0 p-1 hover:bg-accent/70"
          >
            {isMultiSelected ? (
              <CheckSquare className="h-4 w-4 text-primary" />
            ) : (
              <Square className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        )}
        <SidebarMenuButton
          className={cn(
            'flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
            isMobile && 'min-h-[44px] py-2',
            isRowActive && 'text-foreground'
          )}
          onClick={handleSelect}
        >
          {/* Spacer for alignment with folders */}
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
        <FileContextMenu node={node} isRowActive={isRowActive} />
      </div>
    </SidebarMenuItem>
  );
}
