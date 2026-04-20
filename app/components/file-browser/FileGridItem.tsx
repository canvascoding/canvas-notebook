'use client';

import { useState, useCallback, useRef } from 'react';
import { useFileStore, type FileNode as FileNodeType } from '@/app/store/file-store';
import { cn } from '@/lib/utils';
import { getFileIconComponent } from '@/app/lib/files/file-icons';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { MoreVertical } from 'lucide-react';

interface FileGridItemProps {
  node: FileNodeType;
  onOpenFile: (path: string) => void;
  onOpenDirectory?: (path: string) => void;
  size?: 'sm' | 'lg';
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'heic', 'heif']);

function isImageNode(node: FileNodeType): boolean {
  if (node.type === 'directory') return false;
  const ext = node.name.split('.').pop()?.toLowerCase() || '';
  return IMAGE_EXTENSIONS.has(ext);
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function FileGridItem({ node, onOpenFile, onOpenDirectory, size = 'sm' }: FileGridItemProps) {
  const {
    selectedNode,
    isMultiSelectMode,
    multiSelectPaths,
    toggleMultiSelectPath,
    selectNode,
    toggleDirectory,
    openContextMenu,
  } = useFileStore();

  const isDirectory = node.type === 'directory';
  const isSelected = selectedNode?.path === node.path;
  const isMultiSelected = multiSelectPaths.has(node.path);
  const isRowActive = isSelected || isMultiSelected;
  const showImagePreview = isImageNode(node);

  const [thumbnailError, setThumbnailError] = useState(false);
  const contextMenuJustOpened = useRef(false);

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      if (event.button !== 0) return;
      if (contextMenuJustOpened.current) {
        contextMenuJustOpened.current = false;
        return;
      }
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const shiftKey = event.shiftKey;
      if (ctrlOrMeta || shiftKey) {
        selectNode(node, ctrlOrMeta, shiftKey);
        return;
      }
      if (isMultiSelectMode) {
        toggleMultiSelectPath(node.path);
        return;
      }
      selectNode(node);
      if (isDirectory) {
        if (onOpenDirectory) {
          onOpenDirectory(node.path);
        } else {
          toggleDirectory(node.path);
        }
      } else {
        onOpenFile(node.path);
      }
    },
    [node, selectNode, isMultiSelectMode, toggleMultiSelectPath, isDirectory, onOpenFile, onOpenDirectory, toggleDirectory]
  );

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      contextMenuJustOpened.current = true;
      if (!isMultiSelected) {
        useFileStore.getState().clearMultiSelect();
        selectNode(node);
      }
      openContextMenu(node, { x: event.clientX, y: event.clientY });
    },
    [node, isMultiSelected, selectNode, openContextMenu]
  );

  const thumbnailSrc = showImagePreview && !thumbnailError
    ? toPreviewUrl(node.path, 256, { preset: 'mini' })
    : undefined;

  const isLg = size === 'lg';
  const thumbClass = isLg
    ? 'h-24 w-24 sm:h-28 sm:w-28 md:h-32 md:w-32 lg:h-36 lg:w-36'
    : 'h-20 w-20 sm:h-24 sm:w-24 md:h-28 md:w-28';
  const iconClass = isLg
    ? 'h-14 w-14 sm:h-16 sm:w-16 md:h-20 md:w-20'
    : 'h-12 w-12 sm:h-14 sm:w-14 md:h-16 md:w-16';

  return (
    <div
      className={cn(
        'group relative flex flex-col items-center rounded-lg border transition-all cursor-pointer',
        'hover:bg-accent/50 hover:border-primary/30',
        isRowActive ? 'bg-accent/70 border-primary/50' : 'border-border bg-background',
        isDirectory && 'border-dashed'
      )}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
    >
      <div className="flex w-full items-center justify-end gap-0.5 px-1.5 pt-1.5 min-h-[20px]">
        {isMultiSelectMode ? (
          <button
            onClick={(e) => { e.stopPropagation(); toggleMultiSelectPath(node.path); }}
            className="shrink-0"
          >
            {isMultiSelected ? (
              <span className="flex h-4 w-4 items-center justify-center rounded bg-primary text-primary-foreground text-[10px]">&#10003;</span>
            ) : (
              <span className="h-4 w-4 rounded border border-muted-foreground/40" />
            )}
          </button>
        ) : (
          <button
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              useFileStore.getState().clearMultiSelect();
              selectNode(node);
              openContextMenu(node, { x: e.clientX, y: e.clientY });
            }}
            className="shrink-0 p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent/70 transition-opacity"
            aria-label="More actions"
          >
            <MoreVertical className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
      </div>

      <div className="flex w-full flex-1 items-center justify-center px-3 py-2">
        {showImagePreview && thumbnailSrc ? (
          <div className={cn('relative overflow-hidden rounded-md bg-muted/30', thumbClass)}>
            <img
              src={thumbnailSrc}
              alt={node.name}
              className="h-full w-full object-cover transition-opacity"
              loading="lazy"
              decoding="async"
              onError={() => setThumbnailError(true)}
            />
          </div>
        ) : (
          <div className={cn('relative flex items-center justify-center', thumbClass)}>
            {getFileIconComponent({ name: node.name, path: node.path, type: node.type, isExpanded: false, className: iconClass })}
          </div>
        )}
      </div>

      <div className="w-full px-2 pb-2 pt-0 text-center">
        <p className={cn(
          'truncate text-xs sm:text-sm leading-tight',
          isRowActive ? 'font-medium text-foreground' : 'text-foreground/90'
        )}>
          {node.name}
        </p>
        {!isDirectory && node.size !== undefined && (
          <p className="truncate text-[10px] text-muted-foreground/70">
            {formatFileSize(node.size)}
          </p>
        )}
      </div>
    </div>
  );
}
