'use client';

import { useState, useCallback } from 'react';
import { useFileStore, type FileNode as FileNodeType } from '@/app/store/file-store';
import { cn } from '@/lib/utils';
import { getFileIconComponent, isImageFile } from '@/app/lib/files/file-icons';
import { toPreviewUrl } from '@/app/lib/utils/media-url';
import { MoreVertical } from 'lucide-react';

interface FileGridItemProps {
  node: FileNodeType;
  onPreviewImage: (path: string) => void;
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

export function FileGridItem({ node, onPreviewImage }: FileGridItemProps) {
  const {
    selectedNode,
    isMultiSelectMode,
    multiSelectPaths,
    toggleMultiSelectPath,
    selectNode,
    loadFile,
    toggleDirectory,
    mobileFileOpened,
    openContextMenu,
  } = useFileStore();

  const isDirectory = node.type === 'directory';
  const isSelected = selectedNode?.path === node.path;
  const isMultiSelected = multiSelectPaths.has(node.path);
  const isRowActive = isSelected || isMultiSelected;
  const showImagePreview = isImageNode(node);

  const [thumbnailError, setThumbnailError] = useState(false);

  const handleClick = useCallback(
    (event: React.MouseEvent) => {
      const ctrlOrMeta = event.ctrlKey || event.metaKey;
      const shiftKey = event.shiftKey;
      selectNode(node, ctrlOrMeta, shiftKey);
    },
    [node, selectNode]
  );

  const handleDoubleClick = useCallback(() => {
    if (isDirectory) {
      toggleDirectory(node.path);
    } else if (showImagePreview) {
      onPreviewImage(node.path);
    } else {
      loadFile(node.path, true);
      mobileFileOpened();
    }
  }, [isDirectory, showImagePreview, node.path, toggleDirectory, onPreviewImage, loadFile, mobileFileOpened]);

  const handleContextMenu = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
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

  return (
    <div
      className={cn(
        'group relative flex flex-col items-center rounded-lg border transition-all cursor-pointer',
        'hover:bg-accent/50 hover:border-primary/30',
        isRowActive ? 'bg-accent/70 border-primary/50' : 'border-border bg-background',
        isDirectory && 'border-dashed'
      )}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
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
          <div className="relative h-20 w-20 sm:h-24 sm:w-24 md:h-28 md:w-28 overflow-hidden rounded-md bg-muted/30">
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
          <div className="flex h-20 w-20 sm:h-24 sm:w-24 md:h-28 md:w-28 items-center justify-center">
            {getFileIconComponent({ name: node.name, path: node.path, type: node.type, isExpanded: false, className: 'h-12 w-12 sm:h-14 sm:w-14 md:h-16 md:w-16' })}
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