'use client';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen } from 'lucide-react';
import { FileNode as FileNodeType } from '@/app/store/file-store';
import { cn } from '@/lib/utils';
import { FileContextMenu } from './FileContextMenu';

interface FileNodeProps {
  node: FileNodeType;
  depth: number;
  expandedDirs: Set<string>;
  selectedPath: string | null;
  onToggle: (path: string) => void;
  onSelect: (node: FileNodeType) => void;
}

export function FileNode({
  node,
  depth,
  expandedDirs,
  selectedPath,
  onToggle,
  onSelect,
}: FileNodeProps) {
  const isDirectory = node.type === 'directory';
  const hasChildren = node.children && node.children.length > 0;
  const isExpanded = expandedDirs.has(node.path);
  const isSelected = selectedPath === node.path;

  const handleClick = () => {
    onSelect(node);
    if (isDirectory) {
      onToggle(node.path);
    }
  };

  const handleContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    onSelect(node);
    // Trigger the context menu programmatically
    const moreButton = event.currentTarget.querySelector('[aria-label="File actions"]') as HTMLButtonElement;
    if (moreButton) {
      moreButton.click();
    }
  };

  const getFileIcon = () => {
    if (isDirectory) {
      return isExpanded ? (
        <FolderOpen className="w-4 h-4 text-blue-400" />
      ) : (
        <Folder className="w-4 h-4 text-blue-400" />
      );
    }
    return <File className="w-4 h-4 text-slate-400" />;
  };

  const formatSize = (bytes?: number) => {
    if (!bytes) return '';
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  };

  return (
    <div>
      <div
        className={cn(
          'group flex items-center gap-1 px-2 py-1 cursor-pointer hover:bg-slate-700/50 rounded',
          isSelected && 'bg-slate-600 hover:bg-slate-600',
          'transition-colors duration-150'
        )}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        {isDirectory ? (
          <span className="flex-shrink-0">
            {isExpanded ? (
              <ChevronDown className="w-4 h-4 text-slate-400" />
            ) : (
              <ChevronRight className="w-4 h-4 text-slate-400" />
            )}
          </span>
        ) : (
          <span className="w-4" />
        )}

        {getFileIcon()}

        <span className="flex-1 truncate text-sm text-slate-200">
          {node.name}
        </span>

        {!isDirectory && node.size !== undefined && (
          <span className="ml-auto text-xs text-slate-500">
            {formatSize(node.size)}
          </span>
        )}

        <FileContextMenu node={node} />
      </div>

      {isDirectory && isExpanded && hasChildren && (
        <div>
          {node.children!.map((child) => (
            <FileNodeComponent
              key={child.path}
              node={child}
              depth={depth + 1}
              expandedDirs={expandedDirs}
              selectedPath={selectedPath}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// Wrapper to enable recursion
function FileNodeComponent(props: FileNodeProps) {
  return <FileNode {...props} />;
}
