'use client';

import { useCallback } from 'react';
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  FileCode,
  FileText,
  Image as ImageIcon,
  FileVideo,
  FileAudio,
  FileSpreadsheet,
  FileDigit,
  Database,
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

interface FileTreeNodeProps {
  node: FileNodeType;
  depth?: number;
}

export function FileTreeNode({ node, depth = 0 }: FileTreeNodeProps) {
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

  // Sync internal state with external expanded state for directories
  const handleToggle = useCallback(() => {
    if (isDirectory) {
      toggleDirectory(node.path);
    }
  }, [isDirectory, node.path, toggleDirectory]);

  const handleSelect = useCallback(
    (event: React.MouseEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      selectNode(node, ctrlOrMeta);
      if (node.type === 'file') {
        loadFile(node.path, true);
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
    if (isDirectory) {
      return isExpanded ? (
        <FolderOpen className="h-4 w-4 text-blue-400" />
      ) : (
        <Folder className="h-4 w-4 text-blue-400" />
      );
    }

    const ext = node.name.split('.').pop()?.toLowerCase() || '';

    // Code & Scripts
    if (
      ['js', 'jsx', 'ts', 'tsx', 'html', 'css', 'scss', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'php', 'sh', 'bash', 'zsh', 'yml', 'yaml', 'toml'].includes(ext)
    ) {
      return <FileCode className="h-4 w-4 text-emerald-400" />;
    }

    // Documents
    if (['md', 'mdx', 'markdown', 'txt', 'log'].includes(ext)) {
      return <FileText className="h-4 w-4 text-muted-foreground" />;
    }
    if (ext === 'pdf') {
      return <FileText className="h-4 w-4 text-rose-400" />;
    }
    if (['doc', 'docx'].includes(ext)) {
      return <FileText className="h-4 w-4 text-blue-500" />;
    }

    // Data & Config
    if (['json', 'env', 'gitignore'].includes(ext)) {
      return <FileDigit className="h-4 w-4 text-yellow-400" />;
    }
    if (['sql', 'db', 'sqlite'].includes(ext)) {
      return <Database className="h-4 w-4 text-orange-400" />;
    }

    // Spreadsheet
    if (['xls', 'xlsx', 'csv'].includes(ext)) {
      return <FileSpreadsheet className="h-4 w-4 text-green-500" />;
    }

    // Media
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico'].includes(ext)) {
      return <ImageIcon className="h-4 w-4 text-purple-400" />;
    }
    if (['mp4', 'webm', 'ogv', 'mov'].includes(ext)) {
      return <FileVideo className="h-4 w-4 text-pink-400" />;
    }
    if (['wav', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'flac'].includes(ext)) {
      return <FileAudio className="h-4 w-4 text-cyan-400" />;
    }

    return <File className="h-4 w-4 text-muted-foreground" />;
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
              'group relative flex w-full items-center rounded-md px-2 py-0.5 text-foreground transition-colors',
              isRowActive ? 'bg-accent/70' : 'hover:bg-accent/50'
            )}
            onContextMenu={handleContextMenu}
          >
            {isMultiSelectMode && (
              <button
                onClick={handleCheckboxClick}
                className="mr-1 flex-shrink-0 rounded-sm p-1 hover:bg-accent/70"
              >
                {isMultiSelected ? (
                  <CheckSquare className="h-4 w-4 text-sky-400" />
                ) : (
                  <Square className="h-4 w-4 text-muted-foreground" />
                )}
              </button>
            )}
            <CollapsibleTrigger asChild>
              <SidebarMenuButton
                className={cn(
                  'flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
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
          <SidebarMenuSub className="mr-0 pr-0">
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
          'group relative flex w-full items-center rounded-md px-2 py-0.5 text-foreground transition-colors',
          isRowActive ? 'bg-accent/70' : 'hover:bg-accent/50'
        )}
        onContextMenu={handleContextMenu}
      >
        {isMultiSelectMode && (
          <button
            onClick={handleCheckboxClick}
            className="mr-1 flex-shrink-0 rounded-sm p-1 hover:bg-accent/70"
          >
            {isMultiSelected ? (
              <CheckSquare className="h-4 w-4 text-sky-400" />
            ) : (
              <Square className="h-4 w-4 text-muted-foreground" />
            )}
          </button>
        )}
        <SidebarMenuButton
          className={cn(
            'flex-1 justify-start gap-2 bg-transparent text-foreground hover:!bg-transparent hover:text-foreground active:!bg-transparent data-[state=open]:hover:!bg-transparent',
            isRowActive && 'text-foreground'
          )}
          onClick={handleSelect}
        >
          {/* Spacer for alignment with folders */}
          {isDirectory ? (
            <span className="h-4 w-4 shrink-0" />
          ) : (
            <span className="h-4 w-4 shrink-0 pl-6" />
          )}
          {getFileIcon()}
          <span className="flex-1 truncate text-sm">{node.name}</span>
          {!isDirectory && node.size !== undefined && (
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
